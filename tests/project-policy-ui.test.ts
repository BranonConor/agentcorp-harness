import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveProjectAccess, groupedProjectAccess, type ProjectPolicy } from "../agent-inc-live/src/room.js";

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

test("write eligibility implies read but never follows assignment or exclusion", () => {
  assert.equal(effectiveProjectAccess(projects, [{ fullName: "Owner/Scoped", read: true, write: true, excluded: false }])[1].write, true);
  assert.equal(effectiveProjectAccess(projects, [], { remote: { fullName: "Owner/Scoped" }, scope: "edit" })[1].write, false);
  const shared = [{ ...projects[0], sharedWrite: true }];
  assert.deepEqual(effectiveProjectAccess(shared)[0].write, true);
  assert.equal(effectiveProjectAccess(shared, [{ fullName: "Owner/Shared", read: false, excluded: true }])[0].write, false);
});

test("project groups follow global sharing without inventing edit permissions", () => {
  const access = effectiveProjectAccess(projects, [
    { fullName: "Owner/Shared", read: false, excluded: true },
    { fullName: "Owner/Scoped", read: true, excluded: false },
  ]);
  const groups = groupedProjectAccess(access);
  assert.deepEqual(groups.agent.map(item => [item.project.repository.fullName, item.read]),
    [["Owner/Scoped", true]]);
  assert.deepEqual(groups.global.map(item => [item.project.repository.fullName, item.read]),
    [["Owner/Shared", false]]);
});

test("global worktree eligibility is grouped globally even without global read", () => {
  const access = effectiveProjectAccess([{ ...projects[1], sharedWrite: true }]);
  assert.deepEqual(groupedProjectAccess(access).global.map(item => [item.read, item.write]), [[true, true]]);
  assert.deepEqual(groupedProjectAccess(access).agent, []);
});
