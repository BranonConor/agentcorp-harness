import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_DESKS = 16;
export const EXPIRY_MS = 45_000;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const phases = new Set(["idle", "thinking", "tool", "blocked", "offline"]);
const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
export const dataDir = join(home, "extensions", "agentcorp-observer", "artifacts");

export function validId(id) {
  if (typeof id !== "string" || !idPattern.test(id)) throw new Error("Invalid session ID.");
  return id;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function save(path, value) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

const heartbeatPath = id => join(dataDir, `heartbeat-${validId(id)}.json`);
const graphPath = id => join(dataDir, `root-${validId(id)}.json`);

export async function heartbeat(id, phase, owner, now = Date.now()) {
  validId(id);
  if (!phases.has(phase)) throw new Error("Invalid phase.");
  await save(heartbeatPath(id), { id, phase, owner, at: now });
}

export async function clearHeartbeat(id, owner) {
  const entry = await readJson(heartbeatPath(id));
  if (entry?.owner === owner) await rm(heartbeatPath(id), { force: true });
}

export async function enroll(root, parent, child) {
  validId(root);
  validId(parent);
  validId(child);
  if (child === root || child === parent) throw new Error("A session cannot enroll itself.");
  const path = graphPath(root);
  const graph = await readJson(path);
  if (graph !== null && (graph.root !== root || !Array.isArray(graph.links))) throw new Error("Invalid office membership record.");
  const links = graph?.links ?? [];
  if (parent !== root && !links.some(link => link.child === parent)) throw new Error("Parent must already be enrolled in this office.");
  if (links.some(link => link.child === child)) throw new Error("Session is already enrolled in this office.");
  if (links.length >= MAX_DESKS - 1) throw new Error("Office is full (16 desks).");
  await save(path, { root, links: [...links, { parent, child }] });
}

export async function snapshot(root, now = Date.now()) {
  validId(root);
  const graph = await readJson(graphPath(root));
  if (graph !== null && (graph.root !== root || !Array.isArray(graph.links))) throw new Error("Invalid office membership record.");
  const ids = [root];
  for (const link of graph?.links ?? []) {
    if (ids.length >= MAX_DESKS) break;
    if (ids.includes(link.parent) && !ids.includes(link.child) && idPattern.test(link.child)) ids.push(link.child);
  }
  const entries = await Promise.all(ids.map(async id => {
    const entry = await readJson(heartbeatPath(id));
    const live = entry?.id === id && entry.phase !== "offline" && phases.has(entry.phase) && Number.isFinite(entry.at) &&
      entry.at <= now && now - entry.at <= EXPIRY_MS;
    return { id, phase: live ? entry.phase : "offline", present: !!live };
  }));
  return { root, sessions: entries };
}
