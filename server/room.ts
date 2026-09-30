import { randomUUID } from "node:crypto";
import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import type { Adapter, Agent, LiveSession, Review, Room } from "./types.js";
import type { Store } from "./storage.js";

const EXPIRE_MS = 90_000;
type Pending = { resolve: (decision: PermissionRequestResult) => void; timer: NodeJS.Timeout };

export class RoomController {
  readonly state: Room;
  private session: LiveSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<(room: Room) => void>();
  private pending = new Map<string, Pending>();
  private saving: Promise<void> = Promise.resolve();
  private creating = false;

  private constructor(private readonly adapter: Adapter, private readonly store: Store, state: Room) {
    this.state = state;
  }

  static async open(adapter: Adapter, store: Store, workspace: string): Promise<RoomController> {
    const saved = await store.read();
    if (saved && saved.workspace !== workspace) throw new Error(`Saved session belongs to ${saved.workspace}. Choose that workspace or move .local/state.json aside deliberately.`);
    const room = new RoomController(adapter, store, saved ?? { agent: null, error: null, connected: false, workspace, revision: 0 });
    room.state.connected = false;
    room.state.error = null;
    if (room.state.agent) {
      room.state.agent.review = undefined;
      if (["thinking", "working", "permission"].includes(room.state.agent.phase)) {
        room.state.agent.phase = "interrupted";
        room.state.agent.activity = "Turn interrupted by restart";
        const draft = [...room.state.agent.messages].reverse().find(message => message.role === "assistant" && message.pending);
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

  private report(error: unknown): void {
    this.state.error = error instanceof Error ? error.message : String(error);
    if (this.state.agent) {
      this.state.agent.phase = "error";
      this.state.agent.activity = "Connection or session error";
    }
    void this.publish().catch(cause => console.error("Cannot save room:", cause));
  }

  async connect(): Promise<void> {
    if (this.session && !this.state.error) return;
    try {
      await this.adapter.probe();
      if (this.state.agent) {
        const agent = this.state.agent;
        if (this.session) {
          this.unsubscribe?.();
          await this.session.disconnect();
          this.session = null;
        }
        let session: LiveSession;
        try {
          session = await this.adapter.resume(agent.sessionId, this.state.workspace, request => this.permission(request));
        } catch (error) {
          if (agent.messages.length !== 0 || !(error instanceof Error) ||
            !error.message.includes(`Session not found: ${agent.sessionId}`)) throw error;
          session = await this.adapter.create(this.state.workspace, request => this.permission(request), agent.sessionId);
          if (session.sessionId !== agent.sessionId) {
            await session.disconnect();
            throw new Error("SDK returned a different identity for the empty-session recovery.");
          }
          agent.activity = "Empty session restored; no messages lost";
        }
        this.attach(session);
      }
      this.state.connected = true;
      this.state.error = null;
      if (this.state.agent?.phase === "error") {
        this.state.agent.phase = "idle";
        if (this.state.agent.activity !== "Empty session restored; no messages lost") this.state.agent.activity = "Ready to chat";
      }
      await this.publish();
    } catch (error) {
      this.report(error);
      throw error;
    }
  }

  async create(x: number, y: number): Promise<void> {
    if (this.state.agent || this.creating) throw new Error("This first slice supports one desk agent.");
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) throw new Error("Invalid desk coordinates.");
    this.creating = true;
    try {
      const session = await this.adapter.create(this.state.workspace, request => this.permission(request));
      this.state.agent = { id: randomUUID(), x, y, sessionId: session.sessionId, phase: "idle", activity: "Ready to chat", messages: [] };
      this.attach(session);
      this.state.connected = true;
      this.state.error = null;
      await this.publish();
    } catch (error) {
      this.report(error);
      throw error;
    } finally {
      this.creating = false;
    }
  }

  private attach(session: LiveSession): void {
    this.unsubscribe?.();
    this.session = session;
    this.unsubscribe = session.onEvent(event => {
      try { this.event(event); } catch (error) { this.report(error); }
    });
  }

  async send(text: string): Promise<void> {
    const agent = this.state.agent;
    if (!agent || !this.session) throw new Error("Session unavailable. Retry connection before sending.");
    const prompt = text.trim();
    if (!prompt || prompt.length > 12000) throw new Error("Prompt must contain 1–12000 characters.");
    if (["thinking", "working", "permission"].includes(agent.phase)) throw new Error("Wait for the current turn to finish.");
    agent.messages.push({ id: randomUUID(), role: "user", content: prompt });
    agent.phase = "thinking";
    agent.activity = "Thinking";
    await this.publish();
    try {
      await this.session.send(prompt);
    } catch (error) {
      agent.phase = "error";
      agent.activity = "Message was not sent";
      this.report(error);
      throw error;
    }
  }

  private event(event: SessionEvent): void {
    const agent = this.state.agent;
    if (!agent) return;
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
        this.state.error = agent.activity;
        break;
      default:
        return;
    }
    void this.publish().catch(error => console.error("Cannot save SDK event:", error));
  }

  private permission(request: PermissionRequest): Promise<PermissionRequestResult> {
    if (!this.listeners.size || !this.state.agent) return Promise.resolve({ kind: "user-not-available" });
    if (this.state.agent.review) return Promise.resolve({ kind: "user-not-available" });
    const id = randomUUID();
    const review: Review = {
      id,
      kind: request.kind,
      tool: "toolName" in request ? String(request.toolName) : request.kind,
      detail: JSON.stringify(request, null, 2)
    };
    this.state.agent.review = review;
    this.state.agent.phase = "permission";
    this.state.agent.activity = "Waiting for your decision";
    void this.publish().catch(error => console.error("Cannot save permission request:", error));
    return new Promise(resolve => {
      const timer = setTimeout(() => this.decide(id, false, true), EXPIRE_MS);
      this.pending.set(id, { resolve, timer });
    });
  }

  decide(id: string, allow: boolean, expired = false): void {
    const pending = this.pending.get(id);
    if (!pending || this.state.agent?.review?.id !== id) throw new Error("Permission request is stale or already decided.");
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.state.agent.review = undefined;
    this.state.agent.phase = "thinking";
    this.state.agent.activity = allow ? "Approved once; waiting for tool" : expired ? "Permission timed out" : "Tool denied";
    void this.publish().catch(error => console.error("Cannot save permission decision:", error));
    pending.resolve(allow ? { kind: "approve-once" } : { kind: "reject", feedback: expired ? "No human decision before timeout." : "User denied this action." });
  }

  private denyPending(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ kind: "user-not-available" });
      this.pending.delete(id);
    }
    if (this.state.agent?.review) {
      this.state.agent.review = undefined;
      this.state.agent.phase = "interrupted";
      this.state.agent.activity = "No browser available; tool denied";
      void this.publish().catch(error => console.error("Cannot save permission disconnect:", error));
    }
  }

  async close(): Promise<void> {
    this.denyPending();
    this.unsubscribe?.();
    try {
      if (this.session) await this.session.disconnect();
    } finally {
      await this.adapter.stop();
      await this.saving;
    }
  }
}
