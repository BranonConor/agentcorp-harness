import type { Assignment, Meeting } from "./types.js";
import type { MergedPullRequest } from "./merged-pr.js";

export const SPECIALTIES = ["Engineering", "Research", "Review", "Documentation"] as const;
export type Specialty = typeof SPECIALTIES[number];
export const RANKS = [
  { name: "Associate", xp: 0 },
  { name: "Specialist", xp: 40 },
  { name: "Senior", xp: 100 },
  { name: "Principal", xp: 200 },
] as const;
export const UPGRADES = [
  { id: "garden", name: "Window garden", price: 12, description: "Extra greenery beside the windows" },
  { id: "rug", name: "Lounge rug", price: 18, description: "A warm accent in the lounge" },
  { id: "lamp", name: "Desk lanterns", price: 24, description: "Decorative warm desk lights" },
] as const;
export type UpgradeId = typeof UPGRADES[number]["id"];

export type ProgressEvent =
  | { id: string; kind: "reward"; source: "assignment" | "review" | "merged-pr"; sourceId: string; personaId: string;
    evidence: string; specialty: Specialty; xp: number; credits: number; at: number;
    assignmentId?: string; verifiedPr?: MergedPullRequest }
  | { id: string; kind: "purchase"; upgradeId: UpgradeId; credits: number; at: number }
  | { id: string; kind: "promotion"; personaId: string; rank: number; at: number };

export function assignmentEvidence(assignment: Assignment): boolean {
  return assignment.status === "completed" && !!assignment.endedAt && !assignment.retention &&
    assignment.messages.some(message => message.role === "user" && !!message.content.trim()) &&
    assignment.messages.some(message => message.role === "assistant" && !message.pending && !!message.content.trim());
}

export function reviewEvidence(meeting: Meeting, personaId: string): boolean {
  return meeting.kind === "review" && meeting.status === "completed" && meeting.participantIds.includes(personaId) &&
    !!meeting.sharedText.trim() && !!meeting.summary.trim() &&
    meeting.turns.some(turn => turn.agentId === personaId && !!turn.response.trim());
}

export function progression(events: readonly ProgressEvent[], personas: readonly string[],
  assignments: readonly Assignment[], meetings: readonly Meeting[]) {
  const ids = new Set<string>();
  const rewards = new Set<string>();
  const purchases = new Set<UpgradeId>();
  const ranks = new Map(personas.map(id => [id, 0]));
  const xp = new Map(personas.map(id => [id, 0]));
  const specialties = new Map(personas.map(id => [id, new Map<Specialty, number>()]));
  const daily = new Map<string, number>();
  let balance = 0;
  for (const event of events) {
    if (!event || typeof event.id !== "string" || ids.has(event.id) ||
      !Number.isSafeInteger(event.at) || event.at <= 0 || event.at > Date.now()) throw new Error("Invalid or duplicate progression event.");
    ids.add(event.id);
    if (event.kind === "reward") {
      const key = `${event.source}:${event.sourceId}:${event.source === "review" ? event.personaId : ""}`;
      const assignment = assignments.find(item => item.id === event.sourceId);
      const meeting = meetings.find(item => item.id === event.sourceId);
      const attributed = assignments.find(item => item.id === event.assignmentId);
      const pr = event.verifiedPr;
      const validSource = event.source === "assignment" ?
        !event.assignmentId && !pr && !!assignment && assignment.personaId === event.personaId &&
          assignmentEvidence(assignment) && event.xp === 20 && event.credits === 8 &&
          event.at >= assignment.endedAt! && !rewards.has(`pr-assignment:${assignment.id}`) :
        event.source === "review" ?
          !event.assignmentId && !pr && !!meeting && reviewEvidence(meeting, event.personaId) &&
          event.xp === 10 && event.credits === 4 && event.at >= meeting.updatedAt :
          event.source === "merged-pr" && !!attributed && !!pr &&
          attributed.personaId === event.personaId &&
          !!attributed.repository?.remote &&
          attributed.repository.remote.fullName.toLowerCase() === pr.repository.toLowerCase() &&
          /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/.test(event.sourceId) &&
          event.sourceId === `${pr.repository.toLowerCase()}#${pr.number}` &&
          Number.isSafeInteger(pr.number) && pr.number > 0 &&
          /^[a-f0-9]{40}$/i.test(pr.mergeSha) && Number.isSafeInteger(pr.mergedAt) &&
          pr.mergedAt >= attributed.startedAt && pr.mergedAt <= event.at &&
          event.xp === 30 && event.credits === 12 &&
          !rewards.has(`assignment:${attributed.id}:`) && !rewards.has(`pr-assignment:${attributed.id}`);
      if (event.id !== key || rewards.has(key) || !xp.has(event.personaId) ||
        !SPECIALTIES.includes(event.specialty) ||
        typeof event.evidence !== "string" || event.evidence.trim() !== event.evidence ||
        event.evidence.length < 10 || event.evidence.length > 500 || !validSource) {
        throw new Error("Reward is not backed by a confirmed completed outcome.");
      }
      const day = `${event.personaId}:${new Date(event.at).toISOString().slice(0, 10)}`;
      daily.set(day, (daily.get(day) ?? 0) + 1);
      if (daily.get(day)! > 3) throw new Error("Daily reward cap exceeded (3 per persona).");
      rewards.add(key);
      if (event.source === "merged-pr") rewards.add(`pr-assignment:${event.assignmentId}`);
      xp.set(event.personaId, xp.get(event.personaId)! + event.xp);
      const skills = specialties.get(event.personaId)!;
      skills.set(event.specialty, (skills.get(event.specialty) ?? 0) + event.xp);
      balance += event.credits;
    } else if (event.kind === "purchase") {
      const upgrade = UPGRADES.find(item => item.id === event.upgradeId);
      if (!upgrade || event.id !== `purchase:${upgrade.id}` || purchases.has(upgrade.id) ||
        event.credits !== -upgrade.price || balance < upgrade.price) throw new Error("Invalid or unaffordable upgrade.");
      balance -= upgrade.price;
      purchases.add(upgrade.id);
    } else if (event.kind === "promotion") {
      const current = ranks.get(event.personaId);
      if (current === undefined || !Number.isInteger(event.rank) || event.rank !== current + 1 ||
        event.rank >= RANKS.length || event.id !== `promotion:${event.personaId}:${event.rank}` ||
        xp.get(event.personaId)! < RANKS[event.rank].xp) throw new Error("Promotion is not eligible.");
      ranks.set(event.personaId, event.rank);
    } else throw new Error("Unknown progression event.");
  }
  return { balance, xp, ranks, specialties, purchases, rewards, daily };
}
