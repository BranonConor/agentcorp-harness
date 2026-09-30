import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import { RoomController } from "../server/room.js";
import type { RepositoryGrant } from "../server/repository.js";
import { MAX_AGENTS, type Adapter, type LegacyRoom, type LiveSession, type Room } from "../server/types.js";
import type { Store } from "../server/storage.js";

class MemoryStore implements Store {
  saved: Room | LegacyRoom | null = null;
  async read(): Promise<Room | LegacyRoom | null> { return this.saved ? structuredClone(this.saved) : null; }
  async write(room: Room): Promise<void> { this.saved = structuredClone(room); }
}
class MockSession implements LiveSession {
  sent: string[] = [];
  aborts = 0;
  abortError: Error | null = null;
  disconnects = 0;
  handler: ((event: SessionEvent) => void) | null = null;
  constructor(readonly sessionId: string) {}
  async send(prompt: string): Promise<void> { this.sent.push(prompt); }
  async abort(): Promise<void> {
    if (this.abortError) throw this.abortError;
    this.aborts++;
  }
  onEvent(handler: (event: SessionEvent) => void): () => void {
    this.handler = handler;
    return () => { this.handler = null; };
  }
  emit(event: SessionEvent): void { this.handler?.(event); }
  async disconnect(): Promise<void> { this.disconnects++; }
}
class MockAdapter implements Adapter {
  sessions = new Map<string, MockSession>();
  permissions = new Map<string, (request: PermissionRequest) => Promise<PermissionRequestResult>>();
  workspaces = new Map<string, string>();
  prepared: string[] = [];
  resumed: string[] = [];
  recreated: string | undefined;
  failResume = new Set<string>();
  missing = new Set<string>();
  deleted: string[] = [];
  grants = new Map<string, RepositoryGrant | undefined>();
  deleteError: Error | null = null;
  async probe(): Promise<void> {}
  async prepareWorkspace(root: string, agentId: string): Promise<string> {
    this.prepared.push(agentId);
    return `${root}/agents/${agentId}`;
  }
  async create(workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>, sessionId?: string, repository?: RepositoryGrant): Promise<LiveSession> {
    const id = sessionId ?? `sdk-session-${this.sessions.size + 1}`;
    const session = new MockSession(id);
    this.sessions.set(id, session);
    this.workspaces.set(id, workspace);
    this.permissions.set(id, permission);
    this.grants.set(id, repository);
    this.recreated = sessionId;
    return session;
  }
  async resume(id: string, workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>, repository?: RepositoryGrant): Promise<LiveSession> {
    this.resumed.push(id);
    if (this.failResume.has(id)) throw new Error("CLI temporarily unavailable");
    if (this.missing.has(id)) throw new Error(`Failed to load session events: Session not found: ${id}`);
    if (this.workspaces.get(id) !== workspace) throw new Error("Wrong agent workspace");
    this.permissions.set(id, permission);
    this.grants.set(id, repository);
    return this.sessions.get(id)!;
  }
  async deleteSession(id: string): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    this.deleted.push(id);
    this.sessions.delete(id);
  }
  async stop(): Promise<void> {}
}
const event = (type: string, data: Record<string, unknown> = {}): SessionEvent => ({ type, data } as SessionEvent);
const request = { kind: "shell", toolCallId: "call-1", fullCommandText: "rm -rf important" } as PermissionRequest;

test("migrates the existing agent without changing its session, transcript or root workspace", async () => {
  const store = new MemoryStore();
  const originalMessages = Array.from({ length: 15 }, (_, index) => ({
    id: `old-message-${index}`, role: (index % 2 ? "assistant" : "user") as "assistant" | "user",
    content: `Preserved message ${index + 1}`,
  }));
  store.saved = { workspace: "/dedicated", connected: true, error: null, revision: 7,
    agent: { id: "old-agent", sessionId: "old-sdk-session", x: 42, y: 68,
      phase: "idle", activity: "Ready to chat", messages: originalMessages } };
  const adapter = new MockAdapter();
  adapter.sessions.set("old-sdk-session", new MockSession("old-sdk-session"));
  adapter.workspaces.set("old-sdk-session", "/dedicated");
  const room = await RoomController.open(adapter, store, "/dedicated");
  assert.equal(room.state.agents[0].id, "old-agent");
  assert.equal(room.state.agents[0].sessionId, "old-sdk-session");
  assert.equal(room.state.agents[0].workspace, "/dedicated");
  assert.equal(room.state.agents[0].deskIndex, 0);
  assert.deepEqual(room.state.agents[0].messages, originalMessages);
  assert.equal(room.state.agents.length, 1);
  await room.connect();
  assert.deepEqual(adapter.resumed, ["old-sdk-session"]);
  assert.equal(adapter.prepared.length, 0);
  assert.equal(room.state.agents.length, 1);
  await room.close();
  const reloaded = await RoomController.open(adapter, store, "/dedicated");
  await reloaded.connect();
  assert.equal(reloaded.state.agents.length, 1);
  assert.deepEqual(reloaded.state.agents[0].messages, originalMessages);
  assert.equal(adapter.prepared.length, 0);
  const next = await reloaded.create(1);
  assert.equal(next.workspace, `/dedicated/agents/${next.id}`);
  assert.equal(reloaded.state.agents.length, 2);
  assert.equal(adapter.prepared.length, 1);
  assert.equal(reloaded.state.agents[0].workspace, "/dedicated");
  await reloaded.close();
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

test("archive frees its desk without deleting session, keeps history on restart, and restore resumes it", async () => {
  const store = new MemoryStore();
  const adapter = new MockAdapter();
  const room = await RoomController.open(adapter, store, "/dedicated");
  const original = await room.create(3);
  await room.send(original.id, "Keep my work");
  adapter.sessions.get(original.sessionId)!.emit(event("assistant.message", { content: "Kept" }));
  adapter.sessions.get(original.sessionId)!.emit(event("session.idle"));
  const originalWorkspace = original.workspace;
  await room.archive(original.id);
  assert.equal(original.archived, true);
  assert.equal(original.deskIndex, null);
  assert.equal(original.lastDeskIndex, 3);
  assert.equal(original.workspace, originalWorkspace);
  assert.deepEqual(adapter.deleted, []);
  await assert.rejects(room.send(original.id, "Not while archived"), /not active/);
  const newcomer = await room.create(3);
  assert.equal(newcomer.deskIndex, 3);
  await room.close();

  const recovered = await RoomController.open(adapter, store, "/dedicated");
  await recovered.connect();
  assert.equal(recovered.state.agents.find(agent => agent.id === original.id)?.archived, true);
  assert.equal(adapter.resumed.includes(original.sessionId), false);
  await recovered.restore(original.id);
  const restored = recovered.state.agents.find(agent => agent.id === original.id)!;
  assert.equal(restored.archived, false);
  assert.equal(restored.deskIndex, 0);
  assert.equal(restored.workspace, originalWorkspace);
  assert.deepEqual(restored.messages.map(message => message.content), ["Keep my work", "Kept"]);
  assert.deepEqual(adapter.resumed, [newcomer.sessionId, original.sessionId]);
  await recovered.close();
});

test("restore refuses a full office without resuming or changing an archived record", async () => {
  const adapter = new MockAdapter();
  const room = await RoomController.open(adapter, new MemoryStore(), "/dedicated");
  const archived = await room.create(0);
  await room.archive(archived.id);
  for (let index = 0; index < MAX_AGENTS; index++) await room.create(index);
  await assert.rejects(room.restore(archived.id), /Office full/);
  assert.equal(archived.archived, true);
  assert.equal(archived.deskIndex, null);
  assert.equal(adapter.resumed.includes(archived.sessionId), false);
  await room.close();
});

test("send home deletes exactly the selected SDK session and record, never its scratch path", async () => {
  const adapter = new MockAdapter();
  const room = await RoomController.open(adapter, new MemoryStore(), "/dedicated");
  const a = await room.create(0);
  const b = await room.create(1);
  const keptWorkspace = a.workspace;
  await room.sendHome(b.id);
  assert.deepEqual(adapter.deleted, [b.sessionId]);
  assert.deepEqual(room.state.agents.map(agent => agent.id), [a.id]);
  assert.equal(a.workspace, keptWorkspace);
  assert.equal(adapter.workspaces.get(b.sessionId), b.workspace);
  await room.close();
});

test("SDK deletion failure retains the record and exposes an error for retry", async () => {
  const adapter = new MockAdapter();
  const room = await RoomController.open(adapter, new MemoryStore(), "/dedicated");
  const agent = await room.create(0);
  adapter.deleteError = new Error("SDK refused deletion");
  await assert.rejects(room.sendHome(agent.id), /SDK refused deletion/);
  assert.equal(room.state.agents.length, 1);
  assert.equal(room.state.agents[0].sessionId, agent.sessionId);
  assert.equal(room.state.agents[0].phase, "error");
  assert.deepEqual(adapter.deleted, []);
  adapter.deleteError = null;
  await room.sendHome(agent.id);
  assert.deepEqual(adapter.deleted, [agent.sessionId]);
  assert.equal(room.state.agents.length, 0);
  await room.close();
});

test("an active turn and pending permission block archive and permanent send home", async () => {
  const adapter = new MockAdapter();
  const room = await RoomController.open(adapter, new MemoryStore(), "/dedicated");
  const agent = await room.create(0);
  await room.send(agent.id, "A task");
  await assert.rejects(room.archive(agent.id), /Wait for the turn/);
  await assert.rejects(room.sendHome(agent.id), /Wait for the turn/);
  const unsubscribe = room.subscribe(() => {});
  const pending = adapter.permissions.get(agent.sessionId)!(request);
  assert.ok(agent.review);
  await assert.rejects(room.archive(agent.id), /Wait for the turn/);
  await assert.rejects(room.sendHome(agent.id), /Wait for the turn/);
  room.decide(agent.id, agent.review!.id, false);
  await pending;
  adapter.sessions.get(agent.sessionId)!.emit(event("session.idle"));
  await room.archive(agent.id);
  assert.equal(agent.archived, true);
  unsubscribe();
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

test("repository research grant stays per agent through archive and restart; revoke and send home remove it", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentcorp-grant-"));
  try {
    const resolvedRoot = await realpath(root);
    execFileSync("git", ["init", "-q", root]);
    await writeFile(join(root, "README.md"), "public fixture");
    execFileSync("git", ["-C", root, "add", "README.md"]);
    const store = new MemoryStore();
    const adapter = new MockAdapter();
    const room = await RoomController.open(adapter, store, "/dedicated");
    const a = await room.create(0);
    const b = await room.create(1);
    await assert.rejects(room.setRepository(a.id, "/does-not-exist"), /ENOENT|not a git repository/);
    await room.setRepository(a.id, root);
    assert.deepEqual(a.repository, { path: resolvedRoot, name: root.split("/").at(-1) });
    assert.equal(adapter.grants.get(b.sessionId), undefined);
    assert.equal(adapter.grants.get(a.sessionId)?.path, resolvedRoot);
    assert.equal(a.sessionId, adapter.sessions.get(a.sessionId)?.sessionId);
    await room.archive(a.id);
    await room.close();
    const restarted = await RoomController.open(adapter, store, "/dedicated");
    await restarted.connect();
    assert.equal(restarted.state.agents[0].repository?.path, resolvedRoot);
    assert.equal(adapter.grants.get(b.sessionId), undefined);
    await restarted.restore(a.id);
    assert.equal(adapter.grants.get(a.sessionId)?.path, resolvedRoot);
    await restarted.setRepository(a.id, null);
    assert.equal(restarted.state.agents[0].repository, undefined);
    assert.equal(adapter.grants.get(a.sessionId), undefined);
    await restarted.setRepository(a.id, root);
    await restarted.sendHome(a.id);
    assert.equal(restarted.state.agents.some(agent => agent.id === a.id), false);
    assert.equal(restarted.state.agents[0].id, b.id);
    await restarted.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("STOP aborts only the active SDK turn, rejects pending permission and reports failure", async () => {
  const adapter = new MockAdapter();
  const room = await RoomController.open(adapter, new MemoryStore(), "/dedicated");
  const a = await room.create(0);
  const b = await room.create(1);
  await room.send(a.id, "Research");
  await assert.rejects(room.setRepository(a.id, null), /Wait for the turn/);
  const unsubscribe = room.subscribe(() => {});
  const decision = adapter.permissions.get(a.sessionId)!(request);
  assert.ok(a.review);
  await room.stop(a.id);
  assert.deepEqual(await decision, { kind: "reject", feedback: "Turn stopped by user." });
  assert.equal(adapter.sessions.get(a.sessionId)?.aborts, 1);
  assert.equal(a.phase, "idle");
  assert.equal(a.activity, "Turn stopped by user · ready to chat");
  assert.equal(a.messages.at(-1)?.content, "Turn stopped by user.");
  assert.equal(a.review, undefined);
  assert.equal(b.phase, "idle");
  await assert.rejects(room.stop(a.id), /No active turn/);
  await room.send(a.id, "Another turn");
  adapter.sessions.get(a.sessionId)!.abortError = new Error("SDK cancellation unavailable");
  await assert.rejects(room.stop(a.id), /cancellation unavailable/);
  assert.equal(a.phase, "error");
  assert.match(a.activity, /cancellation unavailable/);
  unsubscribe();
  await room.close();
});

test("explicit research grant authorizes only its own read-only SDK tool, never shell or writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentcorp-permission-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const adapter = new MockAdapter();
    const room = await RoomController.open(adapter, new MemoryStore(), "/dedicated");
    const agent = await room.create(0);
    const attachedRequest = { kind: "custom-tool", toolCallId: "read-1",
      toolName: "research_attached_repository", toolDescription: "Read tracked files",
      args: { action: "read", path: "README.md" } } as PermissionRequest;
    assert.deepEqual(await adapter.permissions.get(agent.sessionId)!(attachedRequest), { kind: "reject", feedback: "No active repository research grant." });
    await room.setRepository(agent.id, root);
    assert.deepEqual(await adapter.permissions.get(agent.sessionId)!(attachedRequest), { kind: "approve-once" });
    const noBrowserShell = await adapter.permissions.get(agent.sessionId)!(request);
    assert.deepEqual(noBrowserShell, { kind: "user-not-available" });
    const noBrowserWrite = await adapter.permissions.get(agent.sessionId)!({ kind: "custom-tool", toolCallId: "write-1",
      toolName: "other_tool", toolDescription: "Writes files", args: {} } as PermissionRequest);
    assert.deepEqual(noBrowserWrite, { kind: "user-not-available" });
    await room.setRepository(agent.id, null);
    assert.deepEqual(await adapter.permissions.get(agent.sessionId)!(attachedRequest), { kind: "reject", feedback: "No active repository research grant." });
    await room.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
