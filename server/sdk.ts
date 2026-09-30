import { BuiltInTools, CopilotClient, ToolSet, type PermissionRequest, type PermissionRequestResult, type SessionEvent } from "@github/copilot-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import type { Adapter, LiveSession } from "./types.js";
import { repositoryTool, repositoryRequestTool, validateRepository, validateResearchWorktree, type AccessIntent, type RepositoryGrant } from "./repository.js";

function officeInstructions(workspace: string): string {
  return `This is a local experiment. Your initial scratch directory is ${workspace}. To create another office agent, the user clicks + at a desk; chat does not create office agents. For a local Git repo not already approved, call request_repository_access with a hint, purpose and read/edit scope. Only after the user's explicit approval use research_attached_repository for tracked file research. An edit approval changes your current SDK working directory to an isolated Git worktree, NOT the original checkout; the scratch directory remains available for later recovery. Follow the current SDK working directory after such a change. Every shell/write still requires individual human permission. Do not claim filesystem isolation.`;
}

export class SdkAdapter implements Adapter {
  private client: CopilotClient | null = null;
  private starting: Promise<CopilotClient> | null = null;
  constructor(private readonly workspace: string) {}
  private tools(): ToolSet {
    const tools = new ToolSet().addBuiltIn(BuiltInTools.Isolated).addBuiltIn(["bash", "view", "rg", "glob", "apply_patch"]);
    return tools.addCustom("research_attached_repository").addCustom("request_repository_access");
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
  async create(workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>, sessionId?: string, repository?: RepositoryGrant, requestAccess?: (intent: AccessIntent) => Promise<string>, getGrant?: () => RepositoryGrant | undefined): Promise<LiveSession> {
    const client = await this.ready();
    if (repository) await validateRepository(repository.path);
    const session = await client.createSession({
      sessionId,
      model: "auto",
      streaming: true,
      workingDirectory: workspace,
      availableTools: this.tools(),
      tools: [repositoryTool(getGrant ?? (() => repository)), repositoryRequestTool(requestAccess ?? (async () => { throw new Error("Repository requests are not available."); }))],
      onPermissionRequest: permission,
      systemMessage: { mode: "append", content: officeInstructions(workspace) }
    });
    return this.wrap(session);
  }

  async resume(id: string, workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>, repository?: RepositoryGrant, requestAccess?: (intent: AccessIntent) => Promise<string>, getGrant?: () => RepositoryGrant | undefined): Promise<LiveSession> {
    if (await realpath(workspace) !== workspace) throw new Error("Agent working directory is no longer the selected directory; refusing to resume.");
    if (repository && (await validateRepository(repository.path)).path !== repository.path) throw new Error("Repository grant no longer matches its original directory.");
    if (repository?.worktree) await validateResearchWorktree(repository);
    const client = await this.ready();
    const session = await client.resumeSession(id, {
      workingDirectory: repository?.worktree?.path ?? workspace,
      streaming: true,
      availableTools: this.tools(),
      tools: [repositoryTool(getGrant ?? (() => repository)), repositoryRequestTool(requestAccess ?? (async () => { throw new Error("Repository requests are not available."); }))],
      continuePendingWork: false,
      onPermissionRequest: permission,
      systemMessage: { mode: "append", content: officeInstructions(workspace) }
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
      abort: () => session.abort(),
      setWorkingDirectory: async path => { await session.rpc.metadata.setWorkingDirectory({ workingDirectory: path }); },
      getUsage: async () => {
        const metrics = await session.rpc.usage.getMetrics();
        if (!metrics.tokenDetails) throw new Error("SDK did not provide token counts for this session.");
        return { tokens: Object.values(metrics.tokenDetails).reduce((sum, detail) => sum + (detail?.tokenCount ?? 0), 0),
          calls: Object.values(metrics.modelMetrics).reduce((sum, model) => sum + (model?.requests.count ?? 0), 0),
          filesChanged: metrics.codeChanges.filesModifiedCount, startedAt: metrics.sessionStartTime };
      },
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
