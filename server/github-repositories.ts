import { execFile, type ExecFileOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { validateRepository } from "./repository.js";

const exec = promisify(execFile);
type RunCommand = (file: string, args: string[], options?: ExecFileOptions) => Promise<{ stdout: string; stderr: string }>;
const slug = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const branch = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/;
const MAX_REPO_KIB = 100_000;
export const CACHE_AGE_MS = 6 * 60 * 60_000;

export type RemoteRepository = {
  fullName: string;
  url: string;
  defaultBranch: string;
  privacy: "public" | "private";
  sizeKiB: number;
};
export type RepositorySnapshot = {
  fullName: string;
  path: string;
  url: string;
  ref: string;
  commit: string;
  privacy: "public" | "private";
  fetchedAt: number;
};
export interface RepositorySource {
  lookup(hint: string): Promise<RemoteRepository[]>;
  provision(repository: RemoteRepository, signal?: AbortSignal): Promise<RepositorySnapshot>;
  verify(snapshot: RepositorySnapshot): Promise<void>;
}

export function parseRepoHint(hint: string, defaultOwner: string): string {
  if (typeof hint !== "string" || hint.length > 200 || hint.trim() !== hint) {
    throw new Error("Use a GitHub repository name or owner/repo, without spaces or a URL.");
  }
  const parts = hint.split("/");
  if (parts.length < 1 || parts.length > 2 || parts.some(part =>
    !slug.test(part) || part === "." || part === ".." || part.endsWith(".git"))) {
    throw new Error("Use a GitHub repository name or owner/repo, without paths, URLs or commands.");
  }
  return `${parts.length === 2 ? parts[0] : defaultOwner}/${parts.at(-1)}`;
}

export function canonicalGitHubUrl(fullName: string): string {
  const parts = fullName.split("/");
  if (parts.length !== 2 || parts.some(part =>
    !slug.test(part) || part === "." || part === ".." || part.endsWith(".git"))) {
    throw new Error("Invalid GitHub repository identity.");
  }

  return `https://github.com/${parts[0]}/${parts[1]}.git`;
}

export function validateRemoteRepository(repository: RemoteRepository): RemoteRepository {
  if (!repository || typeof repository.fullName !== "string" ||
    canonicalGitHubUrl(repository.fullName) !== repository.url ||
    typeof repository.defaultBranch !== "string" || !branch.test(repository.defaultBranch) ||
    repository.defaultBranch.includes("..") || repository.defaultBranch.includes("//") ||
    repository.defaultBranch.endsWith("/") || repository.defaultBranch.endsWith(".lock") ||
    !["public", "private"].includes(repository.privacy) ||
    typeof repository.sizeKiB !== "number" || !Number.isFinite(repository.sizeKiB) ||
    repository.sizeKiB < 0) throw new Error("Invalid verified GitHub repository identity or default branch.");
  return repository;
}

function metadata(value: unknown, expected?: string): RemoteRepository {
  if (!value || typeof value !== "object") throw new Error("GitHub returned invalid repository metadata.");
  const data = value as Record<string, unknown>;
  if (typeof data.full_name !== "string" || typeof data.default_branch !== "string" ||
    !branch.test(data.default_branch) || data.default_branch.includes("..") ||
    data.default_branch.includes("//") || data.default_branch.endsWith("/") ||
    data.default_branch.endsWith(".lock") || typeof data.private !== "boolean" ||
    typeof data.size !== "number" || !Number.isFinite(data.size) || data.size < 0) {
    throw new Error("GitHub returned incomplete repository identity, default branch or privacy metadata.");
  }
  const url = canonicalGitHubUrl(data.full_name);
  if (expected && data.full_name.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("GitHub repository identity differs from the requested owner/repo.");
  }
  if (data.clone_url !== url || data.html_url !== url.slice(0, -4)) {
    throw new Error("GitHub returned a noncanonical clone or source URL; refusing this repository.");
  }
  return validateRemoteRepository({ fullName: data.full_name, url, defaultBranch: data.default_branch,
    privacy: data.private ? "private" : "public", sizeKiB: data.size });
}

export class GitHubRepositories implements RepositorySource {
  constructor(
    private readonly root: string,
    private readonly owner: string,
    private readonly request: typeof fetch = fetch,
    private readonly run: RunCommand = exec,
  ) {
    if (!slug.test(owner) || owner === "." || owner === "..") throw new Error("Invalid GitHub owner from repository origin.");
  }

  static async open(root: string, project: string): Promise<GitHubRepositories> {
    const { stdout } = await exec("git", ["-C", project, "remote", "get-url", "origin"], { timeout: 5000 });
    const origin = stdout.trim().match(/^https:\/\/github\.com\/([^/]+)\/[^/]+\.git$/i);
    if (!origin) throw new Error("Set this harness's origin to a GitHub HTTPS repository to resolve short repo names.");
    return new GitHubRepositories(root, origin[1]);
  }

  private async api(path: string): Promise<{ status: number; data: unknown }> {
    const url = `https://api.github.com/${path}`;
    try {
      const response = await this.request(url, { headers: {
        Accept: "application/vnd.github+json", "User-Agent": "agentcorp-harness-local"
      }, signal: AbortSignal.timeout(10_000) });
      if (response.status !== 200) return { status: response.status, data: null };
      return { status: response.status, data: await response.json() as unknown };
    } catch {
      throw new Error("Cannot reach GitHub metadata; check network access and retry. No clone was attempted.");
    }
  }

  private async authenticated(fullName: string): Promise<RemoteRepository> {
    try {
      const { stdout } = await this.run("gh", ["api", `repos/${fullName}`], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      return metadata(JSON.parse(stdout) as unknown, fullName);
    } catch {
      throw new Error(`Cannot inspect ${fullName}. If it is private, run "gh auth login" with repository access, then retry. Otherwise check the owner/repo. No clone was attempted.`);
    }
  }

  async lookup(hint: string): Promise<RemoteRepository[]> {
    const fullName = parseRepoHint(hint, this.owner);
    const exact = await this.api(`repos/${fullName}`);
    if (exact.status === 200) return [metadata(exact.data, fullName)];
    if (exact.status === 403 || exact.status === 429) throw new Error(`GitHub metadata lookup is limited or offline (HTTP ${exact.status}); retry later. No clone was attempted.`);
    if (exact.status !== 404) throw new Error(`GitHub repository lookup failed (HTTP ${exact.status}); no clone was attempted.`);
    if (hint.includes("/")) return [await this.authenticated(fullName)];
    try {
      return [await this.authenticated(fullName)];
    } catch {
      // Public search can still find related repositories when gh is not installed.
    }
    const search = await this.api(`search/repositories?q=${encodeURIComponent(`${hint} in:name user:${this.owner}`)}&per_page=8`);
    if (search.status === 200) {
      const items = (search.data as { items?: unknown[] }).items;
      if (!Array.isArray(items)) throw new Error("GitHub returned invalid repository search results.");
      const candidates = items.slice(0, 8).map(item => metadata(item))
        .filter(item => item.fullName.toLowerCase().startsWith(`${this.owner.toLowerCase()}/`));
      if (candidates.length) return candidates;
    } else if (search.status !== 404) {
      throw new Error(`GitHub repository search failed (HTTP ${search.status}); no clone was attempted.`);
    }
    return [await this.authenticated(fullName)];
  }

  async verify(snapshot: RepositorySnapshot): Promise<void> {
    const expected = canonicalGitHubUrl(snapshot.fullName);
    const cacheRoot = await realpath(this.root);
    if (snapshot.url !== expected || !snapshot.path.startsWith(`${cacheRoot}${sep}`) ||
      (await validateRepository(snapshot.path)).path !== snapshot.path) {
      throw new Error("Cached clone moved or has an invalid Git root.");
    }
    const [remote, commit, status] = await Promise.all([
      this.run("git", ["-C", snapshot.path, "remote", "get-url", "origin"], { timeout: 5000 }),
      this.run("git", ["-C", snapshot.path, "rev-parse", "HEAD"], { timeout: 5000 }),
      this.run("git", ["-C", snapshot.path, "status", "--porcelain"], { timeout: 5000 })
    ]);
    if (remote.stdout.trim() !== expected || commit.stdout.trim() !== snapshot.commit || status.stdout.trim()) {
      throw new Error("Cached clone changed or has local edits; refusing to reuse it. Review the preserved folder manually.");
    }
  }

  async provision(repository: RemoteRepository, signal?: AbortSignal): Promise<RepositorySnapshot> {
    const url = canonicalGitHubUrl(repository.fullName);
    if (url !== repository.url) throw new Error("Clone URL does not match the approved GitHub repository.");
    if (repository.sizeKiB > MAX_REPO_KIB) {
      throw new Error(`${repository.fullName} is over the 100 MB metadata limit; no clone was attempted.`);
    }
    const [owner, name] = repository.fullName.split("/");
    const parent = join(this.root, owner, name);
    await mkdir(parent, { recursive: true });
    if (await realpath(parent) !== parent) throw new Error("Clone cache parent must not be a symlink.");
    const destination = join(parent, randomUUID());
    const auth = repository.privacy === "private" ? ["-c", "credential.helper=!gh auth git-credential"] :
      ["-c", "credential.helper="];
    try {
      await this.run("git", [...auth, "clone", "--depth=1", "--single-branch", "--branch",
        repository.defaultBranch, "--", url, destination], {
        timeout: 120_000, maxBuffer: 1024 * 1024, signal,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "",
          GIT_TEMPLATE_DIR: "/dev/null" }
      });
    } catch (error) {
      throw new Error(`Could not clone ${repository.fullName} into ${destination}. ${
        repository.privacy === "private" ? 'Run "gh auth login" with access to this repo and retry.' :
          "Check network access and retry."} Any partial directory is preserved for inspection.${
            error instanceof Error && error.name === "AbortError" ? " Clone was cancelled." : ""}`);
    }
    const { stdout } = await this.run("git", ["-C", destination, "rev-parse", "HEAD"], { timeout: 5000 });
    const snapshot: RepositorySnapshot = {
      fullName: repository.fullName, path: destination, url, ref: repository.defaultBranch,
      commit: stdout.trim(), privacy: repository.privacy, fetchedAt: Date.now()
    };
    await this.verify(snapshot);
    return snapshot;
  }
}
