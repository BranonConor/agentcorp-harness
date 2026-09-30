export type Phase = "idle" | "thinking" | "working" | "permission" | "interrupted" | "error";
export type Message = { id: string; role: "user" | "assistant" | "system"; content: string; pending?: boolean };
export type Review = { id: string; kind: string; detail: string; tool: string };
export const MAX_AGENTS = 16;
export type Agent = {
  id: string;
  deskIndex: number | null;
  archived: boolean;
  archivedAt?: number;
  lastDeskIndex?: number;
  workspace: string;
  workspaceKind: "root" | "scratch";
  createdAt: number;
  updatedAt: number;
  sessionId: string;
  phase: Phase;
  activity: string;
  messages: Message[];
  review?: Review;
  repository?: RepositoryGrant;
};
export type Room = { agents: Agent[]; error: string | null; connected: boolean; workspace: string; revision: number };
export type LegacyRoom = {
  agent: (Omit<Agent, "deskIndex" | "archived" | "archivedAt" | "lastDeskIndex" | "workspace" | "workspaceKind" | "createdAt" | "updatedAt"> & { x: number; y: number }) | null;
  error: string | null;
  connected: boolean;
  workspace: string;
  revision: number;
};
import type { SessionEvent, PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";
import type { RepositoryGrant } from "./repository.js";
export interface LiveSession {
  sessionId: string;
  send(prompt: string): Promise<void>;
  abort(): Promise<void>;
  onEvent(handler: (event: SessionEvent) => void): () => void;
  disconnect(): Promise<void>;
}
export interface Adapter {
  probe(): Promise<void>;
  prepareWorkspace(root: string, agentId: string): Promise<string>;
  create(workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>, sessionId?: string, repository?: RepositoryGrant): Promise<LiveSession>;
  resume(id: string, workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>, repository?: RepositoryGrant): Promise<LiveSession>;
  deleteSession(id: string): Promise<void>;
  stop(): Promise<void>;
}
