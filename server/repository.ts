import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Tool } from "@github/copilot-sdk";
import type { RepositorySnapshot } from "./github-repositories.js";

const git = promisify(execFile);
const MAX_FILE = 64 * 1024;
const forbidden = /(^\.|^node_modules$|^vendor$|^dist$|^build$|^(?:private|secrets?|credentials?|tokens?)(?:[._-]|$)|^id_(?:rsa|ed25519)(?:[._-]|$)|\.env(?:\.|$)|\.(?:pem|p12|pfx|key|keystore)$)/i;

export type RepositoryGrant = { path: string; name: string; scope?: "task" | "session" | "edit";
  worktree?: { path: string; branch: string }; remote?: RepositorySnapshot };
export type AccessIntent = { repoHint: string; purpose: string; scope: "read" | "edit" };

export async function createResearchWorktree(root: string, grant: RepositoryGrant, agentId: string): Promise<RepositoryGrant> {
  const checked = await validateRepository(grant.path);
  if (checked.path !== grant.path) throw new Error("Repository root changed; refusing to create a worktree.");
  const branch = `agentcorp/${agentId}/${randomUUID()}`;
  const parent = join(root, agentId);
  await mkdir(parent, { recursive: true });
  if (await realpath(parent) !== parent) throw new Error("Worktree parent must not be a symlink.");
  const destination = join(parent, branch.split("/").at(-1)!);
  await git("git", ["-C", grant.path, "worktree", "add", "-b", branch, destination, "HEAD"], { timeout: 15000 });
  const actual = await realpath(destination);
  if (actual !== destination) throw new Error(`Worktree was created at ${actual}, not the expected path. Inspect it manually; no files were deleted.`);
  return { ...grant, scope: "edit", worktree: { path: actual, branch } };
}

export async function validateResearchWorktree(grant: RepositoryGrant): Promise<void> {
  const tree = grant.worktree;
  if (!tree) return;
  if (await realpath(tree.path) !== tree.path) throw new Error("Isolated worktree moved or became a symlink; refusing to resume.");
  if ((await validateRepository(tree.path)).path !== tree.path) throw new Error("Isolated worktree is no longer a Git worktree.");
  const [original, attached, branch] = await Promise.all([
    git("git", ["-C", grant.path, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5000 }),
    git("git", ["-C", tree.path, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5000 }),
    git("git", ["-C", tree.path, "symbolic-ref", "--short", "HEAD"], { timeout: 5000 })
  ]);
  if (await realpath(original.stdout.trim()) !== await realpath(attached.stdout.trim()) ||
    branch.stdout.trim() !== tree.branch) {
    throw new Error("Saved worktree no longer belongs to its approved repository/branch; refusing to resume.");
  }
}

export async function validateRepository(path: string): Promise<RepositoryGrant> {
  if (!isAbsolute(path)) throw new Error("Enter an absolute path to a local Git repository.");
  const root = await realpath(path);
  const { stdout } = await git("git", ["-C", root, "rev-parse", "--show-toplevel"], { timeout: 5000 });
  if (await realpath(stdout.trim()) !== root) throw new Error("Select the Git repository root, not a subfolder.");
  return { path: root, name: basename(root) };
}

function safeRelative(path: string): string {
  if (typeof path !== "string" || path.length > 500 || path.includes("\0") || path.includes("\\") || isAbsolute(path)) {
    throw new Error("Use a relative repository path.");
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.some(part => part === ".." || part === "." || forbidden.test(part))) {
    throw new Error("Hidden, ignored, private or sensitive paths are not available to the research tool.");
  }
  return parts.join("/");
}

async function tracked(root: string): Promise<string[]> {
  const { stdout } = await git("git", ["-C", root, "ls-files", "-z", "--stage"], {
    encoding: "buffer", timeout: 10000, maxBuffer: 4 * 1024 * 1024
  });
  const entries = stdout.toString("utf8").split("\0").filter(Boolean);
  if (entries.length > 10000) throw new Error("Repository exceeds the research tool's 10,000-file limit.");
  const candidates = entries.flatMap(entry => {
    if (!entry.startsWith("100") || !entry.includes("\t")) return [];
    const path = entry.slice(entry.indexOf("\t") + 1);
    try { return safeRelative(path) === path ? [path] : []; } catch { return []; }
  });
  if (!candidates.length) return [];
  const ignored = await new Promise<Set<string>>((resolveResult, reject) => {
    const child = spawn("git", ["-C", root, "check-ignore", "--no-index", "-z", "--stdin"]);
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", chunk => output.push(chunk as Buffer));
    child.stderr.on("data", chunk => errors.push(chunk as Buffer));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0 && code !== 1) reject(new Error(`Could not check ignored repository paths: ${Buffer.concat(errors).toString("utf8")}`));
      else resolveResult(new Set(Buffer.concat(output).toString("utf8").split("\0").filter(Boolean)));
    });
    child.stdin.end(`${candidates.join("\0")}\0`);
  });
  return candidates.filter(path => !ignored.has(path));
}

export async function researchRepository(grant: RepositoryGrant, action: string, path: string): Promise<string> {
  if (await realpath(grant.path) !== grant.path) throw new Error("Granted repository moved or became a symlink; access revoked until reselected.");
  const relativePath = safeRelative(path);
  const files = await tracked(grant.path);
  if (action === "list") {
    const matches = files.filter(file => !relativePath || file.startsWith(`${relativePath}/`) || file === relativePath);
    const entries = new Map<string, "directory" | "file">();
    for (const file of matches) {
      const suffix = relativePath && file !== relativePath ? file.slice(relativePath.length + 1) : file;
      const next = suffix.split("/")[0];
      const name = relativePath && file === relativePath ? relativePath : relativePath ? `${relativePath}/${next}` : next;
      entries.set(name, suffix.includes("/") ? "directory" : "file");
    }
    const children = [...entries].map(([name, kind]) => ({ path: name, kind }));
    return JSON.stringify({ repository: grant.name, directory: relativePath || ".",
      entries: children.slice(0, 100), remaining: Math.max(0, children.length - 100) });
  }
  if (action !== "read" || !relativePath || !files.includes(relativePath)) {
    throw new Error("Read requires an exact tracked, non-sensitive file path; list files first.");
  }
  const file = resolve(grant.path, relativePath);
  if (!file.startsWith(`${grant.path}${sep}`)) throw new Error("Path escapes the granted repository.");
  let parent = grant.path;
  for (const part of relativePath.split("/").slice(0, -1)) {
    parent = resolve(parent, part);
    if (!(await lstat(parent)).isDirectory()) throw new Error("Symlinked directories are not readable.");
  }
  const actual = await realpath(file);
  if (actual !== file) throw new Error("Symlinked files are not readable.");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE) throw new Error("Only regular text files up to 64 KiB may be read.");
    const content = await handle.readFile("utf8");
    if (content.includes("\0")) throw new Error("Binary files are not readable.");
    return JSON.stringify({ repository: grant.name, path: relativePath, content });
  } finally {
    await handle.close();
  }
}

export function repositoryTool(getGrant: (fullName: string) => Promise<RepositoryGrant | undefined>): Tool {
  return {
    name: "research_attached_repository",
    description: "Read tracked files in an authorized GitHub repository. Always specify its exact owner/repo identity as repository, even when only one is available. Use action=list with path=\"\" to discover root entries, and action=read with a relative tracked file path. If access is not granted, call request_repository_access. This tool cannot read ignored, hidden, secret-like, symlinked, binary or oversized files or write anything.",
    parameters: {
      type: "object",
      properties: { repository: { type: "string" }, action: { type: "string", enum: ["list", "read"] }, path: { type: "string" } },
      required: ["repository", "action", "path"],
      additionalProperties: false
    },
    handler: async (args: unknown) => {
      if (!args || typeof args !== "object" || !("repository" in args) || !("action" in args) || !("path" in args) ||
        typeof args.repository !== "string" || typeof args.action !== "string" || typeof args.path !== "string") throw new Error("Invalid research request.");
      const grant = await getGrant(args.repository);
      if (!grant) throw new Error("No effective read access to this verified GitHub repository. Request access first.");
      const identity = JSON.stringify([grant.path, grant.name, grant.remote?.url, grant.remote?.ref,
        grant.remote?.commit, grant.worktree?.path, grant.worktree?.branch]);
      const result = await researchRepository(grant.worktree ? { ...grant, path: grant.worktree.path } : grant, args.action, args.path);
      const current = await getGrant(args.repository);
      if (!current || JSON.stringify([current.path, current.name, current.remote?.url, current.remote?.ref,
        current.remote?.commit, current.worktree?.path, current.worktree?.branch]) !== identity) {
        throw new Error("Repository access was revoked while research was running or its identity changed.");
      }
      return result;
    }
  };
}

export function repositoryRequestTool(request: (intent: AccessIntent) => Promise<string>): Tool {
  return {
    name: "request_repository_access",
    description: "When a task needs an unavailable GitHub repository, call this tool immediately rather than saying it is unavailable. Provide an owner/repo or repository name hint, specific purpose, and intended read/edit scope. The user reviews verified GitHub identity, branch and privacy before any automatic clone into this app's ignored cache. Never guess a local path or claim access before approval. Edit creates an isolated worktree; all shell/write calls still require individual permission.",
    parameters: {
      type: "object",
      properties: {
        repoHint: { type: "string" }, purpose: { type: "string" },
        scope: { type: "string", enum: ["read", "edit"] }
      },
      required: ["repoHint", "purpose", "scope"], additionalProperties: false
    },
    handler: async (args: unknown) => {
      if (!args || typeof args !== "object" || !("repoHint" in args) || !("purpose" in args) || !("scope" in args) ||
        typeof args.repoHint !== "string" || typeof args.purpose !== "string" ||
        (args.scope !== "read" && args.scope !== "edit") ||
        args.repoHint.length > 150 || !args.repoHint.trim() || args.purpose.length > 500 || !args.purpose.trim()) {
        throw new Error("Provide a repository hint, purpose, and read/edit scope.");
      }
      return request({ repoHint: args.repoHint, purpose: args.purpose, scope: args.scope });
    }
  };
}
