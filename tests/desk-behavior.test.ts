import assert from "node:assert/strict";
import { test } from "node:test";
import { DESK_IDLE_MS, deskPresence, nextDeskBreak } from "../agent-inc/game/desk-behavior.js";

test("idle agents stay seated for two full minutes before taking a break", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const idleSince = Date.now();
  assert.equal(deskPresence("idle", idleSince, Date.now()), "waiting");
  assert.equal(nextDeskBreak([{ status: "idle", idleSince }], Date.now()), idleSince + DESK_IDLE_MS);

  t.mock.timers.setTime(idleSince + 119_000);
  assert.equal(deskPresence("idle", idleSince, Date.now()), "waiting");
  t.mock.timers.setTime(idleSince + 119_999);
  assert.equal(deskPresence("idle", idleSince, Date.now()), "waiting");
  t.mock.timers.setTime(idleSince + 120_000);
  assert.equal(deskPresence("idle", idleSince, Date.now()), "break");
  assert.equal(nextDeskBreak([{ status: "idle", idleSince }], Date.now()), Infinity);
});

test("streaming phases, blocked status and roster updates never reset the idle clock", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
  const snapshot = { status: "idle" as const, idleSince: Date.now(), updatedAt: Date.now() };
  t.mock.timers.setTime(snapshot.idleSince + 90_000);
  const rosterUpdate = { ...snapshot, updatedAt: Date.now() };
  assert.equal(deskPresence(rosterUpdate.status, rosterUpdate.idleSince, Date.now()), "waiting");
  assert.equal(deskPresence("thinking", rosterUpdate.idleSince, Date.now()), "working");
  assert.equal(deskPresence("tool", rosterUpdate.idleSince, Date.now()), "working");
  assert.equal(deskPresence("blocked", rosterUpdate.idleSince, Date.now()), "working");
  assert.equal(nextDeskBreak([{ status: "blocked", idleSince: snapshot.idleSince }], Date.now()), Infinity);
  assert.equal(deskPresence("offline", rosterUpdate.idleSince, Date.now()), "unavailable");
  t.mock.timers.setTime(snapshot.idleSince + 120_000);
  const reloaded = JSON.parse(JSON.stringify(rosterUpdate)) as typeof snapshot;
  assert.equal(deskPresence(reloaded.status, reloaded.idleSince, Date.now()), "break");
  const resumedAt = Date.now();
  assert.equal(deskPresence("idle", resumedAt, Date.now()), "waiting");
  assert.equal(nextDeskBreak([{ status: "idle", idleSince: resumedAt }], Date.now()), resumedAt + DESK_IDLE_MS);
});

test("next break is the earliest pending idle deadline", () => {
  assert.equal(nextDeskBreak([
    { status: "idle", idleSince: 10_000 },
    { status: "idle", idleSince: 3_000 },
    { status: "tool" },
  ], 20_000), 123_000);
  assert.throws(() => deskPresence("idle", undefined, 20_000), /idle start time/);
});
