import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, execFileSync, type ExecFileOptions } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GitHubRepositories, canonicalGitHubUrl, parseRepoHint } from "../server/github-repositories.js";
import { researchRepository } from "../server/repository.js";

const run = promisify(execFile);
const fixture = (fullName: string, privacy = false) => ({
  full_name: fullName, clone_url: canonicalGitHubUrl(fullName),
  html_url: canonicalGitHubUrl(fullName).slice(0, -4),
  default_branch: "main", private: privacy, size: 2
});
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

test("rejects malformed hints, hostile clone metadata and mismatched identities before cloning", async () => {
  for (const hint of ["https://github.com/Fixture/docs", "file:///tmp/repo", "../escape", "a;b",
    "a/b/c", " space", "repo.git", "a\\b"]) {
    assert.throws(() => parseRepoHint(hint, "Fixture"), /GitHub repository|paths/);
  }
  const source = new GitHubRepositories("/tmp/unused", "Fixture", async () =>
    response({ ...fixture("Other/docs"), clone_url: "file:///private" }));
  await assert.rejects(source.lookup("Fixture/docs"), /noncanonical|identity/);
  const mismatch = new GitHubRepositories("/tmp/unused", "Fixture", async () => response(fixture("Other/docs")));
  await assert.rejects(mismatch.lookup("Fixture/docs"), /identity differs/);
  await assert.rejects(source.provision({ fullName: "Fixture/docs", url: "ssh://github.com/Fixture/docs",
    defaultBranch: "main", privacy: "public", sizeKiB: 2 }), /Clone URL/);
});

test("public lookup needs no gh; ambiguous owner matches require selection and private failures are explicit", async () => {
  const paths: string[] = [];
  const request = async (input: RequestInfo | URL): Promise<Response> => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith("/repos/Fixture/docs")) return response(fixture("Fixture/docs"));
    if (path.endsWith("/repos/Fixture/game")) return response({}, 404);
    if (path.includes("/search/repositories")) return response({ items: [fixture("Fixture/game-one"), fixture("Fixture/game-two")] });
    if (path.endsWith("/repos/Fixture/secret")) return response({}, 404);
    return response({}, 500);
  };
  const git = async (file: string, args: readonly string[]) => {
    if (file !== "gh" || args[1] !== "repos/Fixture/secret") throw new Error("gh unavailable");
    return { stdout: JSON.stringify(fixture("Fixture/secret", true)), stderr: "" };
  };
  const source = new GitHubRepositories("/tmp/unused", "Fixture", request as typeof fetch, git);
  assert.equal((await source.lookup("docs"))[0].fullName, "Fixture/docs");
  assert.equal((await source.lookup("game")).length, 2);
  assert.equal((await source.lookup("Fixture/secret"))[0].privacy, "private");
  assert.ok(paths.every(path => path.startsWith("https://api.github.com/")));
  const unsigned = new GitHubRepositories("/tmp/unused", "Fixture", async () => response({}, 404),
    async () => { throw new Error("not signed in"); });
  await assert.rejects(unsigned.lookup("Fixture/secret"), /gh auth login.*No clone/);
  const offline = new GitHubRepositories("/tmp/unused", "Fixture", (async () => {
    throw new Error("offline");
  }) as typeof fetch);
  await assert.rejects(offline.lookup("docs"), /network access.*No clone/);
});

test("approved public clone uses a bounded GitHub URL, tracked read, cache integrity and distinct worktree source", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentcorp-remote-")));
  try {
    const origin = join(root, "origin");
    execFileSync("git", ["init", "-q", "-b", "main", origin]);
    await writeFile(join(origin, "README.md"), "Remote fixture\n");
    execFileSync("git", ["-C", origin, "add", "README.md"]);
    execFileSync("git", ["-C", origin, "-c", "user.name=Fixture",
      "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    const commands: string[][] = [];
    const mapped = (async (file: string, args: string[], options?: ExecFileOptions) => {
      commands.push([...args]);
      if (args.includes("clone")) {
        const urlIndex = args.indexOf(canonicalGitHubUrl("Fixture/docs"));
        assert.ok(urlIndex >= 0, "only canonical approved HTTPS remote may be cloned");
        const local = [...args];
        local[urlIndex] = `file://${origin}`;
        const output = await run(file, local, { ...options, encoding: "utf8" });
        await run("git", ["-C", args.at(-1)!, "remote", "set-url", "origin", canonicalGitHubUrl("Fixture/docs")]);
        return output;
      }
      return run(file, [...args], { ...options, encoding: "utf8" });
    });
    const source = new GitHubRepositories(join(root, "cache"), "Fixture",
      (async () => response(fixture("Fixture/docs"))) as typeof fetch, mapped);
    const [repo] = await source.lookup("docs");
    const snapshot = await source.provision(repo);
    assert.match(snapshot.path, /\/cache\/Fixture\/docs\//);
    assert.equal(await readFile(join(snapshot.path, "README.md"), "utf8"), "Remote fixture\n");
    assert.match(await researchRepository({ path: snapshot.path, name: snapshot.fullName }, "read", "README.md"), /Remote fixture/);
    assert.equal(commands.filter(command => command.includes("clone")).length, 1);
    assert.deepEqual(commands.find(command => command.includes("clone"))?.slice(0, 7),
      ["-c", "credential.helper=", "clone", "--depth=1", "--single-branch", "--branch", "main"]);
    await source.verify(snapshot);
    await writeFile(join(snapshot.path, "README.md"), "Tampered\n");
    await assert.rejects(source.verify(snapshot), /Cached clone changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
