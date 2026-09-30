export type AgentState = "idle" | "walking" | "working" | "returning";
export type RequestStatus = "queued" | "assigned" | "working" | "complete" | "failed";
export type RequestKind = "chat" | "context";
export type Point = { x: number; z: number };
export type AgentLevels = { speed: number; accuracy: number };

export type Request = {
  id: number;
  stationId: number;
  title: string;
  kind: RequestKind;
  status: RequestStatus;
  agentId?: number;
  reward: number;
  progress: number;
  loss?: number;
  resolvedAt?: number;
};

export type Agent = {
  id: number;
  state: AgentState;
  x: number;
  z: number;
  target: Point;
  route: Point[];
  taskId?: number;
  workLeft: number;
  workTotal: number;
  visitedContext: boolean;
};

export type Progress = {
  version: 1;
  tokens: number;
  capacity: number;
  context: boolean;
  workflow: number;
  stationLevels: number[];
  agentLevels: AgentLevels[];
  completed: number;
  errors: number;
  earned: number;
  seed: number;
  nextId: number;
  savedAt: number;
};

export type OfflineReport = { seconds: number; completed: number; tokens: number };

const CONTEXT: Point = { x: 3.0, z: -1.8 };
export const COFFEE_SPOTS: readonly Point[] = [
  { x: -1.55, z: 4.3 }, { x: -0.52, z: 4.3 },
  { x: 0.52, z: 4.3 }, { x: 1.55, z: 4.3 },
];
export const DESKS: readonly Point[] = [
  { x: -1, z: 0.15 },
  { x: 0.85, z: 0.15 },
  { x: -2.35, z: 1.75 },
  { x: 2.25, z: 1.75 },
];
const CHAT_REQUESTS = [
  "Why does the moon glow?",
  "Tell me a little story",
  "What makes rain fall?",
  "Explain how bees dance",
  "How do seeds grow?",
  "Describe a perfect afternoon",
];
const CONTEXT_REQUESTS = [
  "Compare these two ideas",
  "Remember the earlier details",
  "Summarize a long conversation",
  "Connect the clues together",
];

export const CAPACITY_COST = 28;
export const CONTEXT_COST = 64;
export const MAX_CAPACITY = 4;
export const MAX_WORKFLOW = 3;
export const MAX_STATION_LEVEL = 3;
export const MAX_AGENT_LEVEL = 3;
export const PERSONAS = [
  { name: "Mica", role: "Curious storyteller", accent: "#78bea6" },
  { name: "Soli", role: "Patient explainer", accent: "#b49ccc" },
  { name: "Nell", role: "Careful researcher", accent: "#d99586" },
  { name: "Ori", role: "Bright brainstormer", accent: "#d9bc78" },
] as const;
export const workflowCost = (level: number) => 46 * (level + 1);
export const stationCost = (level: number) => 42 + level * 36;
export const agentCost = (stat: keyof AgentLevels, level: number) =>
  (stat === "speed" ? 34 : 42) + level * (stat === "speed" ? 26 : 32);
export const stationInterval = (level: number) => 16 / (1 + level * 0.35);
export const accuracyChance = (level: number) => 0.82 + level * 0.055;
export const SAVE_KEY = "agent-inc-progress-v1";
export const OFFLINE_LIMIT_SECONDS = 2 * 60 * 60;
const defaultAgentLevels = (): AgentLevels[] =>
  Array.from({ length: MAX_CAPACITY }, () => ({ speed: 0, accuracy: 0 }));

export function initialProgress(now = Date.now()): Progress {
  return {
    version: 1, tokens: 0, capacity: 1, context: false, workflow: 0,
    stationLevels: Array(MAX_CAPACITY).fill(0), agentLevels: defaultAgentLevels(),
    completed: 0, errors: 0, earned: 0, seed: 41729, nextId: 1, savedAt: now,
  };
}

export function parseProgress(raw: string | null): Progress | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const p = value as Record<string, unknown>;
    const workflow = p.workflow === undefined ? 0 : p.workflow;
    const stationLevels = p.stationLevels === undefined ? Array(MAX_CAPACITY).fill(0) : p.stationLevels;
    const agentLevels = p.agentLevels === undefined ? defaultAgentLevels() : p.agentLevels;
    const errors = p.errors === undefined ? 0 : p.errors;
    if (
      p.version !== 1 ||
      !Number.isSafeInteger(p.tokens) || (p.tokens as number) < 0 ||
      !Number.isInteger(p.capacity) || (p.capacity as number) < 1 || (p.capacity as number) > MAX_CAPACITY ||
      typeof p.context !== "boolean" ||
      !Number.isInteger(workflow) || (workflow as number) < 0 || (workflow as number) > MAX_WORKFLOW ||
      !Array.isArray(stationLevels) || stationLevels.length !== MAX_CAPACITY ||
      !stationLevels.every((level: unknown) => Number.isInteger(level) && (level as number) >= 0 && (level as number) <= MAX_STATION_LEVEL) ||
      !Array.isArray(agentLevels) || agentLevels.length !== MAX_CAPACITY ||
      !agentLevels.every((levels: unknown) => {
        if (!levels || typeof levels !== "object" || Array.isArray(levels)) return false;
        const entry = levels as Record<string, unknown>;
        return Number.isInteger(entry.speed) && (entry.speed as number) >= 0 && (entry.speed as number) <= MAX_AGENT_LEVEL &&
          Number.isInteger(entry.accuracy) && (entry.accuracy as number) >= 0 && (entry.accuracy as number) <= MAX_AGENT_LEVEL;
      }) ||
      !Number.isSafeInteger(p.completed) || (p.completed as number) < 0 ||
      !Number.isSafeInteger(errors) || (errors as number) < 0 ||
      !Number.isSafeInteger(p.earned) || (p.earned as number) < 0 ||
      !Number.isInteger(p.seed) || (p.seed as number) < 0 || (p.seed as number) > 0xffffffff ||
      !Number.isSafeInteger(p.nextId) || (p.nextId as number) < 1 ||
      !Number.isFinite(p.savedAt) || (p.savedAt as number) < 0
    ) return null;
    return { ...p, workflow, stationLevels, agentLevels, errors } as Progress;
  } catch {
    return null;
  }
}

export function applyOffline(progress: Progress, now: number): OfflineReport {
  const seconds = Math.min(OFFLINE_LIMIT_SECONDS, Math.max(0, (now - progress.savedAt) / 1000));
  const throughput = progress.stationLevels.slice(0, progress.capacity).reduce((rate, level, id) =>
    rate + 1 / Math.max(stationInterval(level), 13 - progress.agentLevels[id].speed * 0.8 - progress.workflow * 0.6), 0);
  const completed = Math.floor(seconds * throughput);
  const accuracy = progress.agentLevels.slice(0, progress.capacity)
    .reduce((sum, agent) => sum + accuracyChance(agent.accuracy), 0) / progress.capacity;
  const errors = Math.floor(completed * (1 - accuracy));
  const gross = Math.floor((completed - errors) * ((progress.context ? 12 : 10) + progress.workflow));
  const tokens = gross - Math.min(progress.tokens + gross, errors * 3);
  progress.completed += completed;
  progress.errors += errors;
  progress.earned += gross;
  progress.tokens += tokens;
  progress.savedAt = now;
  return { seconds: Math.floor(seconds), completed, tokens };
}

export class Simulation {
  progress: Progress;
  agents: Agent[] = [];
  requests: Request[] = [];
  time = 0;
  paused = false;
  speed = 1;
  private nextArrival = COFFEE_SPOTS.map((_, id) => 1.8 + id * 3.7);
  lastResult: { success: boolean; amount: number; agentId: number } | null = null;

  constructor(progress = initialProgress()) {
    this.progress = {
      ...progress, stationLevels: [...progress.stationLevels],
      agentLevels: progress.agentLevels.map((levels) => ({ ...levels })),
    };
    for (let i = 0; i < this.progress.capacity; i++) this.addAgent();
  }

  private addAgent() {
    const id = this.agents.length;
    const { x, z } = COFFEE_SPOTS[id];
    this.agents.push({
      id, state: "idle", x, z, target: { x, z }, route: [],
      workLeft: 0, workTotal: 0, visitedContext: false,
    });
  }

  private random() {
    this.progress.seed = (Math.imul(1664525, this.progress.seed) + 1013904223) >>> 0;
    return this.progress.seed / 0x100000000;
  }

  private spawnRequest(stationId: number) {
    const kind: RequestKind = this.progress.context && this.random() < 0.38 ? "context" : "chat";
    const titles = kind === "context" ? CONTEXT_REQUESTS : CHAT_REQUESTS;
    const title = titles[Math.floor(this.random() * titles.length)];
    const reward = (kind === "context" ? 14 : 9) + Math.floor(this.random() * 4) + this.progress.workflow;
    this.requests.unshift({
      id: this.progress.nextId++, stationId, title, kind, status: "queued", reward, progress: 0,
    });
    const resolved = this.requests.filter((request) => request.status === "complete" || request.status === "failed").slice(0, 12);
    this.requests = [...this.requests.filter((request) => request.status !== "complete" && request.status !== "failed"), ...resolved];
  }

  private assign() {
    for (const agent of this.agents) {
      if (agent.taskId !== undefined || agent.state === "working") continue;
      const request = this.requests.find((r) => r.status === "queued" && r.stationId === agent.id);
      if (!request) continue;
      request.status = "assigned";
      request.agentId = agent.id;
      agent.taskId = request.id;
      agent.state = "walking";
      agent.visitedContext = false;
      agent.route = [...(request.kind === "context" ? [{ ...CONTEXT }] : []), { ...DESKS[agent.id] }];
      agent.target = agent.route.shift()!;
      agent.workTotal = (request.kind === "context" ? 7.2 : 5.4 + this.random() * 1.4) *
        (1 - this.progress.workflow * 0.1) * (1 - this.progress.agentLevels[agent.id].speed * 0.12);
      agent.workLeft = agent.workTotal;
    }
  }

  private resolve(agent: Agent) {
    const request = this.requests.find((r) => r.id === agent.taskId);
    if (!request) throw new Error(`Missing request for agent ${agent.id}`);
    const success = this.random() < accuracyChance(this.progress.agentLevels[agent.id].accuracy);
    request.progress = 1;
    request.resolvedAt = this.time;
    this.progress.completed++;
    if (success) {
      request.status = "complete";
      this.progress.tokens += request.reward;
      this.progress.earned += request.reward;
      this.lastResult = { success, amount: request.reward, agentId: agent.id };
    } else {
      request.status = "failed";
      request.loss = Math.min(this.progress.tokens, request.kind === "context" ? 5 : 3);
      this.progress.tokens -= request.loss;
      this.progress.errors++;
      this.lastResult = { success, amount: request.loss, agentId: agent.id };
    }
    this.nextArrival[request.stationId] = Math.max(this.nextArrival[request.stationId], 3.5);
    agent.taskId = undefined;
    agent.state = "returning";
    agent.target = { ...COFFEE_SPOTS[agent.id] };
  }

  private move(agent: Agent, delta: number) {
    const dx = agent.target.x - agent.x;
    const dz = agent.target.z - agent.z;
    const distance = Math.hypot(dx, dz);
    const step = 2.05 * delta;
    if (distance > step) {
      agent.x += dx / distance * step;
      agent.z += dz / distance * step;
      return;
    }
    agent.x = agent.target.x;
    agent.z = agent.target.z;
    if (agent.state === "returning") {
      agent.state = "idle";
      return;
    }
    if (agent.target.x === CONTEXT.x && agent.target.z === CONTEXT.z) agent.visitedContext = true;
    const next = agent.route.shift();
    if (next) {
      agent.target = next;
    } else {
      agent.state = "working";
      const request = this.requests.find((r) => r.id === agent.taskId);
      if (request) request.status = "working";
    }
  }

  update(delta: number) {
    if (this.paused || delta <= 0) return;
    // Callers use a fixed timestep. Subdivision also keeps direct large-delta calls safe.
    let remaining = Math.min(delta * this.speed, 5);
    while (remaining > 0) {
      const step = Math.min(remaining, 1 / 30);
      remaining -= step;
      this.time += step;
      for (let id = 0; id < this.progress.capacity; id++) {
        this.nextArrival[id] -= step;
        const pending = this.requests.some((request) =>
          request.stationId === id && (request.status === "queued" || request.status === "assigned" || request.status === "working"));
        if (this.nextArrival[id] <= 0 && !pending) {
          this.spawnRequest(id);
          this.nextArrival[id] = stationInterval(this.progress.stationLevels[id]);
        }
      }
      this.assign();
      for (const agent of this.agents) {
        if (agent.state === "walking" || agent.state === "returning") this.move(agent, step);
        else if (agent.state === "working") {
          agent.workLeft = Math.max(0, agent.workLeft - step);
          const request = this.requests.find((r) => r.id === agent.taskId);
          if (!request) throw new Error(`Missing request for agent ${agent.id}`);
          request.progress = 1 - agent.workLeft / agent.workTotal;
          if (agent.workLeft === 0) this.resolve(agent);
        }
      }
    }
  }

  buyCapacity() {
    if (this.progress.tokens < CAPACITY_COST || this.progress.capacity >= MAX_CAPACITY) return false;
    this.progress.tokens -= CAPACITY_COST;
    this.progress.capacity++;
    this.addAgent();
    this.nextArrival[this.progress.capacity - 1] = 1.8;
    return true;
  }

  buyWorkflow() {
    if (this.progress.capacity < 2 || this.progress.workflow >= MAX_WORKFLOW ||
      this.progress.tokens < workflowCost(this.progress.workflow)) return false;
    this.progress.tokens -= workflowCost(this.progress.workflow);
    this.progress.workflow++;
    return true;
  }

  buyStation(id: number) {
    if (!Number.isInteger(id) || id < 0 || id >= this.progress.capacity) return false;
    const level = this.progress.stationLevels[id];
    if (level >= MAX_STATION_LEVEL ||
      this.progress.tokens < stationCost(level)) return false;
    this.progress.tokens -= stationCost(level);
    this.progress.stationLevels[id]++;
    this.nextArrival[id] = Math.min(this.nextArrival[id], stationInterval(this.progress.stationLevels[id]));
    return true;
  }

  trainAgent(id: number, stat: keyof AgentLevels) {
    if (!Number.isInteger(id) || id < 0 || id >= this.progress.capacity || (stat !== "speed" && stat !== "accuracy")) return false;
    const level = this.progress.agentLevels[id][stat];
    if (level >= MAX_AGENT_LEVEL || this.progress.tokens < agentCost(stat, level)) return false;
    this.progress.tokens -= agentCost(stat, level);
    this.progress.agentLevels[id][stat]++;
    return true;
  }

  unlockContext() {
    if (this.progress.tokens < CONTEXT_COST || this.progress.context || this.progress.capacity < 2) return false;
    this.progress.tokens -= CONTEXT_COST;
    this.progress.context = true;
    return true;
  }

  save(now = Date.now()): Progress {
    return {
      ...this.progress, savedAt: now, stationLevels: [...this.progress.stationLevels],
      agentLevels: this.progress.agentLevels.map((levels) => ({ ...levels })),
    };
  }
}
