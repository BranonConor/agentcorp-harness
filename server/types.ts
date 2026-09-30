export type Phase = "idle" | "thinking" | "working" | "permission" | "interrupted" | "error";
export type Message = { id: string; role: "user" | "assistant" | "system"; content: string; pending?: boolean };
export type Review = { id: string; kind: string; detail: string; tool: string };
export type Agent = {
  id: string;
  x: number;
  y: number;
  sessionId: string;
  phase: Phase;
  activity: string;
  messages: Message[];
  review?: Review;
};
export type Room = { agent: Agent | null; error: string | null; connected: boolean; workspace: string; revision: number };
import type { SessionEvent, PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";
export interface LiveSession {
  sessionId: string;
  send(prompt: string): Promise<void>;
  onEvent(handler: (event: SessionEvent) => void): () => void;
  disconnect(): Promise<void>;
}
export interface Adapter {
  probe(): Promise<void>;
  create(workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>, sessionId?: string): Promise<LiveSession>;
  resume(id: string, workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>): Promise<LiveSession>;
  stop(): Promise<void>;
}
