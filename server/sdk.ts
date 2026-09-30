import { BuiltInTools, CopilotClient, ToolSet, type PermissionRequest, type PermissionRequestResult, type SessionEvent } from "@github/copilot-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import type { Adapter, LiveSession } from "./types.js";

export class SdkAdapter implements Adapter {
  private client: CopilotClient | null = null;
  private starting: Promise<CopilotClient> | null = null;
  constructor(private readonly workspace: string) {}
  private tools(): ToolSet {
    return new ToolSet().addBuiltIn(BuiltInTools.Isolated).addBuiltIn(["bash", "view", "rg", "glob", "apply_patch"]);
  }

  private async ready(): Promise<CopilotClient> {
    if (this.client) return this.client;
    if (!this.starting) this.starting = (async () => {
      const client = new CopilotClient({
        workingDirectory: this.workspace,
        baseDirectory: join(homedir(), ".copilot"),
        useLoggedInUser: true,
        mode: "empty"
      });
      try {
        await client.start();
        this.client = client;
        return client;
      } catch (error) {
        await client.stop().catch(() => []);
        throw error;
      }
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }

  async probe(): Promise<void> {
    const status = await (await this.ready()).getAuthStatus();
    if (!status.isAuthenticated) throw new Error(`GitHub Copilot CLI is not signed in. Run "copilot login" in your terminal, then click Retry connection. ${status.statusMessage ?? ""}`.trim());
  }
  async prepareWorkspace(root: string, agentId: string): Promise<string> {
    const parent = join(root, "agents");
    await mkdir(parent, { recursive: true });
    if (await realpath(parent) !== parent) throw new Error("Agent folder parent must not be a symlink.");
    const folder = join(parent, agentId);
    await mkdir(folder);
    await writeFile(join(folder, ".deskbound-workspace"), "AgentCorp dedicated agent working directory\n", { flag: "wx" });
    return folder;
  }
  async create(workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>, sessionId?: string): Promise<LiveSession> {
    const client = await this.ready();
    const session = await client.createSession({
      sessionId,
      model: "auto",
      streaming: true,
      workingDirectory: workspace,
      availableTools: this.tools(),
      onPermissionRequest: permission,
      systemMessage: { mode: "append", content: `This is a local experiment. Work only inside ${workspace}. Ask before interacting with paths outside this directory.` }
    });
    return this.wrap(session);
  }

  async resume(id: string, workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>): Promise<LiveSession> {
    if (await realpath(workspace) !== workspace) throw new Error("Agent working directory is no longer the selected directory; refusing to resume.");
    const client = await this.ready();
    const session = await client.resumeSession(id, {
      workingDirectory: workspace,
      streaming: true,
      availableTools: this.tools(),
      continuePendingWork: false,
      onPermissionRequest: permission
    });
    return this.wrap(session);
  }

  async deleteSession(id: string): Promise<void> {
    await (await this.ready()).deleteSession(id);
  }

  private wrap(session: Awaited<ReturnType<CopilotClient["createSession"]>>): LiveSession {
    return {
      sessionId: session.sessionId,
      send: async (prompt: string) => { await session.send({ prompt }); },
      onEvent: (handler: (event: SessionEvent) => void) => session.on(handler),
      disconnect: () => session.disconnect()
    };
  }

  async stop(): Promise<void> {
    if (this.client) {
      const client = this.client;
      this.client = null;
      const errors = await client.stop();
      if (errors.length) throw new AggregateError(errors, "SDK shutdown reported errors");
    }
  }
}
