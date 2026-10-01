import type { LiveNoticeActivity } from "../../agent-inc/game/sprite-art";

export type Status = "idle" | "thinking" | "tool" | "blocked" | "offline";
export type RecentTool = {
  kind: "Terminal" | "Checks" | "Research" | "Editing" | "Delegating" | "Working";
  at: number;
};
export type Worker = { id?: string; status: Status; activity: string; recentTool?: RecentTool };
export type Signal = { kind: "message" | "tool" | "helper" | "error"; label: string; at: number };
export type AttachedUsage = {
  status: "ready";
  startedAt: string;
  totalTokens: number;
  cachedInputTokens: number;
  modelCalls: number;
  filesChanged: number;
  linesAdded: number;
} | { status: "unavailable" };
export type Session = {
  sessionId: string;
  title?: string;
  status: Status;
  activity: string;
  tools: string[];
  recentTool?: RecentTool;
  subagents: Worker[];
  messages?: number;
  events?: Signal[];
  updatedAt: number;
  seenAt: number;
};
export type Room = { currentSessionId: string; sessions: Session[]; attachedUsage?: AttachedUsage };
export type Actor = {
  key: string;
  name: string;
  sessionTitle: string;
  status: Status;
  activity: string;
  helper: boolean;
  recentTool?: RecentTool;
};

const givenNames = [
  "Ada", "Aiko", "Alma", "Amari", "Anika", "Arden", "Ari", "Basil",
  "Bea", "Cleo", "Dara", "Demi", "Eli", "Emery", "Esme", "Finn",
  "Inez", "Ira", "Jules", "Kaia", "Kit", "Lena", "Lio", "Luca",
  "Mara", "Mica", "Milo", "Mira", "Nell", "Nico", "Noor", "Oli",
  "Orla", "Pax", "Remy", "Rhea", "Rio", "Sage", "Soli", "Tavi",
  "Abel", "Adira", "Alina", "Ansel", "Arlo", "Astrid", "Avery", "Bela",
  "Briar", "Calla", "Cato", "Celine", "Cora", "Dorian", "Edda", "Elio",
  "Elise", "Elowen", "Eren", "Faye", "Flora", "Galen", "Hana", "Hugo",
  "Idris", "Imani", "Iris", "Jasper", "Juno", "Kavi", "Keira", "Leon",
  "Livia", "Lyra", "Mae", "Maren", "Milan", "Nadia", "Nia", "Nolan",
  "Oren", "Petra", "Quinn", "Rafi", "Rina", "Robin", "Rowan", "Sabine",
  "Sora", "Talia", "Tess", "Uma", "Vera", "Wren", "Yara", "Zoe",
];
const familyNames = [
  "Alder", "Arbor", "Ash", "Bell", "Birch", "Bloom", "Brooks", "Cedar",
  "Cloud", "Dale", "Dawn", "Dove", "Dusk", "Elm", "Fern", "Finch",
  "Frost", "Grove", "Hart", "Haven", "Hollow", "Ivy", "Lake", "Lark",
  "Linden", "Marsh", "Meadow", "Moss", "Oak", "Orchard", "Pearl", "Pine",
  "Reed", "Ridge", "River", "Rowan", "Shore", "Silver", "Stone", "Vale",
  "Amber", "Aspen", "Bay", "Beacon", "Brook", "Canyon", "Clay", "Clover",
  "Coast", "Comet", "Coral", "Delta", "Ember", "Field", "Flint", "Fjord",
  "Glen", "Harbor", "Hearth", "Hill", "Juniper", "Kestrel", "Leaf", "Maple",
  "Meridian", "Moon", "North", "Olive", "Opal", "Pond", "Rain", "Rill",
  "Sable", "Sage", "Sparrow", "Spring", "Star", "Summit", "Thorn", "Tide",
  "Timber", "Violet", "Wells", "West", "Willow", "Wind", "Wood", "Wynn",
  "Yew", "Zephyr",
];

function hash(key: string): number {
  let value = 2166136261;
  for (let i = 0; i < key.length; i++) {
    value = Math.imul(value ^ key.charCodeAt(i), 16777619);
  }
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

export function agentName(key: string): string {
  return `${givenNames[hash(`given:${key}`) % givenNames.length]} ${familyNames[hash(`family:${key}`) % familyNames.length]}`;
}

export function uniqueAgentName(key: string, taken: ReadonlySet<string>): string {
  const total = givenNames.length * familyNames.length;
  const start = hash(`name:${key}`) % total;
  for (let offset = 0; offset < total; offset++) {
    const index = (start + offset) % total;
    const name = `${givenNames[index % givenNames.length]} ${familyNames[Math.floor(index / givenNames.length)]}`;
    if (!taken.has(name)) return name;
  }
  const base = agentName(key);
  for (let suffix = 2; ; suffix++) {
    const name = `${base} ${suffix}`;
    if (!taken.has(name)) return name;
  }
}
export function sessionName(session: Session, currentId: string): string {
  return session.title || (session.sessionId === currentId ?
    "Your session" : `Session ${session.sessionId.slice(0, 8)}`);
}

export function roomActors(room: Room): Actor[] {
  const sorted = [...room.sessions].sort((a, b) =>
    Number(b.sessionId === room.currentSessionId) - Number(a.sessionId === room.currentSessionId) ||
    a.sessionId.localeCompare(b.sessionId));
  const actors: Omit<Actor, "name">[] = [
    ...sorted.map((session) => ({
      key: session.sessionId, sessionTitle: sessionName(session, room.currentSessionId),
      status: session.status, activity: session.activity, helper: false, recentTool: session.recentTool,
    })),
    ...sorted.flatMap((session) => session.subagents.map((worker, index) => ({
      key: `${session.sessionId}:helper:${worker.id ?? index}`,
      sessionTitle: sessionName(session, room.currentSessionId),
      status: worker.status, activity: worker.activity, helper: true, recentTool: worker.recentTool,
    }))),
  ];
  const seen = new Set<string>();
  return actors.map((actor) => {
    const base = agentName(actor.key);
    let name = base;
    for (let suffix = 2; seen.has(name); suffix++) name = `${base} ${suffix}`;
    seen.add(name);
    return { ...actor, name };
  });
}

function toolNotice(kind: string): LiveNoticeActivity {
  switch (kind) {
    case "Terminal": return "terminal";
    case "Checks": return "checks";
    case "Research": return "research";
    case "Editing": return "editing";
    case "Delegating": return "delegating";
    default: return "working";
  }
}

export function noticeActivityForActor(
  actor: Pick<Actor, "status" | "activity" | "recentTool">, now = Date.now(),
): LiveNoticeActivity | null {
  if (actor.status === "idle" || actor.status === "offline") return null;
  if (actor.status === "blocked") return "blocked";
  if (actor.status === "thinking") {
    if (actor.activity === "Helpers at work") return "delegating";
    const recent = actor.recentTool;
    return recent && now >= recent.at && now - recent.at < 5_000 ?
      toolNotice(recent.kind) : "thinking";
  }
  return toolNotice(actor.activity);
}
