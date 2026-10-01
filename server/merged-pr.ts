import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type MergedPullRequest = { repository: string; number: number; mergeSha: string; mergedAt: number };

export async function verifyMergedPullRequest(repository: string, number: number): Promise<MergedPullRequest> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(number) || number < 1) throw new Error("Provide a valid owner/repo and PR number.");
  const { stdout } = await exec("gh", ["api", `repos/${repository}/pulls/${number}`],
    { timeout: 10_000, maxBuffer: 262_144 });
  const result: unknown = JSON.parse(stdout);
  if (!result || typeof result !== "object" || !("base" in result) || !("merged_at" in result) ||
    !("merge_commit_sha" in result) || !("number" in result)) throw new Error("GitHub PR response is incomplete.");
  const pr = result as { base?: { repo?: { full_name?: string } }; merged_at?: string | null;
    merge_commit_sha?: string | null; number?: number };
  const mergedAt = Date.parse(pr.merged_at ?? "");
  if (pr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
    pr.number !== number || !Number.isFinite(mergedAt) || mergedAt > Date.now() ||
    !pr.merge_commit_sha || !/^[a-f0-9]{40}$/i.test(pr.merge_commit_sha)) {
    throw new Error("GitHub did not verify a merged PR in the attributed repository.");
  }
  return { repository: pr.base.repo.full_name, number, mergeSha: pr.merge_commit_sha, mergedAt };
}
