import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Tool } from "@github/copilot-sdk";

const git = promisify(execFile);
const MAX_FILE = 64 * 1024;
const forbidden = /(^\.|^node_modules$|^vendor$|^dist$|^build$|^(?:private|secrets?|credentials?|tokens?)(?:[._-]|$)|^id_(?:rsa|ed25519)(?:[._-]|$)|\.env(?:\.|$)|\.(?:pem|p12|pfx|key|keystore)$)/i;

export type RepositoryGrant = { path: string; name: string };

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

export function repositoryTool(grant: RepositoryGrant): Tool {
  return {
    name: "research_attached_repository",
    description: `Read-only research in the user's explicitly attached Git repository "${grant.name}". Use action=list with path="" to discover root entries and list a directory's path to navigate; use action=read with a relative tracked file path. This cannot access ignored, hidden, secret-like, symlinked, binary or oversized files; it cannot execute commands or write files. This is distinct from creating office agents.`,
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["list", "read"] }, path: { type: "string" } },
      required: ["action", "path"],
      additionalProperties: false
    },
    handler: async (args: unknown) => {
      if (!args || typeof args !== "object" || !("action" in args) || !("path" in args) ||
        typeof args.action !== "string" || typeof args.path !== "string") throw new Error("Invalid research request.");
      return researchRepository(grant, args.action, args.path);
    }
  };
}
