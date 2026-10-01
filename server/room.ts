import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import { MAX_AGENTS, type Adapter, type Agent, type AgentPersona, type LiveSession, type Review, type Room, type RepositoryRequest } from "./types.js";
import type { Store } from "./storage.js";
import { createResearchWorktree, validateRepository, type AccessIntent, type RepositoryGrant } from "./repository.js";
import { uniqueAgentName } from "../agent-inc-live/src/room.js";
import { CACHE_AGE_MS, type RemoteRepository, type RepositorySnapshot, type RepositorySource } from "./github-repositories.js";

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
  private clones = new Map<string, AbortController>();

  private constructor(private readonly adapter: Adapter, private readonly store: Store, state: Room,
    private readonly worktreeRoot: string, private readonly repositories?: RepositorySource) {
    this.state = state;
  }

  static async open(adapter: Adapter, store: Store, workspace: string, worktreeRoot = resolve(".local/worktrees"),
    repositories?: RepositorySource): Promise<RoomController> {
    const saved = await store.read();
    if (saved && saved.workspace !== workspace) throw new Error(`Saved sessions belong to ${saved.workspace}. Choose that workspace or move .local/state.json aside deliberately.`);
    if (saved && !("agents" in saved) && !("agent" in saved)) throw new Error("Unrecognized saved room format; state was not changed.");
    if (saved && "schemaVersion" in saved && saved.schemaVersion !== undefined && saved.schemaVersion !== 2) {
      throw new Error("Unknown state schema; state was not changed.");
    }
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
          (agent.workspace === join(workspace, "agents", agent.id) ||
            !!agent.assignmentId && /^[0-9a-f-]{36}$/.test(agent.assignmentId) &&
            agent.workspace === join(workspace, "agents", agent.assignmentId))) ||
        (agent.archived ? agent.deskIndex !== null :
          !Number.isInteger(agent.deskIndex) || agent.deskIndex === null ||
          agent.deskIndex < 0 || agent.deskIndex >= MAX_AGENTS) ||
        (agent.lastDeskIndex !== undefined && (!Number.isInteger(agent.lastDeskIndex) ||
          agent.lastDeskIndex < 0 || agent.lastDeskIndex >= MAX_AGENTS)) ||
        state.agents.findIndex(other => other.id === agent.id || other.sessionId === agent.sessionId ||
          !agent.archived && !other.archived && other.deskIndex === agent.deskIndex) !== index)) {
      throw new Error("Saved agent roster is invalid; state was not changed.");
    }
    const room = new RoomController(adapter, store, state, worktreeRoot, repositories);
    room.state.connected = false;
    room.state.error = null;
    if (room.state.usage) room.state.usage.stale = true;
    room.state.knownRepositories ??= [];
    room.state.worktrees ??= [];
    room.state.snapshots ??= [];
    const used = new Set<number>();
    const names = new Set(room.state.agents.map(agent => agent.name).filter((name): name is string => !!name));
    const assigned = new Set<string>();
    for (const agent of [...room.state.agents].sort((a, b) => Number(a.archived) - Number(b.archived) || (a.deskIndex ?? a.lastDeskIndex ?? 0) - (b.deskIndex ?? b.lastDeskIndex ?? 0))) {
      if (agent.persona === undefined) agent.persona = Array.from({ length: MAX_AGENTS }, (_, i) => i).find(i => !used.has(i)) ?? (agent.lastDeskIndex ?? 0);
      if (!Number.isInteger(agent.persona) || agent.persona < 0 || agent.persona >= MAX_AGENTS ||
        (!agent.archived && used.has(agent.persona))) throw new Error("Saved sprite personas collide or are invalid; state was not changed.");
      if (!agent.archived) used.add(agent.persona);
      if (state.schemaVersion === 2 && agent.name && assigned.has(agent.name)) {
        throw new Error("Saved agent names collide; state was not changed.");
      }
      const name = agent.name && !assigned.has(agent.name) ? agent.name : uniqueAgentName(agent.sessionId, names);
      agent.name = name;
      names.add(name);
      assigned.add(name);
      if (agent.accessRequest && agent.phase === "idle") {
        agent.accessRequest = { ...agent.accessRequest, status: "error", candidates: undefined, progress: undefined,
          purpose: agent.accessRequest.purpose === "Research or work on a local repository" ?
            "Research or edit a GitHub repository" : agent.accessRequest.purpose,
          error: "Recheck the GitHub owner/repo after restart; no clone has started." };
      } else {
        agent.accessRequest = undefined;
      }
      if (agent.repository?.scope === "task") agent.repository = undefined;
      if (agent.repository && !room.state.knownRepositories.includes(agent.repository.path)) room.state.knownRepositories.push(agent.repository.path);
    }
    if (state.schemaVersion === 2) {
      if (!Array.isArray(state.personas) || !Array.isArray(state.assignments)) {
        throw new Error("Saved persona roster is invalid; state was not changed.");
      }
      const ids = new Set<string>();
      const names = new Set<string>();
      for (const persona of state.personas) {
        if (!persona?.id || ids.has(persona.id) || !persona.name?.trim() ||
          names.has(persona.name.trim().toLocaleLowerCase()) ||
          !Number.isInteger(persona.artId) || persona.artId < 0 || persona.artId >= MAX_AGENTS ||
          !persona.profile || !Array.isArray(persona.profile.specialties) || !Array.isArray(persona.memories)) {
          throw new Error("Saved persona roster is invalid; state was not changed.");
        }
        ids.add(persona.id);
        names.add(persona.name.trim().toLocaleLowerCase());
      }
      const assignmentIds = new Set<string>();
      const sdkIds = new Set<string>();
      for (const assignment of state.assignments) {
        if (!assignment?.id || assignmentIds.has(assignment.id) || !ids.has(assignment.personaId) ||
          !assignment.sessionId || sdkIds.has(assignment.sessionId) || !Array.isArray(assignment.messages) ||
          !["active", "completed", "interrupted"].includes(assignment.status)) {
          throw new Error("Saved assignment history is invalid; state was not changed.");
        }
        assignmentIds.add(assignment.id);
        sdkIds.add(assignment.sessionId);
      }
      if (state.agents.some(agent => {
        const persona = state.personas!.find(item => item.id === agent.personaId);
        const assignment = state.assignments!.find(item => item.id === agent.assignmentId);
        return !persona || !assignment || persona.id !== agent.id ||
          persona.name !== agent.name || persona.artId !== agent.persona ||
          assignment.personaId !== persona.id || assignment.sessionId !== agent.sessionId ||
          assignment.workspace !== agent.workspace || assignment.status !== "active" ||
          JSON.stringify(assignment.messages) !== JSON.stringify(agent.messages);
      }) || state.assignments.some(item => item.status === "active" &&
        !state.agents.some(agent => agent.assignmentId === item.id))) {
        throw new Error("Saved agent/assignment linkage is invalid; state was not changed.");
      }
    } else {
      state.schemaVersion = 2;
      state.personas = state.agents.map(agent => ({
        id: agent.id, name: agent.name!, artId: agent.persona!, createdAt: agent.createdAt,
        updatedAt: agent.updatedAt, profile: { workingStyle: "", specialties: [], title: "", rank: "" }, memories: []
      }));
      state.assignments = state.agents.map(agent => ({
        id: agent.id, personaId: agent.id, sessionId: agent.sessionId, workspace: agent.workspace,
        repository: agent.repository, startedAt: agent.createdAt, status: "active" as const, messages: agent.messages
      }));
      for (const agent of state.agents) {
        agent.personaId = agent.id;
        agent.assignmentId = agent.id;
      }
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
    for (const agent of this.state.agents) {
      const assignment = this.state.assignments?.find(item => item.id === agent.assignmentId);
      if (assignment) {
        assignment.messages = agent.messages;
        assignment.repository = agent.repository;
      }
    }
    const snapshot = structuredClone(this.state);
    this.saving = this.saving.catch(error => {
      console.error("Previous room save failed:", error);
    }).then(() => this.store.write(snapshot));
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
    if (grant?.remote) {
      if (!this.repositories) throw new Error("GitHub cache verifier unavailable; cannot resume a repository grant.");
      await this.repositories.verify(grant.remote);
    }
    try {
      const assignmentId = agent.assignmentId;
      const session = await this.adapter.resume(agent.sessionId, agent.workspace,
        request => this.permission(agent.id, request, assignmentId), grant,
        intent => this.requestAccessForAssignment(agent.id, assignmentId, intent),
        () => this.agent(agent.id).assignmentId === assignmentId ? this.agent(agent.id).repository : undefined);
      if (session.sessionId !== agent.sessionId) {
        await session.disconnect();
        throw new Error("SDK resumed a different session identity; repository access was not changed.");
      }
      return session;
    } catch (error) {
      if (agent.messages.length !== 0 || !(error instanceof Error) ||
        !error.message.includes(`Session not found: ${agent.sessionId}`)) throw error;
      const assignmentId = agent.assignmentId;
      const session = await this.adapter.create(agent.workspace,
        request => this.permission(agent.id, request, assignmentId), agent.sessionId, grant,
        intent => this.requestAccessForAssignment(agent.id, assignmentId, intent),
        () => this.agent(agent.id).assignmentId === assignmentId ? this.agent(agent.id).repository : undefined);
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
      const session = await this.adapter.create(workspace, request => this.permission(id, request, id), undefined, undefined,
        intent => this.requestAccessForAssignment(id, id, intent),
        () => this.agent(id).assignmentId === id ? this.agent(id).repository : undefined);
      if (this.state.assignments!.some(assignment => assignment.sessionId === session.sessionId)) {
        throw new Error("SDK returned a session identity already assigned in recorded history.");
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
      const names = new Set(this.state.personas!.map(item => item.name));
      let name = uniqueAgentName(session.sessionId, names);
      while (this.state.personas!.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        names.add(name);
        name = uniqueAgentName(session.sessionId, names);
      }
      const agent: Agent = { id, deskIndex, archived: false, workspace, workspaceKind: "scratch", createdAt: now, updatedAt: now, sessionId: session.sessionId, persona, name,
        personaId: id, assignmentId: id, phase: "idle", activity: "Ready to chat", messages: [] };
      this.state.agents.push(agent);
      this.state.personas!.push({ id, name, artId: persona, createdAt: now, updatedAt: now,
        profile: { workingStyle: "", specialties: [], title: "", rank: "" }, memories: [] });
      this.state.assignments!.push({ id, personaId: id, sessionId: session.sessionId, workspace,
        startedAt: now, status: "active", messages: agent.messages });
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

  private persona(personaId: string): AgentPersona {
    const persona = this.state.personas!.find(item => item.id === personaId);
    if (!persona) throw new Error("Unknown persona.");
    return persona;
  }

  async editPersona(personaId: string, input: {
    name: string; artId: number; workingStyle: string; specialties: string[]; title: string; rank: string
  }): Promise<void> {
    const persona = this.persona(personaId);
    const name = input.name.trim();
    if (!name || name.length > 80 || !Number.isInteger(input.artId) || input.artId < 0 || input.artId >= MAX_AGENTS ||
      [input.workingStyle, input.title, input.rank].some(value => typeof value !== "string" || value.length > 1000) ||
      !Array.isArray(input.specialties) || input.specialties.length > 20 ||
      input.specialties.some(value => typeof value !== "string" || !value.trim() || value.length > 80)) {
      throw new Error("Invalid persona profile.");
    }
    if (this.state.personas!.some(other => other.id !== personaId &&
      other.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("Persona name must be unique.");
    const agent = this.state.agents.find(item => item.personaId === personaId);
    if (agent && this.lifecycle.has(agent.id)) throw new Error("Persona is changing assignments.");
    if (agent && !agent.archived && this.state.agents.some(other => other.id !== agent.id &&
      !other.archived && other.persona === input.artId)) throw new Error("This art is already in use at an active desk.");
    persona.name = name;
    persona.artId = input.artId;
    persona.profile = { workingStyle: input.workingStyle.trim(), specialties: input.specialties.map(s => s.trim()),
      title: input.title.trim(), rank: input.rank.trim() };
    persona.updatedAt = Date.now();
    if (agent) { agent.name = name; agent.persona = input.artId; agent.updatedAt = persona.updatedAt; }
    await this.publish();
  }

  async addMemory(personaId: string, text: string, provenance: string): Promise<void> {
    const persona = this.persona(personaId);
    if (!text.trim() || text.length > 2000 || !provenance.trim() || provenance.length > 500) {
      throw new Error("Memory requires a note and its provenance.");
    }
    persona.memories.push({ id: randomUUID(), text: text.trim(), provenance: provenance.trim(), approvedAt: Date.now() });
    persona.updatedAt = Date.now();
    await this.publish();
  }

  async removeMemory(personaId: string, memoryId: string): Promise<void> {
    const persona = this.persona(personaId);
    const index = persona.memories.findIndex(item => item.id === memoryId);
    if (index < 0) throw new Error("Unknown memory note.");
    persona.memories.splice(index, 1);
    persona.updatedAt = Date.now();
    await this.publish();
  }

  async newAssignment(agentId: string, outcome = ""): Promise<void> {
    const agent = this.agent(agentId);
    if (agent.archived) throw new Error("Restore this persona before assigning new work.");
    this.availableForLifecycle(agent);
    if (!this.sessions.has(agentId)) throw new Error("Connect this persona's SDK session before switching assignments.");
    if (outcome.length > 1000) throw new Error("Outcome is too long.");
    this.lifecycle.add(agentId);
    const assignmentId = randomUUID();
    try {
      const workspace = await this.adapter.prepareWorkspace(this.state.workspace, assignmentId);
      const session = await this.adapter.create(workspace,
        request => this.permission(agentId, request, assignmentId),
        undefined, undefined, intent => this.requestAccessForAssignment(agentId, assignmentId, intent),
        () => this.agent(agentId).assignmentId === assignmentId ? this.agent(agentId).repository : undefined);
      if (this.state.assignments!.some(item => item.sessionId === session.sessionId)) {
        throw new Error("SDK returned an existing session identity; assignment was not changed.");
      }
      try {
        await this.sessions.get(agentId)!.disconnect();
      } catch (error) {
        await session.disconnect();
        throw error;
      }
      this.unsubscribers.get(agentId)?.();
      this.sessions.delete(agentId);
      this.unsubscribers.delete(agentId);
      const previous = this.state.assignments!.find(item => item.id === agent.assignmentId)!;
      previous.status = "completed";
      previous.endedAt = Date.now();
      previous.outcome = outcome.trim();
      previous.messages = agent.messages;
      previous.repository = agent.repository;
      agent.assignmentId = assignmentId;
      agent.sessionId = session.sessionId;
      agent.workspace = workspace;
      agent.workspaceKind = "scratch";
      agent.repository = undefined;
      agent.messages = [];
      agent.phase = "idle";
      agent.activity = "New assignment · no repository access";
      agent.updatedAt = Date.now();
      this.armedTaskGrants.delete(agentId);
      this.state.assignments!.push({ id: assignmentId, personaId: agent.personaId!, sessionId: session.sessionId,
        workspace, startedAt: agent.updatedAt, status: "active", messages: agent.messages });
      this.attach(agentId, session);
      if (this.state.usage) this.state.usage.stale = true;
      await this.publish();
    } finally {
      this.lifecycle.delete(agentId);
    }
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

  async fire(agentId: string, retention: "keep" | "delete-sdk"): Promise<void> {
    if (retention !== "keep" && retention !== "delete-sdk") throw new Error("Choose a retention policy.");
    const agent = this.agent(agentId);
    this.availableForLifecycle(agent);
    this.lifecycle.add(agentId);
    try {
      await this.sessions.get(agentId)?.disconnect();
      this.unsubscribers.get(agentId)?.();
      this.unsubscribers.delete(agentId);
      this.sessions.delete(agentId);
      if (retention === "delete-sdk") {
        try {
          await this.adapter.deleteSession(agent.sessionId);
        } catch (error) {
          this.report(error, agent);
          throw error;
        }
      }
      const assignment = this.state.assignments!.find(item => item.id === agent.assignmentId)!;
      assignment.status = "completed";
      assignment.endedAt = Date.now();
      assignment.outcome = "Persona fired; files and recorded assignment history retained";
      assignment.retention = retention;
      this.state.agents.splice(this.state.agents.indexOf(agent), 1);
      if (this.state.usage) this.state.usage.stale = true;
      await this.publish();
    } finally {
      this.lifecycle.delete(agentId);
    }
  }

  async sendHome(agentId: string): Promise<void> {
    await this.fire(agentId, "delete-sdk");
  }

  requestAccess(agentId: string, intent: AccessIntent): Promise<string> {
    const agent = this.agent(agentId);
    if (agent.archived || !this.listeners.size || agent.accessRequest || agent.review || this.lifecycle.has(agentId)) {
      return Promise.resolve(JSON.stringify({ status: "denied", reason: "No available browser or another request is pending." }));
    }
    const id = randomUUID();
    agent.accessRequest = { id, repoHint: intent.repoHint.slice(0, 150), purpose: intent.purpose.slice(0, 500),
      scope: intent.scope, status: "resolving", progress: "Checking GitHub identity (no clone yet)" };
    agent.phase = "permission";
    agent.activity = "Waiting for repository access decision";
    agent.updatedAt = Date.now();
    void this.publish().catch(error => console.error("Cannot save access request:", error));
    const decision = new Promise<string>(resolveResult => {
      const timer = setTimeout(() => this.resolveAccess(agentId, id, "denied", "Repository request timed out."), EXPIRE_MS);
      this.access.set(id, { agentId, resolve: resolveResult, timer });
    });
    void this.findRepository(agentId, id, intent.repoHint).catch(error => {
      if (agent.accessRequest?.id !== id) return;
      agent.accessRequest.status = "error";
      agent.accessRequest.error = error instanceof Error ? error.message : String(error);
      agent.accessRequest.progress = undefined;
      void this.publish().catch(cause => console.error("Cannot save access lookup failure:", cause));
    });
    return decision;
  }

  private requestAccessForAssignment(agentId: string, assignmentId: string | undefined, intent: AccessIntent): Promise<string> {
    if (this.state.agents.find(agent => agent.id === agentId)?.assignmentId !== assignmentId) {
      return Promise.resolve(JSON.stringify({ status: "denied", reason: "This SDK assignment is no longer active." }));
    }
    return this.requestAccess(agentId, intent);
  }

  guidedAccess(agentId: string): RepositoryRequest {
    const agent = this.agent(agentId);
    if (agent.archived || agent.accessRequest || agent.review || this.lifecycle.has(agentId) || !this.listeners.size ||
      ["thinking", "working", "permission"].includes(agent.phase)) {
      throw new Error("This agent cannot request repository access right now.");
    }
    const request: RepositoryRequest = { id: randomUUID(), repoHint: "", purpose: "Research or edit a GitHub repository",
      scope: "edit", status: "error", error: "Enter an owner/repo or repository name to look up; no clone has started." };
    agent.accessRequest = request;
    void this.publish().catch(error => console.error("Cannot save guided request:", error));
    return request;
  }

  async findRepository(agentId: string, id: string, hint: string): Promise<void> {
    const agent = this.agent(agentId);
    const request = agent.accessRequest;
    if (!request || request.id !== id || this.lifecycle.has(agentId) || request.status === "cloning") {
      throw new Error("Repository request is stale or already being provisioned.");
    }
    if (!this.repositories) throw new Error("GitHub repository discovery is unavailable.");
    request.repoHint = hint;
    request.status = "resolving";
    request.error = undefined;
    request.candidates = undefined;
    request.progress = "Checking GitHub identity (no clone yet)";
    await this.publish();
    try {
      const candidates = await this.repositories.lookup(hint);
      if (agent.accessRequest !== request || request.status !== "resolving") return;
      request.candidates = candidates;
      request.status = "review";
      request.progress = candidates.length > 1 ? "Choose the exact owner/repo before approving." : "Ready for your decision; no clone yet.";
    } catch (error) {
      if (agent.accessRequest !== request || request.status !== "resolving") return;
      request.status = "error";
      request.error = error instanceof Error ? error.message : String(error);
      request.progress = undefined;
    }
    await this.publish();
  }

  private async snapshotFor(repository: RemoteRepository, fresh: boolean, signal: AbortSignal): Promise<RepositorySnapshot> {
    if (!this.repositories) throw new Error("GitHub clone service unavailable.");
    const key = repository.fullName.toLowerCase();
    const cached = !fresh && this.state.snapshots?.find(snapshot =>
      snapshot.fullName.toLowerCase() === key && snapshot.ref === repository.defaultBranch &&
      snapshot.privacy === repository.privacy && snapshot.url === repository.url &&
      Date.now() - snapshot.fetchedAt < CACHE_AGE_MS);
    if (cached) {
      await this.repositories.verify(cached);
      return cached;
    }
    const snapshot = await this.repositories.provision(repository, signal);
    if (signal.aborted) throw new Error("Repository clone cancelled; no access granted.");
    this.state.snapshots!.unshift(snapshot);
    await this.publish();
    return snapshot;
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

  async decideAccess(agentId: string, id: string, choice: "deny" | "task" | "session" | "edit",
    fullName?: string, fresh = false): Promise<void> {
    const agent = this.agent(agentId);
    const request = agent.accessRequest;
    if (!request || request.id !== id || this.lifecycle.has(agentId)) throw new Error("Repository request is stale or belongs to another agent.");
    if (choice === "deny") {
      if (request.status === "cloning") throw new Error("Clone is in progress; use Stop to cancel this turn.");
      this.resolveAccess(agentId, id, "denied", "User denied repository access.");
      return;
    }
    if (request.status !== "review" || !fullName || !request.candidates?.length) {
      throw new Error("Choose a verified GitHub repository before granting access.");
    }
    if (choice === "edit" && request.scope !== "edit") throw new Error("This agent requested read access, not edit access.");
    const candidate = request.candidates.find(item => item.fullName === fullName);
    if (!candidate) throw new Error("Repository identity was not offered in this agent's request.");
    const session = this.sessions.get(agentId);
    if (!session || agent.archived) throw new Error("This agent must be connected before access can be granted.");
    const controller = new AbortController();
    this.clones.set(agentId, controller);
    const pending = this.access.get(id);
    if (pending) clearTimeout(pending.timer);
    request.status = "cloning";
    request.progress = `Preparing ${candidate.fullName} · ${candidate.defaultBranch} in the app-managed cache…`;
    this.lifecycle.add(agentId);
    let switchedDirectory = false;
    let committed = false;
    const previousRepository = agent.repository;
    try {
      await this.publish();
      const snapshot = await this.snapshotFor(candidate, fresh, controller.signal);
      if (controller.signal.aborted || agent.accessRequest !== request) return;
      const grant = await validateRepository(snapshot.path);
      let next: RepositoryGrant = { ...grant, name: snapshot.fullName,
        remote: snapshot, scope: choice === "task" ? "task" : "session" };
      if (choice === "edit") {
        next = await createResearchWorktree(this.worktreeRoot, grant, agentId);
        this.state.worktrees!.push({ agentId, repository: snapshot.fullName, path: next.worktree!.path, branch: next.worktree!.branch });
        await this.publish();
        if (controller.signal.aborted || agent.accessRequest !== request) return;
        try {
          switchedDirectory = true;
          await session.setWorkingDirectory(next.worktree!.path);
        } catch (error) {
          throw new Error(`Created worktree at ${next.worktree!.path} (branch ${next.worktree!.branch}), but SDK could not change this session's working directory. Worktree preserved for manual inspection. ${String(error)}`);
        }
      } else if (agent.repository?.worktree) {
        switchedDirectory = true;
        await session.setWorkingDirectory(agent.workspace);
      }
      if (controller.signal.aborted || agent.accessRequest !== request) return;
      agent.repository = next;
      if (choice === "task" && agent.phase === "idle") this.armedTaskGrants.add(agentId);
      else this.armedTaskGrants.delete(agentId);
      await this.publish();
      committed = true;
      this.resolveAccess(agentId, id, "approved", undefined, next);
    } catch (error) {
      if (!committed) agent.repository = previousRepository;
      if (agent.accessRequest === request) {
        request.status = "error";
        request.error = error instanceof Error ? error.message : String(error);
        request.progress = undefined;
        const waiting = this.access.get(id);
        if (waiting) waiting.timer = setTimeout(() =>
          this.resolveAccess(agentId, id, "denied", "Repository request timed out."), EXPIRE_MS);
        await this.publish();
      }
      throw error;
    } finally {
      if (switchedDirectory && !committed) {
        try {
          await session.setWorkingDirectory(previousRepository?.worktree?.path ?? agent.workspace);
        } catch (error) {
          this.report(new Error(`Could not restore the prior SDK working directory after repository access failed. ${String(error)}`), agent);
        }
      }
      this.clones.delete(agentId);
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
    if (agent.archived || (this.lifecycle.has(agentId) && agent.accessRequest?.status !== "cloning") ||
      !["thinking", "working", "permission"].includes(agent.phase)) {
      throw new Error("No active turn to stop for this agent.");
    }
    const session = this.sessions.get(agentId);
    if (!session) throw new Error("Agent SDK session is unavailable; cannot confirm cancellation.");
    this.lifecycle.add(agentId);
    try {
      this.clones.get(agentId)?.abort();
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

  private permission(agentId: string, request: PermissionRequest, assignmentId?: string): Promise<PermissionRequestResult> {
    const agent = this.state.agents.find(item => item.id === agentId);
    if (!agent || agent.assignmentId !== assignmentId) {
      return Promise.resolve({ kind: "reject", feedback: "This SDK assignment is no longer active." });
    }
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
    for (const controller of this.clones.values()) controller.abort();
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
