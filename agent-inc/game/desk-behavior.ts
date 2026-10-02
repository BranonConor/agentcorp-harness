export const DESK_IDLE_MS = 120_000;

export type DeskPresence = "working" | "waiting" | "break" | "unavailable";

export function deskPresence(
  status: "thinking" | "tool" | "blocked" | "idle" | "offline",
  idleSince: number | undefined,
  now: number,
): DeskPresence {
  if (status === "idle") {
    if (idleSince === undefined || !Number.isFinite(idleSince)) {
      throw new Error("Idle agent has no valid idle start time");
    }
    return now - idleSince >= DESK_IDLE_MS ? "break" : "waiting";
  }
  return status === "offline" ? "unavailable" : "working";
}

export function nextDeskBreak(
  agents: readonly { status: "thinking" | "tool" | "blocked" | "idle" | "offline";
    idleSince?: number }[],
  now: number,
): number {
  return agents.reduce((next, agent) => {
    if (agent.status !== "idle" || deskPresence(agent.status, agent.idleSince, now) === "break") return next;
    return Math.min(next, agent.idleSince! + DESK_IDLE_MS);
  }, Infinity);
}
