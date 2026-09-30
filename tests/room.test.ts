import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import { RoomController } from "../server/room.js";
import type { Adapter, LiveSession, Room } from "../server/types.js";
import type { Store } from "../server/storage.js";

class MemoryStore implements Store {
  saved: Room | null = null;
  async read(): Promise<Room | null> { return this.saved ? structuredClone(this.saved) : null; }
  async write(room: Room): Promise<void> { this.saved = structuredClone(room); }
}
class MockSession implements LiveSession {
  sessionId = "sdk-owned-session";
  sent: string[] = [];
  handler: ((event: SessionEvent) => void) | null = null;
  async send(prompt: string): Promise<void> { this.sent.push(prompt); }
  onEvent(handler: (event: SessionEvent) => void): () => void {
    this.handler = handler;
    return () => { this.handler = null; };
  }
  emit(event: SessionEvent): void { this.handler?.(event); }
  async disconnect(): Promise<void> {}
}
class MockAdapter implements Adapter {
  session = new MockSession();
  resumed: string | null = null;
  recreated: string | undefined;
  permission: ((request: PermissionRequest) => Promise<PermissionRequestResult>) | null = null;
  async probe(): Promise<void> {}
  async create(_workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>, sessionId?: string): Promise<LiveSession> {
    this.permission = permission;
    this.recreated = sessionId;
    return this.session;
  }
  async resume(id: string, _workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>): Promise<LiveSession> {
    this.resumed = id;
    this.permission = permission;
    return this.session;
  }
  async stop(): Promise<void> {}
}
const event = (type: string, data: Record<string, unknown> = {}): SessionEvent => ({ type, data } as SessionEvent);
const request = { kind: "shell", toolCallId: "call-1", fullCommandText: "rm -rf important" } as PermissionRequest;

test("persists streamed conversation and resumes the same SDK session after restart", async () => {
  const store = new MemoryStore();
  const adapter = new MockAdapter();
  const room = await RoomController.open(adapter, store, "/dedicated");
  await room.create(42, 68);
  await room.send("Hello");
  adapter.session.emit(event("assistant.message_delta", { deltaContent: "Hi" }));
  adapter.session.emit(event("assistant.message_delta", { deltaContent: " there" }));
  adapter.session.emit(event("assistant.message", { content: "Hi there" }));
  adapter.session.emit(event("session.idle"));
  await room.close();
  const recovered = await RoomController.open(adapter, store, "/dedicated");
  await recovered.connect();
  assert.equal(adapter.resumed, "sdk-owned-session");
  assert.deepEqual(recovered.state.agent?.messages.map(m => [m.role, m.content]), [["user", "Hello"], ["assistant", "Hi there"]]);
  assert.equal(recovered.state.agent?.phase, "idle");
  await recovered.close();
});

test("restart marks an incomplete turn interrupted, not complete", async () => {
  const store = new MemoryStore();
  const adapter = new MockAdapter();
  const room = await RoomController.open(adapter, store, "/dedicated");
  await room.create(50, 60);
  await room.send("Hello");
  adapter.session.emit(event("assistant.message_delta", { deltaContent: "Partial" }));
  await room.close();
  const recovered = await RoomController.open(adapter, store, "/dedicated");
  assert.equal(recovered.state.agent?.phase, "interrupted");
  assert.equal(recovered.state.agent?.messages.at(-1)?.content, "Partial");
  assert.equal(recovered.state.agent?.messages.at(-1)?.pending, false);
  await recovered.close();
});

test("permission needs a live browser, is one-time, rejects stale decisions and denies on disconnect", async () => {
  const adapter = new MockAdapter();
  const room = await RoomController.open(adapter, new MemoryStore(), "/dedicated");
  await room.create(50, 60);
  assert.deepEqual(await adapter.permission!(request), { kind: "user-not-available" });
  const unsubscribe = room.subscribe(() => {});
  const decision = adapter.permission!(request);
  const id = room.state.agent?.review?.id;
  assert.ok(id);
  assert.match(room.state.agent?.review?.detail ?? "", /rm -rf important/);
  room.decide(id, true);
  assert.deepEqual(await decision, { kind: "approve-once" });
  assert.throws(() => room.decide(id, true), /stale/);
  const unattended = adapter.permission!(request);
  unsubscribe();
  assert.deepEqual(await unattended, { kind: "user-not-available" });
  await room.close();
});

test("workspace mismatch refuses recovery rather than swapping SDK context", async () => {
  const store = new MemoryStore();
  const room = await RoomController.open(new MockAdapter(), store, "/first");
  await room.create(40, 60);
  await assert.rejects(RoomController.open(new MockAdapter(), store, "/second"), /belongs to/);
  await room.close();
});

test("real tool lifecycle events drive working and idle sprite states", async () => {
  const store = new MemoryStore();
  const adapter = new MockAdapter();
  const room = await RoomController.open(adapter, store, "/dedicated");
  await room.create(52, 61);
  await room.send("Inspect a file");
  adapter.session.emit(event("tool.execution_start", { toolName: "view" }));
  assert.equal(room.state.agent?.phase, "working");
  assert.equal(room.state.agent?.activity, "Using view");
  adapter.session.emit(event("tool.execution_complete", {}));
  assert.equal(room.state.agent?.phase, "thinking");
  adapter.session.emit(event("session.idle"));
  assert.equal(room.state.agent?.phase, "idle");
  await room.close();
  assert.equal(store.saved?.agent?.phase, "idle");
});

test("SDK resume errors preserve transcript and retry resuming the same identity", async () => {
  const store = new MemoryStore();
  const adapter = new MockAdapter();
  const first = await RoomController.open(adapter, store, "/dedicated");
  await first.create(50, 65);
  await first.send("Preserve me");
  await first.close();
  const recovering = await RoomController.open(adapter, store, "/dedicated");
  const originalResume = adapter.resume.bind(adapter);
  adapter.resume = async () => { throw new Error("CLI temporarily unavailable"); };
  await assert.rejects(recovering.connect(), /unavailable/);
  assert.equal(recovering.state.agent?.messages[0]?.content, "Preserve me");
  assert.equal(recovering.state.error, "CLI temporarily unavailable");
  adapter.resume = originalResume;
  await recovering.connect();
  assert.equal(adapter.resumed, "sdk-owned-session");
  assert.equal(recovering.state.error, null);
  await recovering.close();
});

test("missing eventless SDK session recreates only an empty agent with the same ID", async () => {
  const store = new MemoryStore();
  const adapter = new MockAdapter();
  const first = await RoomController.open(adapter, store, "/dedicated");
  await first.create(47, 69);
  await first.close();
  const recovered = await RoomController.open(adapter, store, "/dedicated");
  adapter.resume = async id => { throw new Error(`Failed to load session events: Session not found: ${id}`); };
  await recovered.connect();
  assert.equal(adapter.recreated, "sdk-owned-session");
  assert.equal(recovered.state.agent?.sessionId, "sdk-owned-session");
  assert.match(recovered.state.agent?.activity ?? "", /Empty session restored/);
  await recovered.close();

  const conversationStore = new MemoryStore();
  const withHistory = await RoomController.open(new MockAdapter(), conversationStore, "/dedicated");
  await withHistory.create(47, 69);
  await withHistory.send("Conversation must not be replaced");
  await withHistory.close();
  const failing = new MockAdapter();
  failing.resume = async id => { throw new Error(`Session not found: ${id}`); };
  const protectedRoom = await RoomController.open(failing, conversationStore, "/dedicated");
  await assert.rejects(protectedRoom.connect(), /Session not found/);
  assert.equal(failing.recreated, undefined);
  assert.equal(protectedRoom.state.agent?.messages[0]?.content, "Conversation must not be replaced");
  await protectedRoom.close();
});
