import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "agentcorp-observer-"));
process.env.COPILOT_HOME = directory;
const { heartbeat, enroll, snapshot, clearHeartbeat, MAX_DESKS, EXPIRY_MS } =
  await import("../.github/extensions/agentcorp-observer/observations.mjs");

test("only the activated root is visible without explicit membership", async () => {
  await heartbeat("root", "idle", "root-owner", 1000);
  await heartbeat("unrelated", "tool", "other-owner", 1000);
  assert.deepEqual(await snapshot("root", 1000), {
    root: "root", sessions: [{ id: "root", phase: "idle", present: true }],
  });
});

test("explicit children and grandchildren appear; unrelated and unlinked sessions do not", async () => {
  await enroll("root", "root", "child");
  await assert.rejects(enroll("root", "unrelated", "intruder"), /Parent must already/);
  await enroll("root", "child", "grandchild");
  await heartbeat("child", "thinking", "child-owner", 1000);
  await heartbeat("grandchild", "blocked", "grandchild-owner", 1000);
  const result = await snapshot("root", 1000);
  assert.deepEqual(result.sessions, [
    { id: "root", phase: "idle", present: true },
    { id: "child", phase: "thinking", present: true },
    { id: "grandchild", phase: "blocked", present: true },
  ]);
  assert.equal(JSON.stringify(result).includes("unrelated"), false);
});

test("stale, missing, and stopped participants are offline without fabricated activity", async () => {
  const result = await snapshot("root", 1000 + EXPIRY_MS + 1);
  assert.ok(result.sessions.every(member => member.phase === "offline" && !member.present));
  await heartbeat("root", "tool", "new-owner", 1000);
  await clearHeartbeat("root", "old-owner");
  assert.equal((await snapshot("root", 1000)).sessions[0].phase, "tool");
  await clearHeartbeat("root", "new-owner");
  assert.equal((await snapshot("root", 1000)).sessions[0].phase, "offline");
  await heartbeat("root", "offline", "new-owner", 1000);
  assert.deepEqual((await snapshot("root", 1000)).sessions[0],
    { id: "root", phase: "offline", present: false });
});

test("membership is capped and rejects duplicate or invalid descendants", async () => {
  await assert.rejects(enroll("root", "root", "child"), /already enrolled/);
  await assert.rejects(enroll("root", "root", "../escape"), /Invalid session ID/);
  for (let i = 3; i < MAX_DESKS; i++) await enroll("root", "root", `child-${i}`);
  await assert.rejects(enroll("root", "root", "overflow"), /Office is full/);
  assert.equal((await snapshot("root")).sessions.length, MAX_DESKS);
});

test.after(async () => { await rm(directory, { recursive: true, force: true }); });
