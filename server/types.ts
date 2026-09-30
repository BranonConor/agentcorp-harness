export type Phase = "idle" | "thinking" | "working" | "permission" | "interrupted" | "error";
export type Message = { id: string; role: "user" | "assistant" | "system"; content: string; pending?: boolean };
export type Review = { id: string; kind: string; detail: string; tool: string };
import type { RemoteRepository, RepositorySnapshot } from "./github-repositories.js";
export type RepositoryRequest = { id: string; repoHint: string; purpose: string; scope: "read" | "edit";
  status?: "resolving" | "review" | "cloning" | "error"; candidates?: RemoteRepository[];
  error?: string; progress?: string };
export type UsageSummary = { status: "ready" | "partial" | "unavailable"; measured: number; total: number; tokens: number; calls: number; filesChanged: number; startedAt?: string; updatedAt: number; stale?: boolean };
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
  accessRequest?: RepositoryRequest;
  persona?: number;
  name?: string;
};
export type Room = { agents: Agent[]; error: string | null; connected: boolean; workspace: string; revision: number;
  knownRepositories?: string[]; usage?: UsageSummary;
  snapshots?: RepositorySnapshot[];
  worktrees?: { agentId: string; repository: string; path: string; branch: string }[] };
export type LegacyRoom = {
  agent: (Omit<Agent, "deskIndex" | "archived" | "archivedAt" | "lastDeskIndex" | "workspace" | "workspaceKind" | "createdAt" | "updatedAt"> & { x: number; y: number }) | null;
  error: string | null;
  connected: boolean;
  workspace: string;
  revision: number;
};
import type { SessionEvent, PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";
import type { AccessIntent, RepositoryGrant } from "./repository.js";
export interface LiveSession {
  sessionId: string;
  send(prompt: string): Promise<void>;
  abort(): Promise<void>;
  setWorkingDirectory(path: string): Promise<void>;
  getUsage(): Promise<{ tokens: number; calls: number; filesChanged: number; startedAt: string }>;
  onEvent(handler: (event: SessionEvent) => void): () => void;
  disconnect(): Promise<void>;
}
export interface Adapter {
  probe(): Promise<void>;
  prepareWorkspace(root: string, agentId: string): Promise<string>;
  create(workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>,
    sessionId?: string, repository?: RepositoryGrant, requestAccess?: (intent: AccessIntent) => Promise<string>,
    getGrant?: () => RepositoryGrant | undefined): Promise<LiveSession>;
  resume(id: string, workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>,
    repository?: RepositoryGrant, requestAccess?: (intent: AccessIntent) => Promise<string>,
    getGrant?: () => RepositoryGrant | undefined): Promise<LiveSession>;
  deleteSession(id: string): Promise<void>;
  stop(): Promise<void>;
}
