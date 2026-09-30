import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import { RoomController } from "../server/room.js";
import { MAX_AGENTS, type Adapter, type LegacyRoom, type LiveSession, type Room } from "../server/types.js";
import type { Store } from "../server/storage.js";

class MemoryStore implements Store {
  saved: Room | LegacyRoom | null = null;
  async read(): Promise<Room | LegacyRoom | null> { return this.saved ? structuredClone(this.saved) : null; }
  async write(room: Room): Promise<void> { this.saved = structuredClone(room); }
}
class MockSession implements LiveSession {
  sent: string[] = [];
  handler: ((event: SessionEvent) => void) | null = null;
  constructor(readonly sessionId: string) {}
  async send(prompt: string): Promise<void> { this.sent.push(prompt); }
  onEvent(handler: (event: SessionEvent) => void): () => void {
    this.handler = handler;
    return () => { this.handler = null; };
  }
  emit(event: SessionEvent): void { this.handler?.(event); }
  async disconnect(): Promise<void> {}
}
class MockAdapter implements Adapter {
  sessions = new Map<string, MockSession>();
  permissions = new Map<string, (request: PermissionRequest) => Promise<PermissionRequestResult>>();
  workspaces = new Map<string, string>();
  resumed: string[] = [];
  recreated: string | undefined;
  failResume = new Set<string>();
  missing = new Set<string>();
  async probe(): Promise<void> {}
  async prepareWorkspace(root: string, agentId: string): Promise<string> {
    return `${root}/agents/${agentId}`;
  }
  async create(workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>, sessionId?: string): Promise<LiveSession> {
    const id = sessionId ?? `sdk-session-${this.sessions.size + 1}`;
    const session = new MockSession(id);
    this.sessions.set(id, session);
    this.workspaces.set(id, workspace);
    this.permissions.set(id, permission);
    this.recreated = sessionId;
    return session;
  }
  async resume(id: string, workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>): Promise<LiveSession> {
    this.resumed.push(id);
    if (this.failResume.has(id)) throw new Error("CLI temporarily unavailable");
    if (this.missing.has(id)) throw new Error(`Failed to load session events: Session not found: ${id}`);
    if (this.workspaces.get(id) !== workspace) throw new Error("Wrong agent workspace");
    this.permissions.set(id, permission);
    return this.sessions.get(id)!;
  }
  async stop(): Promise<void> {}
}
const event = (type: string, data: Record<string, unknown> = {}): SessionEvent => ({ type, data } as SessionEvent);
const request = { kind: "shell", toolCallId: "call-1", fullCommandText: "rm -rf important" } as PermissionRequest;

test("migrates the existing agent without changing its session, transcript or root workspace", async () => {
  const store = new MemoryStore();
  store.saved = { workspace: "/dedicated", connected: true, error: null, revision: 7,
    agent: { id: "old-agent", sessionId: "old-sdk-session", x: 42, y: 68,
      phase: "idle", activity: "Ready to chat",
      messages: [{ id: "old-message", role: "user", content: "Keep this conversation" }] } };
  const adapter = new MockAdapter();
  adapter.sessions.set("old-sdk-session", new MockSession("old-sdk-session"));
  adapter.workspaces.set("old-sdk-session", "/dedicated");
  const room = await RoomController.open(adapter, store, "/dedicated");
  assert.equal(room.state.agents[0].id, "old-agent");
  assert.equal(room.state.agents[0].sessionId, "old-sdk-session");
  assert.equal(room.state.agents[0].workspace, "/dedicated");
  assert.equal(room.state.agents[0].deskIndex, 0);
  assert.equal(room.state.agents[0].messages[0].content, "Keep this conversation");
  await room.connect();
  assert.deepEqual(adapter.resumed, ["old-sdk-session"]);
  const next = await room.create(2);
  assert.equal(next.workspace, `/dedicated/agents/${next.id}`);
  assert.equal(room.state.agents[0].workspace, "/dedicated");
  await room.close();
});

test("two SDK sessions retain independent streamed turns and resume from their own folders", async () => {
  const store = new MemoryStore();
  const adapter = new MockAdapter();
  const room = await RoomController.open(adapter, store, "/dedicated");
  const a = await room.create(0);
  const b = await room.create(1);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.notEqual(a.workspace, b.workspace);
  await room.send(a.id, "First prompt");
  await room.send(b.id, "Second prompt");
  adapter.sessions.get(a.sessionId)!.emit(event("assistant.message_delta", { deltaContent: "Hi" }));
  adapter.sessions.get(a.sessionId)!.emit(event("assistant.message_delta", { deltaContent: " there" }));
  adapter.sessions.get(a.sessionId)!.emit(event("assistant.message", { content: "Hi there" }));
  adapter.sessions.get(a.sessionId)!.emit(event("session.idle"));
  adapter.sessions.get(b.sessionId)!.emit(event("assistant.message_delta", { deltaContent: "Partial" }));
  await room.close();
  const recovered = await RoomController.open(adapter, store, "/dedicated");
  assert.deepEqual(recovered.state.agents[0].messages.map(m => [m.role, m.content]), [["user", "First prompt"], ["assistant", "Hi there"]]);
  assert.deepEqual(recovered.state.agents[1].messages.map(m => [m.role, m.content]), [["user", "Second prompt"], ["assistant", "Partial"]]);
  assert.equal(recovered.state.agents[1].phase, "interrupted");
  assert.equal(recovered.state.agents[1].messages.at(-1)?.pending, false);
  await recovered.connect();
  assert.deepEqual(adapter.resumed, [a.sessionId, b.sessionId]);
  await recovered.close();
});

test("per-agent permission is one-time, rejects cross-agent decisions and denies when the browser leaves", async () => {
  const adapter = new MockAdapter();
  const room = await RoomController.open(adapter, new MemoryStore(), "/dedicated");
  const a = await room.create(0);
  const b = await room.create(1);
  const permissionA = adapter.permissions.get(a.sessionId)!;
  const permissionB = adapter.permissions.get(b.sessionId)!;
  assert.deepEqual(await permissionA(request), { kind: "user-not-available" });
  const unsubscribe = room.subscribe(() => {});
  const decisionA = permissionA(request);
  const decisionB = permissionB(request);
  const idA = a.review?.id;
  const idB = b.review?.id;
  assert.ok(idA && idB);
  assert.match(a.review?.detail ?? "", /rm -rf important/);
  assert.throws(() => room.decide(b.id, idA, true), /another agent/);
  assert.equal(a.review?.id, idA);
  assert.equal(b.review?.id, idB);
  room.decide(a.id, idA, true);
  assert.deepEqual(await decisionA, { kind: "approve-once" });
  assert.throws(() => room.decide(a.id, idA, true), /stale/);
  unsubscribe();
  assert.deepEqual(await decisionB, { kind: "user-not-available" });
  assert.equal(b.phase, "interrupted");
  await room.close();
});

test("a full office and occupied desks refuse extra sessions", async () => {
  const room = await RoomController.open(new MockAdapter(), new MemoryStore(), "/dedicated");
  await room.create(0);
  await assert.rejects(room.create(0), /occupied/);
  await assert.rejects(room.create(MAX_AGENTS), /Invalid desk/);
  for (let deskIndex = 1; deskIndex < MAX_AGENTS; deskIndex++) await room.create(deskIndex);
  assert.equal(room.state.agents.length, MAX_AGENTS);
  await assert.rejects(room.create(0), /occupied|All office desks/);
  await room.close();
});

test("an SDK identity cannot be assigned to two office agents", async () => {
  const adapter = new MockAdapter();
  const room = await RoomController.open(adapter, new MemoryStore(), "/dedicated");
  const first = await room.create(0);
  adapter.create = async () => adapter.sessions.get(first.sessionId)!;
  await assert.rejects(room.create(1), /already assigned/);
  assert.equal(room.state.agents.length, 1);
  await room.close();
});

test("one failed resume stays visible while other agents recover independently", async () => {
  const store = new MemoryStore();
  const adapter = new MockAdapter();
  const first = await RoomController.open(adapter, store, "/dedicated");
  const a = await first.create(0);
  const b = await first.create(1);
  await first.send(a.id, "Preserve me");
  await first.close();
  const recovering = await RoomController.open(adapter, store, "/dedicated");
  adapter.failResume.add(a.sessionId);
  await recovering.connect();
  assert.equal(recovering.state.agents[0].phase, "error");
  assert.match(recovering.state.agents[0].activity, /unavailable/);
  assert.equal(recovering.state.agents[0].messages[0].content, "Preserve me");
  assert.equal(recovering.state.agents[1].phase, "idle");
  assert.ok(adapter.resumed.includes(b.sessionId));
  adapter.failResume.delete(a.sessionId);
  await recovering.connect();
  assert.equal(recovering.state.agents[0].phase, "idle");
  await recovering.close();
});

test("concurrent reconnects resume once and recover an errored live SDK session", async () => {
  const store = new MemoryStore();
  const adapter = new MockAdapter();
  const first = await RoomController.open(adapter, store, "/dedicated");
  const agent = await first.create(0);
  await first.close();
  const room = await RoomController.open(adapter, store, "/dedicated");
  await Promise.all([room.connect(), room.connect()]);
  assert.deepEqual(adapter.resumed, [agent.sessionId]);
  adapter.sessions.get(agent.sessionId)!.emit(event("session.error", { message: "Transport dropped" }));
  assert.equal(room.state.agents[0].phase, "error");
  await room.connect();
  assert.deepEqual(adapter.resumed, [agent.sessionId, agent.sessionId]);
  assert.equal(room.state.agents[0].phase, "idle");
  await room.close();
});

test("an eventless missing session is recreated under the same identity; history is never replaced", async () => {
  const store = new MemoryStore();
  const adapter = new MockAdapter();
  const first = await RoomController.open(adapter, store, "/dedicated");
  const empty = await first.create(0);
  const populated = await first.create(1);
  await first.send(populated.id, "Conversation must not be replaced");
  await first.close();
  const recovered = await RoomController.open(adapter, store, "/dedicated");
  adapter.missing.add(empty.sessionId);
  adapter.missing.add(populated.sessionId);
  await recovered.connect();
  assert.equal(adapter.recreated, empty.sessionId);
  assert.match(recovered.state.agents[0].activity, /Empty session restored/);
  assert.equal(recovered.state.agents[1].phase, "error");
  assert.equal(recovered.state.agents[1].messages[0].content, "Conversation must not be replaced");
  await recovered.close();
});

test("workspace mismatch refuses recovery rather than swapping SDK context", async () => {
  const store = new MemoryStore();
  const room = await RoomController.open(new MockAdapter(), store, "/first");
  await room.create(0);
  await assert.rejects(RoomController.open(new MockAdapter(), store, "/second"), /belong to/);
  await room.close();
});

test("real tool lifecycle events drive only the owning sprite", async () => {
  const adapter = new MockAdapter();
  const room = await RoomController.open(adapter, new MemoryStore(), "/dedicated");
  const a = await room.create(0);
  const b = await room.create(1);
  await room.send(a.id, "Inspect a file");
  adapter.sessions.get(a.sessionId)!.emit(event("tool.execution_start", { toolName: "view" }));
  assert.equal(a.phase, "working");
  assert.equal(a.activity, "Using view");
  assert.equal(b.phase, "idle");
  adapter.sessions.get(a.sessionId)!.emit(event("tool.execution_complete", {}));
  assert.equal(a.phase, "thinking");
  adapter.sessions.get(a.sessionId)!.emit(event("session.idle"));
  assert.equal(a.phase, "idle");
  await room.close();
});
