import { BuiltInTools, CopilotClient, ToolSet, type PermissionRequest, type PermissionRequestResult, type SessionEvent } from "@github/copilot-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import type { Adapter, LiveSession } from "./types.js";
import { repositoryTool, repositoryRequestTool, validateRepository, validateResearchWorktree, type AccessIntent, type RepositoryGrant } from "./repository.js";
import { WebSearch } from "./web-search.js";
import { COPILOT_PROFILE, sessionModel, type ModelProfile } from "./providers.js";

function officeInstructions(workspace: string, search: WebSearch): string {
  return `This is a local experiment. Your initial scratch directory is ${workspace}. To create another office agent, the user clicks + at a desk; chat does not create office agents. For GitHub repository research, call research_attached_repository with the exact owner/repo in its repository argument; office-wide or persona read access may already be available without an attached assignment grant. If research reports no effective access, call request_repository_access with an owner/repo or short name hint, purpose and read/edit scope BEFORE saying the repository is unavailable. The user reviews its GitHub identity and approves an automatic clone of the remote default branch into an app-managed cache; local unpushed changes in other checkouts are not included. Never guess a local path or ask the user to run Git commands. Only after explicit read approval or existing office/persona read policy use research_attached_repository for tracked file research. An edit approval changes your current SDK working directory to an isolated Git worktree, NOT the original checkout; the scratch directory remains available for later recovery. Follow the current SDK working directory after such a change. Every shell/write still requires individual human permission. Do not claim filesystem isolation. Web search capability: ${search.capability.reason} ${search.capability.available ? "Use search_web for current public web information; cite source URLs and never claim a search succeeded on error. Never send secrets in queries." : "Do not claim to have searched the web; hosted search is not guaranteed for this model or provider."}`;
}

export class SdkAdapter implements Adapter {
  private client: CopilotClient | null = null;
  private starting: Promise<CopilotClient> | null = null;
  constructor(private readonly workspace: string, readonly search = new WebSearch({
    provider: process.env.AGENTCORP_SEARCH_PROVIDER, key: process.env.AGENTCORP_BRAVE_API_KEY
  })) {}
  private tools(): ToolSet {
    const tools = new ToolSet().addBuiltIn(BuiltInTools.Isolated).addBuiltIn(["bash", "view", "rg", "glob", "apply_patch"]);
    tools.addCustom("research_attached_repository").addCustom("request_repository_access");
    if (this.search.capability.available) tools.addCustom("search_web");
    return tools;
  }

  private customTools(repository?: RepositoryGrant, requestAccess?: (intent: AccessIntent) => Promise<string>,
    getGrant?: (fullName: string) => Promise<RepositoryGrant | undefined>) {
    const searchTool = this.search.tool();
    return [repositoryTool(getGrant ?? (async fullName => repository?.remote?.fullName === fullName ? repository : undefined)),
      repositoryRequestTool(requestAccess ?? (async () => { throw new Error("Repository requests are not available."); })),
      ...(searchTool ? [searchTool] : [])];
  }

  private async ready(): Promise<CopilotClient> {
    if (this.client) return this.client;
    if (!this.starting) this.starting = (async () => {
      const client = new CopilotClient({
        workingDirectory: this.workspace,
        baseDirectory: join(homedir(), ".copilot"),
        useLoggedInUser: true,
        logLevel: "none",
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

  async probe(profile: ModelProfile = COPILOT_PROFILE): Promise<void> {
    sessionModel(profile);
    if (profile.kind !== "copilot") {
      await this.ready();
      return;
    }
    const status = await (await this.ready()).getAuthStatus();
    if (!status.isAuthenticated) throw new Error(`GitHub Copilot CLI is not signed in. Run "copilot login" in your terminal, then click Retry connection. ${status.statusMessage ?? ""}`.trim());
  }
  async listModels(): Promise<{ id: string; name: string }[]> {
    await this.probe();
    return (await (await this.ready()).listModels()).map(({ id, name }) => ({ id, name }));
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
  async create(workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>, sessionId?: string, repository?: RepositoryGrant, requestAccess?: (intent: AccessIntent) => Promise<string>, getGrant?: (fullName: string) => Promise<RepositoryGrant | undefined>, profile: ModelProfile = COPILOT_PROFILE): Promise<LiveSession> {
    const model = sessionModel(profile);
    const client = await this.ready();
    if (repository) await validateRepository(repository.path);
    const session = await client.createSession({
      sessionId,
      ...model,
      streaming: true,
      workingDirectory: workspace,
      availableTools: this.tools(),
      tools: this.customTools(repository, requestAccess, getGrant),
      onPermissionRequest: permission,
      systemMessage: { mode: "append", content: officeInstructions(workspace, this.search) }
    });
    return this.wrap(session);
  }

  async resume(id: string, workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>, repository?: RepositoryGrant, requestAccess?: (intent: AccessIntent) => Promise<string>, getGrant?: (fullName: string) => Promise<RepositoryGrant | undefined>, profile: ModelProfile = COPILOT_PROFILE): Promise<LiveSession> {
    const model = sessionModel(profile);
    if (await realpath(workspace) !== workspace) throw new Error("Agent working directory is no longer the selected directory; refusing to resume.");
    if (repository && (await validateRepository(repository.path)).path !== repository.path) throw new Error("Repository grant no longer matches its original directory.");
    if (repository?.worktree) await validateResearchWorktree(repository);
    const client = await this.ready();
    const session = await client.resumeSession(id, {
      ...model,
      workingDirectory: repository?.worktree?.path ?? workspace,
      streaming: true,
      availableTools: this.tools(),
      tools: this.customTools(repository, requestAccess, getGrant),
      continuePendingWork: false,
      onPermissionRequest: permission,
      systemMessage: { mode: "append", content: officeInstructions(workspace, this.search) }
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
