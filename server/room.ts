import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import { MAX_AGENTS, type Adapter, type Agent, type LiveSession, type Review, type Room, type RepositoryRequest } from "./types.js";
import type { Store } from "./storage.js";
import { createResearchWorktree, validateRepository, type AccessIntent, type RepositoryGrant } from "./repository.js";
import { agentName } from "../agent-inc-live/src/room.js";

const EXPIRE_MS = 90_000;
type Pending = { agentId: string; resolve: (decision: PermissionRequestResult) => void; timer: NodeJS.Timeout };
type PendingAccess = { agentId: string; resolve: (result: string) => void; timer: NodeJS.Timeout };

export class RoomController {
  readonly state: Room;
  private sessions = new Map<string, LiveSession>();
  private unsubscribers = new Map<string, () => void>();
  private listeners = new Set<(room: Room) => void>();
  private pending = new Map<string, Pending>();
  private access = new Map<string, PendingAccess>();
  private saving: Promise<void> = Promise.resolve();
  private connecting: Promise<void> | null = null;
  private creating = new Set<number>();
  private lifecycle = new Set<string>();
  private stopped = new Set<string>();
  private armedTaskGrants = new Set<string>();

  private constructor(private readonly adapter: Adapter, private readonly store: Store, state: Room, private readonly worktreeRoot: string) {
    this.state = state;
  }

  static async open(adapter: Adapter, store: Store, workspace: string, worktreeRoot = resolve(".local/worktrees")): Promise<RoomController> {
    const saved = await store.read();
    if (saved && saved.workspace !== workspace) throw new Error(`Saved sessions belong to ${saved.workspace}. Choose that workspace or move .local/state.json aside deliberately.`);
    if (saved && !("agents" in saved) && !("agent" in saved)) throw new Error("Unrecognized saved room format; state was not changed.");
    const now = Date.now();
    const state: Room = saved
      ? "agents" in saved
        ? saved
        : { agents: saved.agent ? [{ ...saved.agent, deskIndex: 0, archived: false, workspace, workspaceKind: "root", createdAt: now, updatedAt: now }] : [], error: saved.error, connected: saved.connected, workspace, revision: saved.revision }
      : { agents: [], error: null, connected: false, workspace, revision: 0 };
    if (Array.isArray(state.agents)) {
      for (const agent of state.agents) agent.archived ??= false;
    }
    if (!Array.isArray(state.agents) || state.agents.filter(agent => !agent.archived).length > MAX_AGENTS ||
      state.agents.some((agent, index) => !agent.id || !agent.sessionId || !agent.workspace ||
        !(agent.workspaceKind === "root" && agent.workspace === workspace ||
          agent.workspaceKind === "scratch" && /^[0-9a-f-]{36}$/.test(agent.id) &&
          agent.workspace === join(workspace, "agents", agent.id)) ||
        (agent.archived ? agent.deskIndex !== null :
          !Number.isInteger(agent.deskIndex) || agent.deskIndex === null ||
          agent.deskIndex < 0 || agent.deskIndex >= MAX_AGENTS) ||
        (agent.lastDeskIndex !== undefined && (!Number.isInteger(agent.lastDeskIndex) ||
          agent.lastDeskIndex < 0 || agent.lastDeskIndex >= MAX_AGENTS)) ||
        state.agents.findIndex(other => other.id === agent.id || other.sessionId === agent.sessionId ||
          !agent.archived && !other.archived && other.deskIndex === agent.deskIndex) !== index)) {
      throw new Error("Saved agent roster is invalid; state was not changed.");
    }
    const room = new RoomController(adapter, store, state, worktreeRoot);
    room.state.connected = false;
    room.state.error = null;
    if (room.state.usage) room.state.usage.stale = true;
    room.state.knownRepositories ??= [];
    room.state.worktrees ??= [];
    const used = new Set<number>();
    const names = new Set<string>();
    for (const agent of [...room.state.agents].sort((a, b) => Number(a.archived) - Number(b.archived) || (a.deskIndex ?? a.lastDeskIndex ?? 0) - (b.deskIndex ?? b.lastDeskIndex ?? 0))) {
      if (agent.persona === undefined) agent.persona = Array.from({ length: MAX_AGENTS }, (_, i) => i).find(i => !used.has(i)) ?? (agent.lastDeskIndex ?? 0);
      if (!Number.isInteger(agent.persona) || agent.persona < 0 || agent.persona >= MAX_AGENTS ||
        (!agent.archived && used.has(agent.persona))) throw new Error("Saved sprite personas collide or are invalid; state was not changed.");
      if (!agent.archived) used.add(agent.persona);
      let name = agent.name ?? agentName(agent.sessionId);
      if (!agent.name) for (let suffix = 2; names.has(name); suffix++) name = `${agentName(agent.sessionId)} ${suffix}`;
      if (names.has(name)) throw new Error("Saved agent names collide; state was not changed.");
      agent.name = name;
      names.add(name);
      agent.accessRequest = undefined;
      if (agent.repository?.scope === "task") agent.repository = undefined;
      if (agent.repository && !room.state.knownRepositories.includes(agent.repository.path)) room.state.knownRepositories.push(agent.repository.path);
    }
    for (const agent of room.state.agents) {
      agent.review = undefined;
      if (agent.archived) continue;
      if (["thinking", "working", "permission"].includes(agent.phase)) {
        agent.phase = "interrupted";
        agent.activity = "Turn interrupted by restart";
        const draft = [...agent.messages].reverse().find(message => message.role === "assistant" && message.pending);
        if (draft) draft.pending = false;
      }
    }
    await room.publish();
    return room;
  }

  subscribe(listener: (room: Room) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.denyPending();
    };
  }

  private async publish(): Promise<void> {
    this.state.revision++;
    const snapshot = structuredClone(this.state);
    this.saving = this.saving.then(() => this.store.write(snapshot));
    for (const listener of this.listeners) listener(snapshot);
    await this.saving;
  }

  private report(error: unknown, agent?: Agent): void {
    const message = error instanceof Error ? error.message : String(error);
    if (agent) {
      agent.phase = "error";
      agent.activity = message;
      agent.updatedAt = Date.now();
    } else {
      this.state.error = message;
    }
    void this.publish().catch(cause => console.error("Cannot save room:", cause));
  }

  connect(): Promise<void> {
    if (!this.connecting) {
      this.connecting = this.connectSessions().finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  private async connectSessions(): Promise<void> {
    try {
      await this.adapter.probe();
      this.state.connected = true;
      this.state.error = null;
    } catch (error) {
      this.state.connected = false;
      this.report(error);
      throw error;
    }
    for (const agent of this.state.agents) {
      if (agent.archived) continue;
      if (this.sessions.has(agent.id) && agent.phase !== "error") continue;
      try {
        if (this.sessions.has(agent.id)) {
          this.unsubscribers.get(agent.id)?.();
          await this.sessions.get(agent.id)!.disconnect();
          this.sessions.delete(agent.id);
          this.unsubscribers.delete(agent.id);
        }
        const session = await this.resumeAgent(agent);
        this.attach(agent.id, session);
        if (agent.phase === "error") {
          agent.phase = "idle";
          if (agent.activity !== "Empty session restored; no messages lost") agent.activity = "Ready to chat";
        }
      } catch (error) {
        this.report(error, agent);
      }
    }
    await this.publish();
  }

  private async resumeAgent(agent: Agent, repository: RepositoryGrant | null = agent.repository ?? null): Promise<LiveSession> {
    const grant = repository ?? undefined;
    try {
      const session = await this.adapter.resume(agent.sessionId, agent.workspace, request => this.permission(agent.id, request), grant,
        intent => this.requestAccess(agent.id, intent), () => this.agent(agent.id).repository);
      if (session.sessionId !== agent.sessionId) {
        await session.disconnect();
        throw new Error("SDK resumed a different session identity; repository access was not changed.");
      }
      return session;
    } catch (error) {
      if (agent.messages.length !== 0 || !(error instanceof Error) ||
        !error.message.includes(`Session not found: ${agent.sessionId}`)) throw error;
      const session = await this.adapter.create(agent.workspace, request => this.permission(agent.id, request), agent.sessionId, grant,
        intent => this.requestAccess(agent.id, intent), () => this.agent(agent.id).repository);
      if (session.sessionId !== agent.sessionId) {
        await session.disconnect();
        throw new Error("SDK returned a different identity for the empty-session recovery.");
      }
      agent.activity = "Empty session restored; no messages lost";
      return session;
    }
  }

  private availableDesk(preferred?: number): number | null {
    const occupied = new Set(this.state.agents.filter(agent => !agent.archived).map(agent => agent.deskIndex));
    for (const reserved of this.creating) occupied.add(reserved);
    if (preferred !== undefined && !occupied.has(preferred)) return preferred;
    return Array.from({ length: MAX_AGENTS }, (_, index) => index).find(index => !occupied.has(index)) ?? null;
  }

  async create(deskIndex: number): Promise<Agent> {
    if (!Number.isInteger(deskIndex) || deskIndex < 0 || deskIndex >= MAX_AGENTS) throw new Error("Invalid desk.");
    if (this.state.agents.filter(agent => !agent.archived).length + this.creating.size >= MAX_AGENTS) throw new Error("All office desks are occupied.");
    if (this.availableDesk(deskIndex) !== deskIndex) throw new Error("This desk is already occupied.");
    this.creating.add(deskIndex);
    const id = randomUUID();
    try {
      const workspace = await this.adapter.prepareWorkspace(this.state.workspace, id);
      const session = await this.adapter.create(workspace, request => this.permission(id, request), undefined, undefined,
        intent => this.requestAccess(id, intent), () => this.agent(id).repository);
      if (this.state.agents.some(agent => agent.sessionId === session.sessionId)) {
        throw new Error("SDK returned a session identity already assigned to another agent.");
      }
      const now = Date.now();
      const occupied = new Set(this.state.agents.map(item => item.persona));
      const all = Array.from({ length: MAX_AGENTS }, (_, index) => index);
      const choices = all.filter(index => !occupied.has(index));
      if (!choices.length) {
        const active = new Set(this.state.agents.filter(item => !item.archived).map(item => item.persona));
        choices.push(...all.filter(index => !active.has(index)));
      }
      const persona = choices[Math.floor(Math.random() * choices.length)];
      const original = agentName(session.sessionId);
      let name = original;
      for (let suffix = 2; this.state.agents.some(item => item.name === name); suffix++) name = `${original} ${suffix}`;
      const agent: Agent = { id, deskIndex, archived: false, workspace, workspaceKind: "scratch", createdAt: now, updatedAt: now, sessionId: session.sessionId, persona, name,
        phase: "idle", activity: "Ready to chat", messages: [] };
      this.state.agents.push(agent);
      if (this.state.usage) this.state.usage.stale = true;
      this.attach(id, session);
      this.state.connected = true;
      this.state.error = null;
      await this.publish();
      return agent;
    } finally {
      this.creating.delete(deskIndex);
    }
  }

  private attach(agentId: string, session: LiveSession): void {
    this.sessions.set(agentId, session);
    this.unsubscribers.set(agentId, session.onEvent(event => {
      try { this.event(agentId, event); } catch (error) { this.report(error, this.agent(agentId)); }
    }));
  }

  private agent(agentId: string): Agent {
    const agent = this.state.agents.find(item => item.id === agentId);
    if (!agent) throw new Error("Unknown agent.");
    return agent;
  }

  private availableForLifecycle(agent: Agent): void {
    if (this.lifecycle.has(agent.id)) throw new Error("This agent is already being archived, restored or sent home.");
    if (agent.review || agent.accessRequest || ["thinking", "working", "permission"].includes(agent.phase)) {
      throw new Error("Wait for the turn to finish or decide the pending permission before changing this agent.");
    }
  }

  async archive(agentId: string): Promise<void> {
    const agent = this.agent(agentId);
    if (agent.archived) throw new Error("This agent is already archived.");
    this.availableForLifecycle(agent);
    this.lifecycle.add(agentId);
    try {
      await this.sessions.get(agentId)?.disconnect();
      this.unsubscribers.get(agentId)?.();
      this.unsubscribers.delete(agentId);
      this.sessions.delete(agentId);
      agent.lastDeskIndex = agent.deskIndex!;
      agent.deskIndex = null;
      agent.archived = true;
      agent.archivedAt = Date.now();
      agent.activity = "Archived; conversation and SDK session preserved";
      agent.updatedAt = Date.now();
      if (this.state.usage) this.state.usage.stale = true;
      await this.publish();
    } finally {
      this.lifecycle.delete(agentId);
    }
  }

  async restore(agentId: string): Promise<void> {
    const agent = this.agent(agentId);
    if (!agent.archived) throw new Error("This agent is already in the office.");
    this.availableForLifecycle(agent);
    if (this.availableDesk(agent.lastDeskIndex) === null) throw new Error("Office full (16 desks). Archive an agent before restoring this one.");
    if (this.state.agents.some(other => !other.archived && other.persona === agent.persona)) {
      throw new Error("This agent's sprite persona is in use by another office agent. Archive that agent before restoring; identity was not changed.");
    }
    this.lifecycle.add(agentId);
    try {
      const session = await this.resumeAgent(agent);
      const deskIndex = this.availableDesk(agent.lastDeskIndex);
      if (deskIndex === null) {
        await session.disconnect();
        throw new Error("Office full (16 desks). Archive an agent before restoring this one.");
      }
      agent.deskIndex = deskIndex;
      agent.archived = false;
      agent.archivedAt = undefined;
      agent.phase = "idle";
      agent.activity = "Ready to chat";
      agent.updatedAt = Date.now();
      if (this.state.usage) this.state.usage.stale = true;
      this.attach(agentId, session);
      await this.publish();
    } finally {
      this.lifecycle.delete(agentId);
    }
  }

  async sendHome(agentId: string): Promise<void> {
    const agent = this.agent(agentId);
    this.availableForLifecycle(agent);
    this.lifecycle.add(agentId);
    try {
      await this.sessions.get(agentId)?.disconnect();
      this.unsubscribers.get(agentId)?.();
      this.unsubscribers.delete(agentId);
      this.sessions.delete(agentId);
      try {
        await this.adapter.deleteSession(agent.sessionId);
      } catch (error) {
        this.report(error, agent);
        throw error;
      }
      this.state.agents.splice(this.state.agents.indexOf(agent), 1);
      if (this.state.usage) this.state.usage.stale = true;
      await this.publish();
    } finally {
      this.lifecycle.delete(agentId);
    }
  }

  requestAccess(agentId: string, intent: AccessIntent): Promise<string> {
    const agent = this.agent(agentId);
    if (agent.archived || !this.listeners.size || agent.accessRequest || agent.review || this.lifecycle.has(agentId)) {
      return Promise.resolve(JSON.stringify({ status: "denied", reason: "No available browser or another request is pending." }));
    }
    const id = randomUUID();
    agent.accessRequest = { id, repoHint: intent.repoHint.slice(0, 150), purpose: intent.purpose.slice(0, 500), scope: intent.scope };
    agent.phase = "permission";
    agent.activity = "Waiting for repository access decision";
    agent.updatedAt = Date.now();
    void this.publish().catch(error => console.error("Cannot save access request:", error));
    return new Promise(resolveResult => {
      const timer = setTimeout(() => this.resolveAccess(agentId, id, "denied", "Repository request timed out."), EXPIRE_MS);
      this.access.set(id, { agentId, resolve: resolveResult, timer });
    });
  }

  guidedAccess(agentId: string): RepositoryRequest {
    const agent = this.agent(agentId);
    if (agent.archived || agent.accessRequest || agent.review || this.lifecycle.has(agentId) || !this.listeners.size ||
      ["thinking", "working", "permission"].includes(agent.phase)) {
      throw new Error("This agent cannot request repository access right now.");
    }
    const request: RepositoryRequest = { id: randomUUID(), repoHint: "", purpose: "Research or work on a local repository", scope: "edit" };
    agent.accessRequest = request;
    void this.publish().catch(error => console.error("Cannot save guided request:", error));
    return request;
  }

  private resolveAccess(agentId: string, id: string, status: string, reason?: string, grant?: RepositoryGrant): void {
    const agent = this.agent(agentId);
    if (agent.accessRequest?.id !== id) throw new Error("Repository request is stale or belongs to another agent.");
    const pending = this.access.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.access.delete(id);
      pending.resolve(JSON.stringify({ status, reason, repository: grant?.name, scope: grant?.scope,
        worktree: grant?.worktree?.path }));
    }
    agent.accessRequest = undefined;
    agent.updatedAt = Date.now();
    if (agent.phase === "permission") agent.phase = "thinking";
    agent.activity = status === "approved" ? `Repository access: ${grant?.name}` : reason ?? "Repository access denied";
    void this.publish().catch(error => console.error("Cannot save access decision:", error));
  }

  async decideAccess(agentId: string, id: string, choice: "deny" | "task" | "session" | "edit", path?: string): Promise<void> {
    const agent = this.agent(agentId);
    const request = agent.accessRequest;
    if (!request || request.id !== id || this.lifecycle.has(agentId)) throw new Error("Repository request is stale or belongs to another agent.");
    if (choice === "deny") {
      this.resolveAccess(agentId, id, "denied", "User denied repository access.");
      return;
    }
    if (!path) throw new Error("Choose an absolute local Git repository root.");
    if (choice === "edit" && request.scope !== "edit") throw new Error("This agent requested read access, not edit access.");
    const grant = await validateRepository(path);
    const session = this.sessions.get(agentId);
    if (!session || agent.archived) throw new Error("This agent must be connected before access can be granted.");
    this.lifecycle.add(agentId);
    try {
      let next: RepositoryGrant = { ...grant, scope: choice === "task" ? "task" : "session" };
      if (choice === "edit") {
        next = await createResearchWorktree(this.worktreeRoot, grant, agentId);
        this.state.worktrees!.push({ agentId, repository: grant.path, path: next.worktree!.path, branch: next.worktree!.branch });
        await this.publish();
        try {
          await session.setWorkingDirectory(next.worktree!.path);
        } catch (error) {
          throw new Error(`Created worktree at ${next.worktree!.path} (branch ${next.worktree!.branch}), but SDK could not change this session's working directory. Worktree preserved for manual inspection. ${String(error)}`);
        }
      } else if (agent.repository?.worktree) {
        await session.setWorkingDirectory(agent.workspace);
      }
      agent.repository = next;
      if (choice === "task" && agent.phase === "idle") this.armedTaskGrants.add(agentId);
      else this.armedTaskGrants.delete(agentId);
      if (!this.state.knownRepositories!.includes(grant.path)) this.state.knownRepositories!.push(grant.path);
      await this.publish();
      this.resolveAccess(agentId, id, "approved", undefined, next);
    } finally {
      this.lifecycle.delete(agentId);
    }
  }

  async revokeRepository(agentId: string): Promise<void> {
    const agent = this.agent(agentId);
    this.availableForLifecycle(agent);
    this.lifecycle.add(agentId);
    try {
      if (agent.repository?.worktree && !agent.archived) {
        const session = this.sessions.get(agentId);
        if (!session) throw new Error("SDK session unavailable; could not leave the worktree.");
        await session.setWorkingDirectory(agent.workspace);
      }
      const preserved = agent.repository?.worktree?.path;
      agent.repository = undefined;
      this.armedTaskGrants.delete(agentId);
      agent.activity = preserved ? `Access revoked; worktree preserved at ${preserved}` : "Repository access revoked";
      await this.publish();
    } finally {
      this.lifecycle.delete(agentId);
    }
  }

  async refreshUsage(): Promise<void> {
    if (!this.state.connected) throw new Error("Connect to the SDK before loading usage.");
    let tokens = 0, calls = 0, filesChanged = 0, measured = 0;
    let startedAt: string | undefined;
    for (const agent of this.state.agents) {
      let temporary: LiveSession | undefined;
      try {
        if (agent.archived) temporary = await this.resumeAgent(agent);
        const metrics = await (temporary ?? this.sessions.get(agent.id))?.getUsage();
        if (!metrics) continue;
        measured++;
        tokens += metrics.tokens;
        calls += metrics.calls;
        filesChanged += metrics.filesChanged;
        if (!startedAt || metrics.startedAt < startedAt) startedAt = metrics.startedAt;
      } catch (error) {
        console.error(`Usage unavailable for agent ${agent.id}:`, error);
      } finally {
        if (temporary) await temporary.disconnect();
      }
    }
    const total = this.state.agents.length;
    this.state.usage = { status: measured === 0 ? "unavailable" : measured === total ? "ready" : "partial",
      measured, total, tokens, calls, filesChanged, startedAt, updatedAt: Date.now() };
    await this.publish();
  }

  async setRepository(agentId: string, path: string | null): Promise<void> {
    const agent = this.agent(agentId);
    this.availableForLifecycle(agent);
    this.lifecycle.add(agentId);
    try {
      const repository: RepositoryGrant | undefined = path === null ? undefined : await validateRepository(path);
      if (repository?.path === agent.repository?.path) return;
      if (agent.archived) {
        agent.repository = repository;
      } else {
        const current = this.sessions.get(agentId);
        if (!current) throw new Error("Agent unavailable. Retry its SDK connection before changing repository access.");
        await current.disconnect();
        this.unsubscribers.get(agentId)?.();
        this.sessions.delete(agentId);
        this.unsubscribers.delete(agentId);
        try {
          this.attach(agentId, await this.resumeAgent(agent, repository ?? null));
        } catch (error) {
          try { this.attach(agentId, await this.resumeAgent(agent)); }
          catch (restoreError) { this.report(restoreError, agent); }
          throw error;
        }
        agent.repository = repository;
      }
      agent.updatedAt = Date.now();
      agent.activity = repository ? `Research access: ${repository.name} (tracked files only)` : "Repository research access revoked";
      await this.publish();
    } finally {
      this.lifecycle.delete(agentId);
    }
  }

  async stop(agentId: string): Promise<void> {
    const agent = this.agent(agentId);
    if (agent.archived || this.lifecycle.has(agentId) || !["thinking", "working", "permission"].includes(agent.phase)) {
      throw new Error("No active turn to stop for this agent.");
    }
    const session = this.sessions.get(agentId);
    if (!session) throw new Error("Agent SDK session is unavailable; cannot confirm cancellation.");
    this.lifecycle.add(agentId);
    try {
      const abort = session.abort();
      for (const [id, pending] of this.pending) {
        if (pending.agentId !== agentId) continue;
        clearTimeout(pending.timer);
        pending.resolve({ kind: "reject", feedback: "Turn stopped by user." });
        this.pending.delete(id);
      }
      if (agent.accessRequest) this.resolveAccess(agentId, agent.accessRequest.id, "denied", "Turn stopped by user.");
      if (agent.repository?.scope === "task") agent.repository = undefined;
      this.armedTaskGrants.delete(agentId);
      await abort;
      agent.review = undefined;
      const last = agent.messages.at(-1);
      if (last?.pending) last.pending = false;
      this.stopped.add(agentId);
      agent.phase = "idle";
      agent.activity = "Turn stopped by user · ready to chat";
      agent.messages.push({ id: randomUUID(), role: "system", content: "Turn stopped by user." });
      agent.updatedAt = Date.now();
      await this.publish();
    } catch (error) {
      this.report(error, agent);
      throw error;
    } finally {
      this.lifecycle.delete(agentId);
    }
  }

  async send(agentId: string, text: string): Promise<void> {
    const agent = this.agent(agentId);
    if (agent.archived || this.lifecycle.has(agentId)) throw new Error("This agent is not active in the office.");
    const session = this.sessions.get(agentId);
    if (!session) throw new Error("Session unavailable. Retry connection before sending.");
    const prompt = text.trim();
    if (!prompt || prompt.length > 12000) throw new Error("Prompt must contain 1–12000 characters.");
    if (["thinking", "working", "permission"].includes(agent.phase)) throw new Error("Wait for the current turn to finish.");
    this.stopped.delete(agentId);
    this.armedTaskGrants.delete(agentId);
    agent.messages.push({ id: randomUUID(), role: "user", content: prompt });
    if (this.state.usage) this.state.usage.stale = true;
    agent.phase = "thinking";
    agent.activity = "Thinking";
    agent.updatedAt = Date.now();
    await this.publish();
    try {
      await session.send(prompt);
    } catch (error) {
      agent.activity = "Message was not sent";
      this.report(error, agent);
      throw error;
    }
  }

  private event(agentId: string, event: SessionEvent): void {
    const agent = this.agent(agentId);
    if (agent.archived) return;
    if (this.stopped.has(agentId) && event.type !== "session.error" && event.type !== "session.idle") return;
    switch (event.type) {
      case "assistant.message_delta": {
        const delta = event.data.deltaContent;
        if (!delta) break;
        let draft = agent.messages.at(-1);
        if (!draft || draft.role !== "assistant" || !draft.pending) {
          draft = { id: randomUUID(), role: "assistant", content: "", pending: true };
          agent.messages.push(draft);
        }
        draft.content += delta;
        agent.phase = "thinking";
        agent.activity = "Speaking";
        break;
      }
      case "assistant.message": {
        const last = agent.messages.at(-1);
        if (last?.role === "assistant" && last.pending) {
          last.content = event.data.content;
          last.pending = false;
        } else if (event.data.content) {
          agent.messages.push({ id: randomUUID(), role: "assistant", content: event.data.content });
        }
        break;
      }
      case "tool.execution_start":
        agent.phase = "working";
        agent.activity = `Using ${event.data.toolName || "a tool"}`;
        break;
      case "tool.execution_complete":
        agent.phase = "thinking";
        agent.activity = event.data.error ? "Tool finished with an error" : "Tool finished";
        break;
      case "session.idle":
        if (agent.repository?.scope === "task" && !this.armedTaskGrants.has(agentId)) agent.repository = undefined;
        agent.phase = "idle";
        agent.activity = this.stopped.has(agentId) ? "Turn stopped by user · ready to chat" : "Ready to chat";
        break;
      case "session.error":
        agent.phase = "error";
        agent.activity = event.data.message || "SDK session error";
        break;
      default:
        return;
    }
    agent.updatedAt = Date.now();
    void this.publish().catch(error => console.error("Cannot save SDK event:", error));
  }

  private permission(agentId: string, request: PermissionRequest): Promise<PermissionRequestResult> {
    const agent = this.state.agents.find(item => item.id === agentId);
    if (request.kind === "custom-tool" && request.toolName === "research_attached_repository") {
      return Promise.resolve(agent?.repository && !agent.archived && !this.lifecycle.has(agentId) ?
        { kind: "approve-once" } : { kind: "reject", feedback: "No active repository research grant." });
    }
    if (request.kind === "custom-tool" && request.toolName === "request_repository_access") {
      return Promise.resolve(agent && !agent.archived && !this.lifecycle.has(agentId) ? { kind: "approve-once" } :
        { kind: "reject", feedback: "Agent unavailable." });
    }
    if (!this.listeners.size || !agent || agent.archived || this.lifecycle.has(agentId) || agent.review) {
      return Promise.resolve({ kind: "user-not-available" });
    }
    const id = randomUUID();
    const review: Review = {
      id,
      kind: request.kind,
      tool: "toolName" in request ? String(request.toolName) : request.kind,
      detail: JSON.stringify(request, null, 2)
    };
    agent.review = review;
    agent.phase = "permission";
    agent.activity = "Waiting for your decision";
    agent.updatedAt = Date.now();
    void this.publish().catch(error => console.error("Cannot save permission request:", error));
    return new Promise(resolve => {
      const timer = setTimeout(() => this.decide(agentId, id, false, true), EXPIRE_MS);
      this.pending.set(id, { agentId, resolve, timer });
    });
  }

  decide(agentId: string, id: string, allow: boolean, expired = false): void {
    const pending = this.pending.get(id);
    const agent = this.state.agents.find(item => item.id === agentId);
    if (!pending || pending.agentId !== agentId || agent?.review?.id !== id) throw new Error("Permission request is stale or belongs to another agent.");
    clearTimeout(pending.timer);
    this.pending.delete(id);
    agent.review = undefined;
    agent.phase = "thinking";
    agent.activity = allow ? "Approved once; waiting for tool" : expired ? "Permission timed out" : "Tool denied";
    agent.updatedAt = Date.now();
    void this.publish().catch(error => console.error("Cannot save permission decision:", error));
    pending.resolve(allow ? { kind: "approve-once" } : { kind: "reject", feedback: expired ? "No human decision before timeout." : "User denied this action." });
  }

  private denyPending(): void {
    for (const [id, pending] of this.access) {
      this.resolveAccess(pending.agentId, id, "denied", "No browser available; request denied.");
    }
    if (!this.pending.size) return;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ kind: "user-not-available" });
      this.pending.delete(id);
      const agent = this.agent(pending.agentId);
      agent.review = undefined;
      agent.phase = "interrupted";
      agent.activity = "No browser available; tool denied";
      agent.updatedAt = Date.now();
    }
    void this.publish().catch(error => console.error("Cannot save permission disconnect:", error));
  }

  async close(): Promise<void> {
    this.denyPending();
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    try {
      const results = await Promise.allSettled([...this.sessions.values()].map(session => session.disconnect()));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } finally {
      await this.adapter.stop();
      await this.saving;
    }
  }
}
