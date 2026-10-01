import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repositoryTool, researchRepository, validateRepository } from "../server/repository.js";

test("research tool reads only bounded tracked text, refuses secrets, untracked files and symlink escapes", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agentcorp-research-"));
  const root = join(parent, "repo");
  try {
    await mkdir(root);
    execFileSync("git", ["init", "-q", root]);
    await mkdir(join(root, "src"));
    await mkdir(join(root, "private"));
    await writeFile(join(root, "src", "summary.md"), "# Safe tracked summary");
    await writeFile(join(root, "private", "notes.txt"), "not for research");
    await writeFile(join(root, ".env"), "TEST_PLACEHOLDER=not-a-real-secret");
    await writeFile(join(root, "secrets.json"), "{\"example\":\"not a real secret\"}");
    await writeFile(join(root, "scratch.txt"), "untracked");
    await writeFile(join(root, ".gitignore"), "forced-ignored.txt\n");
    await writeFile(join(root, "forced-ignored.txt"), "not for research");
    await writeFile(join(root, "large.txt"), "a".repeat(65 * 1024));
    await writeFile(join(root, "binary.dat"), "text\0binary");
    await writeFile(join(parent, "outside.txt"), "outside repo");
    await symlink(join(parent, "outside.txt"), join(root, "escape.txt"));
    await symlink(parent, join(root, "src", "linked"));
    execFileSync("git", ["-C", root, "add", "src/summary.md", "private/notes.txt", ".env", "secrets.json", "large.txt", "binary.dat", "escape.txt", "src/linked"]);
    execFileSync("git", ["-C", root, "add", "-f", "forced-ignored.txt"]);
    const grant = await validateRepository(root);
    assert.equal(grant.path, await realpath(root));
    const listing = JSON.parse(await researchRepository(grant, "list", "")) as { entries: { path: string; kind: string }[] };
    assert.ok(listing.entries.some(item => item.path === "src" && item.kind === "directory"));
    const srcListing = JSON.parse(await researchRepository(grant, "list", "src")) as { entries: { path: string }[] };
    assert.ok(srcListing.entries.some(item => item.path === "src/summary.md"));
    for (const excluded of [".env", "secrets.json", "private/notes.txt", "scratch.txt", "src/linked", "forced-ignored.txt"]) {
      assert.equal(listing.entries.some(item => item.path === excluded) ||
        srcListing.entries.some(item => item.path === excluded), false);
      await assert.rejects(researchRepository(grant, "read", excluded));
    }
    assert.match(await researchRepository(grant, "read", "src/summary.md"), /Safe tracked summary/);
    let allowed = true;
    let checks = 0;
    const tool = repositoryTool(async identity => {
      checks++;
      if (checks === 2) allowed = false;
      return identity === "Fixture/fixture" && allowed ? grant : undefined;
    });
    await assert.rejects(async () => tool.handler!({ repository: "Fixture/fixture", action: "read", path: "src/summary.md" },
      {} as never), /revoked while research/);
    assert.equal(checks, 2, "policy checked both before and after an in-flight read");
    await assert.rejects(async () => tool.handler!({ repository: "Fixture/other", action: "list", path: "" },
      {} as never), /No effective read access/);
    await assert.rejects(researchRepository(grant, "read", "escape.txt"), /exact tracked/);
    await assert.rejects(researchRepository(grant, "read", "large.txt"), /64 KiB/);
    await assert.rejects(researchRepository(grant, "read", "binary.dat"), /Binary/);
    for (const escape of ["../outside.txt", "/etc/passwd", "src/../../outside.txt", ".git/config"]) {
      await assert.rejects(researchRepository(grant, "read", escape));
    }
    await assert.rejects(validateRepository(join(root, "src")), /root/);
    await assert.rejects(validateRepository("relative/repo"), /absolute/);
    const alias = join(parent, "repo-alias");
    await symlink(root, alias);
    assert.equal((await validateRepository(alias)).path, await realpath(root));
    await assert.rejects(researchRepository({ path: alias, name: "alias" }, "list", ""), /symlink/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
