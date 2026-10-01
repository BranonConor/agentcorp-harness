export type Phase = "idle" | "thinking" | "working" | "permission" | "interrupted" | "error";
export type Message = { id: string; role: "user" | "assistant" | "system"; content: string; pending?: boolean };
export type Review = { id: string; kind: string; detail: string; tool: string };
import type { RemoteRepository, RepositorySnapshot } from "./github-repositories.js";
import type { ModelProfile } from "./providers.js";
export type RepositoryRequest = { id: string; repoHint: string; purpose: string; scope: "read" | "edit";
  status?: "resolving" | "review" | "cloning" | "error"; candidates?: RemoteRepository[];
  error?: string; progress?: string };
export type UsageSummary = { status: "ready" | "partial" | "unavailable"; measured: number; total: number; tokens: number; calls: number; filesChanged: number; startedAt?: string; updatedAt: number; stale?: boolean };
export const MAX_AGENTS = 16;
export type PersonaMemory = { id: string; text: string; provenance: string; approvedAt: number };
export type AgentPersona = {
  id: string; name: string; artId: number; createdAt: number; updatedAt: number;
  profile: { workingStyle: string; specialties: string[]; title: string; rank: string };
  memories: PersonaMemory[];
  repositoryPolicies?: { fullName: string; read: boolean; excluded: boolean }[];
};
export type ProjectPolicy = { repository: RemoteRepository; sharedRead: boolean };
export type Assignment = {
  id: string; personaId: string; sessionId: string; workspace: string;
  modelProfileId?: string; modelProfile?: ModelProfile;
  repository?: RepositoryGrant; startedAt: number; endedAt?: number; outcome?: string;
  status: "active" | "completed" | "interrupted"; messages: Message[];
  retention?: "keep" | "delete-sdk";
};
export type Agent = {
  id: string;
  personaId?: string;
  assignmentId?: string;
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
export type Room = { schemaVersion?: 2 | 3; personas?: AgentPersona[]; assignments?: Assignment[];
  projects?: ProjectPolicy[];
  modelProfiles?: ModelProfile[]; defaultModelProfileId?: string;
  agents: Agent[]; error: string | null; connected: boolean; workspace: string; revision: number;
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
  probe(profile?: ModelProfile): Promise<void>;
  listModels?(): Promise<{ id: string; name: string }[]>;
  prepareWorkspace(root: string, agentId: string): Promise<string>;
  create(workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>,
    sessionId?: string, repository?: RepositoryGrant, requestAccess?: (intent: AccessIntent) => Promise<string>,
    getGrant?: (fullName: string) => Promise<RepositoryGrant | undefined>, profile?: ModelProfile): Promise<LiveSession>;
  resume(id: string, workspace: string, permission: (request: PermissionRequest) => Promise<PermissionRequestResult>,
    repository?: RepositoryGrant, requestAccess?: (intent: AccessIntent) => Promise<string>,
    getGrant?: (fullName: string) => Promise<RepositoryGrant | undefined>, profile?: ModelProfile): Promise<LiveSession>;
  deleteSession(id: string): Promise<void>;
  stop(): Promise<void>;
}
