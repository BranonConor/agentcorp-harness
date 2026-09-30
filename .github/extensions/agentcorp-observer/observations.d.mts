export const MAX_DESKS: number;
export const EXPIRY_MS: number;
export const dataDir: string;
export function validId(id: unknown): string;
export function heartbeat(id: string, phase: "idle" | "thinking" | "tool" | "blocked" | "offline", owner: string, now?: number): Promise<void>;
export function clearHeartbeat(id: string, owner: string): Promise<void>;
export function enroll(root: string, parent: string, child: string): Promise<void>;
export function snapshot(root: string, now?: number): Promise<{
  root: string;
  sessions: { id: string; phase: "idle" | "thinking" | "tool" | "blocked" | "offline"; present: boolean }[];
}>;
