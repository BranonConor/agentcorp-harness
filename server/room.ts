import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import { MAX_AGENTS, type Adapter, type Agent, type LiveSession, type Review, type Room } from "./types.js";
import type { Store } from "./storage.js";

const EXPIRE_MS = 90_000;
type Pending = { agentId: string; resolve: (decision: PermissionRequestResult) => void; timer: NodeJS.Timeout };

export class RoomController {
  readonly state: Room;
  private sessions = new Map<string, LiveSession>();
  private unsubscribers = new Map<string, () => void>();
  private listeners = new Set<(room: Room) => void>();
  private pending = new Map<string, Pending>();
  private saving: Promise<void> = Promise.resolve();
  private connecting: Promise<void> | null = null;
  private creating = new Set<number>();

  private constructor(private readonly adapter: Adapter, private readonly store: Store, state: Room) {
    this.state = state;
  }

  static async open(adapter: Adapter, store: Store, workspace: string): Promise<RoomController> {
    const saved = await store.read();
    if (saved && saved.workspace !== workspace) throw new Error(`Saved sessions belong to ${saved.workspace}. Choose that workspace or move .local/state.json aside deliberately.`);
    if (saved && !("agents" in saved) && !("agent" in saved)) throw new Error("Unrecognized saved room format; state was not changed.");
    const now = Date.now();
    const state: Room = saved
      ? "agents" in saved
        ? saved
        : { agents: saved.agent ? [{ ...saved.agent, deskIndex: 0, workspace, workspaceKind: "root", createdAt: now, updatedAt: now }] : [], error: saved.error, connected: saved.connected, workspace, revision: saved.revision }
      : { agents: [], error: null, connected: false, workspace, revision: 0 };
    if (!Array.isArray(state.agents) || state.agents.length > MAX_AGENTS ||
      state.agents.some((agent, index) => !agent.id || !agent.sessionId || !agent.workspace ||
        !(agent.workspaceKind === "root" && agent.workspace === workspace && agent.deskIndex === 0 ||
          agent.workspaceKind === "scratch" && /^[0-9a-f-]{36}$/.test(agent.id) &&
          agent.workspace === join(workspace, "agents", agent.id)) ||
        !Number.isInteger(agent.deskIndex) || agent.deskIndex < 0 || agent.deskIndex >= MAX_AGENTS ||
        state.agents.findIndex(other => other.deskIndex === agent.deskIndex ||
          other.id === agent.id || other.sessionId === agent.sessionId) !== index)) {
      throw new Error("Saved agent roster is invalid; state was not changed.");
    }
    const room = new RoomController(adapter, store, state);
    room.state.connected = false;
    room.state.error = null;
    for (const agent of room.state.agents) {
      agent.review = undefined;
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
      if (this.sessions.has(agent.id) && agent.phase !== "error") continue;
      try {
        if (this.sessions.has(agent.id)) {
          this.unsubscribers.get(agent.id)?.();
          await this.sessions.get(agent.id)!.disconnect();
          this.sessions.delete(agent.id);
          this.unsubscribers.delete(agent.id);
        }
        let session: LiveSession;
        try {
          session = await this.adapter.resume(agent.sessionId, agent.workspace, request => this.permission(agent.id, request));
        } catch (error) {
          if (agent.messages.length !== 0 || !(error instanceof Error) ||
            !error.message.includes(`Session not found: ${agent.sessionId}`)) throw error;
          session = await this.adapter.create(agent.workspace, request => this.permission(agent.id, request), agent.sessionId);
          if (session.sessionId !== agent.sessionId) {
            await session.disconnect();
            throw new Error("SDK returned a different identity for the empty-session recovery.");
          }
          agent.activity = "Empty session restored; no messages lost";
        }
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

  async create(deskIndex: number): Promise<Agent> {
    if (!Number.isInteger(deskIndex) || deskIndex < 0 || deskIndex >= MAX_AGENTS) throw new Error("Invalid desk.");
    if (this.state.agents.length >= MAX_AGENTS) throw new Error("All office desks are occupied.");
    if (this.state.agents.some(agent => agent.deskIndex === deskIndex) || this.creating.has(deskIndex)) throw new Error("This desk is already occupied.");
    this.creating.add(deskIndex);
    const id = randomUUID();
    try {
      const workspace = await this.adapter.prepareWorkspace(this.state.workspace, id);
      const session = await this.adapter.create(workspace, request => this.permission(id, request));
      if (this.state.agents.some(agent => agent.sessionId === session.sessionId)) {
        throw new Error("SDK returned a session identity already assigned to another agent.");
      }
      const now = Date.now();
      const agent: Agent = { id, deskIndex, workspace, workspaceKind: "scratch", createdAt: now, updatedAt: now, sessionId: session.sessionId,
        phase: "idle", activity: "Ready to chat", messages: [] };
      this.state.agents.push(agent);
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

  async send(agentId: string, text: string): Promise<void> {
    const agent = this.agent(agentId);
    const session = this.sessions.get(agentId);
    if (!session) throw new Error("Session unavailable. Retry connection before sending.");
    const prompt = text.trim();
    if (!prompt || prompt.length > 12000) throw new Error("Prompt must contain 1–12000 characters.");
    if (["thinking", "working", "permission"].includes(agent.phase)) throw new Error("Wait for the current turn to finish.");
    agent.messages.push({ id: randomUUID(), role: "user", content: prompt });
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
        agent.phase = "idle";
        agent.activity = "Ready to chat";
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
    if (!this.listeners.size || !agent || agent.review) return Promise.resolve({ kind: "user-not-available" });
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
