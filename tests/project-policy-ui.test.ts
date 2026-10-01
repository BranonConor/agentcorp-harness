import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveProjectAccess, type ProjectPolicy } from "../agent-inc-live/src/room.js";

const projects: ProjectPolicy[] = [
  { repository: { fullName: "Owner/Shared", url: "https://github.com/Owner/Shared.git",
    defaultBranch: "main", privacy: "private", sizeKiB: 10 }, sharedRead: true },
  { repository: { fullName: "Owner/Scoped", url: "https://github.com/Owner/Scoped.git",
    defaultBranch: "main", privacy: "public", sizeKiB: 10 }, sharedRead: false },
];

test("office read applies by default while unshared catalog entries do not", () => {
  assert.deepEqual(effectiveProjectAccess(projects).map(item => [item.read, item.source]),
    [[true, "office"], [false, "none"]]);
});

test("persona grants, removal and exclusion resolve independently of office sharing", () => {
  const policies = [
    { fullName: "owner/SHARED", read: true, excluded: true },
    { fullName: "Owner/Scoped", read: true, excluded: false },
  ];
  assert.deepEqual(effectiveProjectAccess(projects, policies).map(item => [item.read, item.source]),
    [[false, "excluded"], [true, "persona"]]);
  policies[0] = { fullName: "owner/SHARED", read: true, excluded: false };
  assert.deepEqual(effectiveProjectAccess(projects, policies).map(item => [item.read, item.source]),
    [[true, "persona"], [true, "persona"]]);
  policies[1] = { fullName: "Owner/Scoped", read: false, excluded: false };
  assert.equal(effectiveProjectAccess(projects, policies)[1].read, false);
});

test("assignment-only read is shown and explicit exclusion hides it", () => {
  const assignment = { remote: { fullName: "Owner/Scoped" }, scope: "task" };
  assert.deepEqual(effectiveProjectAccess(projects, [], assignment).map(item => [item.read, item.source]),
    [[true, "office"], [true, "assignment"]]);
  assert.equal(effectiveProjectAccess(projects,
    [{ fullName: "Owner/Scoped", read: false, excluded: true }], assignment)[1].source, "excluded");
});
