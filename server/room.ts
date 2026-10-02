import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { PermissionRequest, PermissionRequestResult, SessionEvent } from "@github/copilot-sdk";
import { MAX_AGENTS, type Adapter, type Agent, type AgentPersona, type LiveSession, type Meeting, type Review, type Room, type RepositoryRequest } from "./types.js";
import type { Store } from "./storage.js";
import { createResearchWorktree, validateRepository, validateResearchWorktree, type AccessIntent, type RepositoryGrant } from "./repository.js";
import { uniqueAgentName } from "../agent-inc-live/src/room.js";
import { CACHE_AGE_MS, validateRemoteRepository, type RemoteRepository, type RepositorySnapshot, type RepositorySource } from "./github-repositories.js";
import { COPILOT_PROFILE, safeProviderError, sessionModel, validateProfile, type ModelProfile } from "./providers.js";
import { progression, RANKS, SPECIALTIES, UPGRADES, assignmentEvidence, reviewEvidence,
  type ProgressEvent, type Specialty, type UpgradeId } from "./progression.js";
import { verifyMergedPullRequest, type MergedPullRequest } from "./merged-pr.js";
import { MAX_GUIDANCE_LENGTH, MAX_MEMORIES, personaGuidance } from "./persona-guidance.js";

const EXPIRE_MS = 90_000;
const MEETING_TIMEOUT_MS = 120_000;
type Pending = { agentId: string; resolve: (decision: PermissionRequestResult) => void; timer: NodeJS.Timeout };
type PendingAccess = { agentId: string; resolve: (result: string) => void; timer: NodeJS.Timeout };
type TrustedLocal = { assignmentId: string; sessionId: string; worktreePath: string };
const ROUTINE_TOOLS: Record<string, PermissionRequest["kind"]> = {
  bash: "shell", apply_patch: "write", view: "read", rg: "read", glob: "read"
};

export class RoomController {
  readonly state: Room;
  private sessions = new Map<string, LiveSession>();
  private unsubscribers = new Map<string, () => void>();
  private listeners = new Set<(room: Room) => void>();
  private pending = new Map<string, Pending>();
  private access = new Map<string, PendingAccess>();
  private saving: Promise<void> = Promise.resolve();
  private connecting: Promise<void> | null = null;
  private creating = new Set<number>();
  private lifecycle = new Set<string>();
  private stopped = new Set<string>();
  private stopping = new Set<string>();
  private armedTaskGrants = new Set<string>();
  private trustedLocal = new Map<string, TrustedLocal>();
  private toolStarts = new Map<string, Map<string, { name: string; kind: PermissionRequest["kind"] }>>();
  private permissionEpochs = new Map<string, string>();
  private clones = new Map<string, AbortController>();
  private lookups = new Map<string, number>();
  private meetingTurns = new Map<string, { meetingId: string; start: number; handoffText: string; timer: NodeJS.Timeout }>();
  private economyQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly adapter: Adapter, private readonly store: Store, state: Room,
    private readonly worktreeRoot: string, private readonly repositories?: RepositorySource,
    private readonly meetingTimeoutMs = MEETING_TIMEOUT_MS,
    private readonly verifyPr: (repository: string, number: number) => Promise<MergedPullRequest> = verifyMergedPullRequest) {
    this.state = state;
  }

  static async open(adapter: Adapter, store: Store, workspace: string, worktreeRoot = resolve(".local/worktrees"),
    repositories?: RepositorySource, meetingTimeoutMs = MEETING_TIMEOUT_MS,
    verifyPr: (repository: string, number: number) => Promise<MergedPullRequest> = verifyMergedPullRequest): Promise<RoomController> {
    if (!Number.isInteger(meetingTimeoutMs) || meetingTimeoutMs < 1 || meetingTimeoutMs > MEETING_TIMEOUT_MS) {
      throw new Error("Meeting timeout must be a positive bounded number of milliseconds.");
    }
    const saved = await store.read();
    if (saved && saved.workspace !== workspace) throw new Error(`Saved sessions belong to ${saved.workspace}. Choose that workspace or move .local/state.json aside deliberately.`);
    if (saved && !("agents" in saved) && !("agent" in saved)) throw new Error("Unrecognized saved room format; state was not changed.");
    if (saved && "schemaVersion" in saved && saved.schemaVersion !== undefined && saved.schemaVersion !== 2 && saved.schemaVersion !== 3 && saved.schemaVersion !== 4 && saved.schemaVersion !== 5 && saved.schemaVersion !== 6) {
      throw new Error("Unknown state schema; state was not changed.");
    }
    const now = Date.now();
    const state: Room = saved
      ? "agents" in saved
        ? saved
        : { agents: saved.agent ? [{ ...saved.agent, deskIndex: 0, archived: false, workspace, workspaceKind: "root", createdAt: now, updatedAt: now }] : [], error: saved.error, connected: saved.connected, workspace, revision: saved.revision }
      : { agents: [], error: null, connected: false, workspace, revision: 0 };
    if (Array.isArray(state.agents)) {
      for (const agent of state.agents) {
        agent.trustedLocal = false;
        agent.archived ??= false;
        if (state.schemaVersion === undefined) {
          agent.createdAt ??= now;
          agent.updatedAt ??= agent.createdAt;
        }
      }
    }
    if (!Array.isArray(state.agents) || state.agents.filter(agent => !agent.archived).length > MAX_AGENTS ||
      state.agents.some((agent, index) => !agent.id || !agent.sessionId || !agent.workspace ||
        !(agent.workspaceKind === "root" && agent.workspace === workspace ||
          agent.workspaceKind === "scratch" && /^[0-9a-f-]{36}$/.test(agent.id) &&
          (agent.workspace === join(workspace, "agents", agent.id) ||
            !!agent.assignmentId && /^[0-9a-f-]{36}$/.test(agent.assignmentId) &&
            agent.workspace === join(workspace, "agents", agent.assignmentId))) ||
        (agent.archived ? agent.deskIndex !== null :
          !Number.isInteger(agent.deskIndex) || agent.deskIndex === null ||
          agent.deskIndex < 0 || agent.deskIndex >= MAX_AGENTS) ||
        (agent.lastDeskIndex !== undefined && (!Number.isInteger(agent.lastDeskIndex) ||
          agent.lastDeskIndex < 0 || agent.lastDeskIndex >= MAX_AGENTS)) ||
        (agent.idleSince !== undefined && (!Number.isFinite(agent.idleSince) || agent.idleSince < 0)) ||
        state.agents.findIndex(other => other.id === agent.id || other.sessionId === agent.sessionId ||
          !agent.archived && !other.archived && other.deskIndex === agent.deskIndex) !== index)) {
      throw new Error("Saved agent roster is invalid; state was not changed.");
    }
    const room = new RoomController(adapter, store, state, worktreeRoot, repositories, meetingTimeoutMs, verifyPr);
    room.state.connected = false;
    room.state.error = null;
    if (room.state.usage) room.state.usage.stale = true;
    room.state.knownRepositories ??= [];
    room.state.worktrees ??= [];
    room.state.snapshots ??= [];
    const used = new Set<number>();
    const names = new Set(room.state.agents.map(agent => agent.name).filter((name): name is string => !!name));
    const assigned = new Set<string>();
    for (const agent of [...room.state.agents].sort((a, b) => Number(a.archived) - Number(b.archived) || (a.deskIndex ?? a.lastDeskIndex ?? 0) - (b.deskIndex ?? b.lastDeskIndex ?? 0))) {
      if (agent.phase === "idle") agent.idleSince ??= agent.updatedAt;
      if (agent.persona === undefined) agent.persona = Array.from({ length: MAX_AGENTS }, (_, i) => i).find(i => !used.has(i)) ?? (agent.lastDeskIndex ?? 0);
      if (!Number.isInteger(agent.persona) || agent.persona < 0 || agent.persona >= MAX_AGENTS ||
        (!agent.archived && used.has(agent.persona))) throw new Error("Saved sprite personas collide or are invalid; state was not changed.");
      if (!agent.archived) used.add(agent.persona);
      if (state.schemaVersion !== undefined && agent.name && assigned.has(agent.name)) {
        throw new Error("Saved agent names collide; state was not changed.");
      }
      const name = agent.name && !assigned.has(agent.name) ? agent.name : uniqueAgentName(agent.sessionId, names);
      agent.name = name;
      names.add(name);
      assigned.add(name);
      if (agent.accessRequest && agent.phase === "idle") {
        agent.accessRequest = { ...agent.accessRequest, status: "error", candidates: undefined, progress: undefined,
          purpose: agent.accessRequest.purpose === "Research or work on a local repository" ?
            "Research or edit a GitHub repository" : agent.accessRequest.purpose,
          error: "Recheck the GitHub owner/repo after restart; no clone has started." };
      } else {
        agent.accessRequest = undefined;
      }
      if (agent.repository?.scope === "task") agent.repository = undefined;
      if (agent.repository && !room.state.knownRepositories.includes(agent.repository.path)) room.state.knownRepositories.push(agent.repository.path);
    }
    if (state.schemaVersion !== undefined) {
      if (!Array.isArray(state.personas) || !Array.isArray(state.assignments)) {
        throw new Error("Saved persona roster is invalid; state was not changed.");
      }
      const ids = new Set<string>();
      const names = new Set<string>();
      for (const persona of state.personas) {
        if (!persona?.id || ids.has(persona.id) || !persona.name?.trim() ||
          names.has(persona.name.trim().toLocaleLowerCase()) ||
          !Number.isInteger(persona.artId) || persona.artId < 0 || persona.artId >= MAX_AGENTS ||
          !persona.profile || !Array.isArray(persona.profile.specialties) || !Array.isArray(persona.memories) ||
          [persona.profile.workingStyle, persona.profile.title, persona.profile.rank].some(value => typeof value !== "string" || value.length > 1000) ||
          persona.profile.specialties.length > 20 || persona.profile.specialties.some(value => typeof value !== "string" || !value.trim() || value.length > 80) ||
          persona.memories.some(note => !note?.id || typeof note.text !== "string" || !note.text.trim() || note.text.length > 2000 ||
            typeof note.provenance !== "string" || !note.provenance.trim() || note.provenance.length > 500 ||
            !Number.isFinite(note.approvedAt))) {
          throw new Error("Saved persona roster is invalid; state was not changed.");
        }
        ids.add(persona.id);
        names.add(persona.name.trim().toLocaleLowerCase());
      }
      const assignmentIds = new Set<string>();
      const sdkIds = new Set<string>();
      for (const assignment of state.assignments) {
        if (!assignment?.id || assignmentIds.has(assignment.id) || !ids.has(assignment.personaId) ||
          !assignment.sessionId || sdkIds.has(assignment.sessionId) || !Array.isArray(assignment.messages) ||
          !["active", "completed", "interrupted"].includes(assignment.status) ||
          (state.schemaVersion === 6 && (typeof assignment.personaGuidance !== "string" ||
            assignment.personaGuidance.length > MAX_GUIDANCE_LENGTH))) {
          throw new Error("Saved assignment history is invalid; state was not changed.");
        }
        assignmentIds.add(assignment.id);
        sdkIds.add(assignment.sessionId);
      }
      if (state.agents.some(agent => {
        const persona = state.personas!.find(item => item.id === agent.personaId);
        const assignment = state.assignments!.find(item => item.id === agent.assignmentId);
        return !persona || !assignment || persona.id !== agent.id ||
          persona.name !== agent.name || persona.artId !== agent.persona ||
          assignment.personaId !== persona.id || assignment.sessionId !== agent.sessionId ||
          assignment.workspace !== agent.workspace || assignment.status !== "active" ||
          JSON.stringify(assignment.messages) !== JSON.stringify(agent.messages);
      }) || state.assignments.some(item => item.status === "active" &&
        !state.agents.some(agent => agent.assignmentId === item.id))) {
        throw new Error("Saved agent/assignment linkage is invalid; state was not changed.");
      }
    } else {
      state.schemaVersion = 2;
      state.personas = state.agents.map(agent => ({
        id: agent.id, name: agent.name!, artId: agent.persona!, createdAt: agent.createdAt,
        updatedAt: agent.updatedAt, setupCompleted: true,
        profile: { instructions: "", workingStyle: "", specialties: [], title: "", rank: "" }, memories: [], repositoryPolicies: []
      }));
      state.assignments = state.agents.map(agent => ({
        id: agent.id, personaId: agent.id, sessionId: agent.sessionId, workspace: agent.workspace,
        repository: agent.repository, startedAt: agent.createdAt, status: "active" as const, messages: agent.messages
      }));
      for (const agent of state.agents) {
        agent.personaId = agent.id;
        agent.assignmentId = agent.id;
      }
    }
    if (state.schemaVersion === 2) {
      state.projects = [];
      for (const agent of state.agents) {
        const remote = agent.repository?.remote;
        if (!remote || agent.repository?.scope === "task") continue;
        if (!state.projects.some(project => project.repository.fullName.toLowerCase() === remote.fullName.toLowerCase())) {
          state.projects.push({ repository: { fullName: remote.fullName, url: remote.url, defaultBranch: remote.ref,
            privacy: remote.privacy, sizeKiB: 0 }, sharedRead: false });
        }
        state.personas!.find(persona => persona.id === agent.personaId)!.repositoryPolicies ??= [];
        state.personas!.find(persona => persona.id === agent.personaId)!.repositoryPolicies!.push({
          fullName: remote.fullName, read: true, excluded: false
        });
      }
      state.schemaVersion = 3;
    }
    if (state.schemaVersion === 3) {
      state.meetings = [];
      state.schemaVersion = 4;
    }
    if (state.schemaVersion === 4) {
      state.progression = [];
      state.schemaVersion = 5;
    }
    if (state.schemaVersion === 5) {
      for (const persona of state.personas!) {
        persona.profile.instructions = "";
        persona.setupCompleted = true;
      }
      // Existing SDK sessions never received profile guidance. Preserve that behavior on resume.
      for (const assignment of state.assignments!) assignment.personaGuidance = "";
      state.schemaVersion = 6;
    }
    if (state.personas!.some(persona => typeof persona.profile.instructions !== "string" ||
      persona.profile.instructions.length > 600 || typeof persona.setupCompleted !== "boolean")) {
      throw new Error("Saved persona instructions are invalid; state was not changed.");
    }
    if (!Array.isArray(state.meetings) || state.meetings.some((meeting, index) =>
      !meeting?.id || state.meetings!.findIndex(other => other.id === meeting.id) !== index ||
      !["meeting", "review"].includes(meeting.kind) ||
      !["open", "running", "completed", "cancelled", "interrupted"].includes(meeting.status) ||
      typeof meeting.agenda !== "string" || !meeting.agenda.trim() || typeof meeting.sharedText !== "string" ||
      meeting.sharedText.length > 6000 || meeting.agenda.length > 1000 ||
      meeting.repository !== undefined && (typeof meeting.repository !== "string" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(meeting.repository)) ||
      !Array.isArray(meeting.participantIds) || meeting.participantIds.length < 2 || meeting.participantIds.length > 4 ||
      new Set(meeting.participantIds).size !== meeting.participantIds.length ||
      meeting.participantIds.some(id => !state.personas!.some(persona => persona.id === id)) ||
      !Number.isInteger(meeting.maxTurns) || meeting.maxTurns < 1 || meeting.maxTurns > 8 ||
      !Number.isInteger(meeting.nextIndex) || meeting.nextIndex < 0 || meeting.nextIndex > meeting.maxTurns ||
      !Array.isArray(meeting.turns) || meeting.turns.length !== meeting.nextIndex ||
      meeting.turns.some((turn, turnIndex) => turn.agentId !== meeting.participantIds[turnIndex % meeting.participantIds.length] ||
        typeof turn.response !== "string" || typeof turn.handoffText !== "string" ||
        turn.response.length > 6000 || turn.handoffText.length > 4000 || !Number.isFinite(turn.at)) ||
      typeof meeting.summary !== "string" || meeting.summary.length > 4000 ||
      !Array.isArray(meeting.owners) || meeting.owners.some(owner =>
        !owner || !meeting.participantIds.includes(owner.agentId) || typeof owner.task !== "string" ||
        !owner.task.trim() || owner.task.length > 500 ||
        owner.assignmentId !== undefined && !state.assignments!.some(assignment => assignment.id === owner.assignmentId)) ||
      !Number.isFinite(meeting.createdAt) || !Number.isFinite(meeting.updatedAt))) {
      throw new Error("Saved meeting history is invalid; state was not changed.");
    }
    for (const meeting of state.meetings) {
      if (meeting.status === "running") {
        meeting.status = "interrupted";
        meeting.error = "Turn interrupted by restart; review the agent transcript before starting another handoff.";
        meeting.updatedAt = Date.now();
      }
    }
    state.projects ??= [];
    if (!Array.isArray(state.projects) || state.projects.some((project, index) =>
      !project?.repository || !validateRemoteRepository(project.repository) ||
      typeof project.sharedRead !== "boolean" ||
      (project.sharedWrite !== undefined && typeof project.sharedWrite !== "boolean") ||
      state.projects!.findIndex(other => other.repository.fullName.toLowerCase() === project.repository.fullName.toLowerCase()) !== index)) {
      throw new Error("Saved verified project catalog is invalid; state was not changed.");
    }
    for (const persona of state.personas!) {
      persona.repositoryPolicies ??= [];
      if (!Array.isArray(persona.repositoryPolicies) || persona.repositoryPolicies.some((policy, index) =>
        !state.projects!.some(project => project.repository.fullName.toLowerCase() === policy.fullName.toLowerCase()) ||
        typeof policy.read !== "boolean" || typeof policy.excluded !== "boolean" ||
        (policy.write !== undefined && typeof policy.write !== "boolean") ||
        (policy.read || policy.write) && policy.excluded ||
        persona.repositoryPolicies!.findIndex(other => other.fullName.toLowerCase() === policy.fullName.toLowerCase()) !== index)) {
        throw new Error("Saved persona repository policy is invalid; state was not changed.");
      }
    }
    state.modelProfiles ??= [COPILOT_PROFILE];
    if (!Array.isArray(state.modelProfiles)) {
      throw new Error("Saved model profiles are invalid; state was not changed.");
    }
    state.modelProfiles = state.modelProfiles.map(validateProfile);
    if (new Set(state.modelProfiles.map(profile => profile.id)).size !== state.modelProfiles.length) {
      throw new Error("Saved model profiles contain duplicate IDs; state was not changed.");
    }
    if (!state.modelProfiles.some(profile => profile.id === "copilot")) state.modelProfiles.unshift(COPILOT_PROFILE);
    state.defaultModelProfileId ??= "copilot";
    if (!state.modelProfiles.some(profile => profile.id === state.defaultModelProfileId) ||
      state.assignments!.some(assignment => !state.modelProfiles!.some(profile => profile.id === (assignment.modelProfileId ?? "copilot")))) {
      throw new Error("An assignment references an unavailable model profile; state was not changed.");
    }
    for (const assignment of state.assignments!) {
      assignment.modelProfileId ??= "copilot";
      const profile = state.modelProfiles.find(item => item.id === assignment.modelProfileId)!;
      if (assignment.modelProfile) {
        const saved = validateProfile(assignment.modelProfile);
        const entries = (value: ModelProfile) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
        if (entries(saved) !== entries(profile)) {
          throw new Error(`Assignment ${assignment.id} model profile changed since creation; refusing to resume.`);
        }
      } else {
        assignment.modelProfile = structuredClone(profile);
      }
    }
    if (!Array.isArray(state.progression)) throw new Error("Saved progression ledger is invalid; state was not changed.");
    progression(state.progression, state.personas!.map(persona => persona.id), state.assignments!, state.meetings);
    for (const agent of room.state.agents) {
      agent.review = undefined;
      if (agent.repository?.configuredProject && !room.canWrite(agent, agent.repository.configuredProject)) {
        agent.repository = undefined;
        agent.activity = "Configured worktree eligibility was revoked; worktree preserved";
      }
      if (agent.archived) continue;
      if (["thinking", "working", "permission"].includes(agent.phase)) {
        agent.phase = "interrupted";
        agent.activity = "Turn interrupted by restart";
        const draft = [...agent.messages].reverse().find(message => message.role === "assistant" && message.pending);
        if (draft) draft.pending = false;
      }
    }
    await room.publish();
    return room;
  }

  subscribe(listener: (room: Room) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.denyPending();
    };
  }

  private async publish(fromEconomy = false): Promise<void> {
    if (!fromEconomy) await this.economyQueue;
    this.state.revision++;
    for (const agent of this.state.agents) {
      const assignment = this.state.assignments?.find(item => item.id === agent.assignmentId);
      if (assignment) {
        assignment.messages = agent.messages;
        if (agent.repository) assignment.repository = agent.repository;
      }
    }
    const snapshot = structuredClone(this.state);
    const persisted = structuredClone(snapshot);
    for (const agent of persisted.agents) delete agent.trustedLocal;
    this.saving = this.saving.catch(error => {
      console.error("Previous room save failed:", error);
    }).then(() => this.store.write(persisted));
    await this.saving;
    for (const listener of this.listeners) listener(snapshot);
  }

  private async recordProgress(makeEvent: () => ProgressEvent): Promise<void> {
    const operation = this.economyQueue.then(async () => {
      const event = makeEvent();
      const ledger = this.state.progression!;
      progression([...ledger, event], this.state.personas!.map(persona => persona.id),
        this.state.assignments!, this.state.meetings!);
      ledger.push(event);
      try { await this.publish(true); }
      catch (error) {
        ledger.pop();
        throw error;
      }
    });
    this.economyQueue = operation.catch(() => {});
    return operation;
  }

  async confirmOutcome(input: { source: "assignment" | "review"; sourceId: string; personaId: string;
    evidence: string; specialty: Specialty; confirmed: boolean }): Promise<void> {
    if (input.confirmed !== true || !["assignment", "review"].includes(input.source) ||
      typeof input.sourceId !== "string" || typeof input.personaId !== "string" ||
      typeof input.evidence !== "string" || !SPECIALTIES.includes(input.specialty) ||
      input.evidence.trim().length < 10 || input.evidence.length > 500) {
      throw new Error("Explicit confirmation, a specialty and 10–500 characters of outcome evidence are required.");
    }

    await this.recordProgress(() => {
      const assignment = this.state.assignments!.find(item => item.id === input.sourceId);
      const meeting = this.state.meetings!.find(item => item.id === input.sourceId);
      if (input.source === "assignment" ?
        !assignment || assignment.personaId !== input.personaId || !assignmentEvidence(assignment) :
        !meeting || !reviewEvidence(meeting, input.personaId)) {
        throw new Error("Only a completed assignment with a user prompt and agent response, or a completed review with a recorded response, can earn an outcome.");
      }
      const event: ProgressEvent = { id: `${input.source}:${input.sourceId}:${input.source === "review" ? input.personaId : ""}`,
        kind: "reward", source: input.source, sourceId: input.sourceId, personaId: input.personaId,
        evidence: input.evidence.trim(), specialty: input.specialty, xp: input.source === "assignment" ? 20 : 10,
        credits: input.source === "assignment" ? 8 : 4, at: Date.now() };
      return event;
    });
  }

  async confirmMergedPr(input: { assignmentId: string; personaId: string; number: number;
    evidence: string; specialty: Specialty; confirmed: boolean }): Promise<void> {
    if (input.confirmed !== true || typeof input.assignmentId !== "string" ||
      typeof input.personaId !== "string" || !Number.isSafeInteger(input.number) || input.number < 1 ||
      typeof input.evidence !== "string" || input.evidence.trim().length < 10 ||
      input.evidence.length > 500 || !SPECIALTIES.includes(input.specialty)) {
      throw new Error("Confirm a PR number, attributed assignment, specialty and 10–500 characters of evidence.");
    }
    const assignment = this.state.assignments!.find(item => item.id === input.assignmentId);
    if (!assignment || assignment.personaId !== input.personaId || !assignment.repository?.remote) {
      throw new Error("The assignment must have a recorded verified GitHub repository for this persona.");
    }
    const verified = await this.verifyPr(assignment.repository.remote.fullName, input.number);
    if (verified.repository.toLowerCase() !== assignment.repository.remote.fullName.toLowerCase() ||
      verified.number !== input.number) throw new Error("Verified PR does not match the attributed repository and number.");
    await this.recordProgress(() => ({
      id: `merged-pr:${verified.repository.toLowerCase()}#${verified.number}:`,
      kind: "reward", source: "merged-pr", sourceId: `${verified.repository.toLowerCase()}#${verified.number}`,
      personaId: input.personaId, assignmentId: input.assignmentId, verifiedPr: verified,
      evidence: input.evidence.trim(), specialty: input.specialty, xp: 30, credits: 12, at: Date.now(),
    }));
  }

  async promote(personaId: string, rank: number, confirmed: boolean): Promise<void> {
    if (confirmed !== true || typeof personaId !== "string" || !Number.isInteger(rank) || rank < 1 ||
      rank >= RANKS.length) throw new Error("Confirm an eligible promotion.");
    await this.recordProgress(() => ({ id: `promotion:${personaId}:${rank}`, kind: "promotion",
      personaId, rank, at: Date.now() }));
  }

  async purchase(upgradeId: UpgradeId, confirmed: boolean): Promise<void> {
    if (confirmed !== true || !UPGRADES.some(item => item.id === upgradeId)) {
      throw new Error("Confirm a catalogued office upgrade.");
    }
    await this.recordProgress(() => ({ id: `purchase:${upgradeId}`, kind: "purchase", upgradeId,
      credits: -UPGRADES.find(item => item.id === upgradeId)!.price, at: Date.now() }));
  }

  private report(error: unknown, agent?: Agent): void {
    const message = this.redact(error);
    if (agent) {
      agent.phase = "error";
      agent.activity = message;
      agent.updatedAt = Date.now();
    } else {
      this.state.error = message;
    }
    void this.publish().catch(cause => console.error("Cannot save room:", cause));
  }

  private redact(text: unknown): string {
    return safeProviderError(text, process.env, this.state.modelProfiles?.flatMap(profile =>
      profile.credentialEnv ? [profile.credentialEnv] : []) ?? []);
  }

  connect(): Promise<void> {
    if (!this.connecting) {
      this.connecting = this.connectSessions().finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  private async connectSessions(): Promise<void> {
    try {
      await this.adapter.probe(this.profile(this.state.defaultModelProfileId!));
      this.state.connected = true;
      this.state.error = null;
    } catch (error) {
      this.state.connected = false;
      this.report(error);
      throw error;
    }

    for (const agent of this.state.agents) {
      if (agent.archived) continue;
      if (this.sessions.has(agent.id) && agent.phase !== "error") continue;
      try {
        if (this.sessions.has(agent.id)) {
          this.unsubscribers.get(agent.id)?.();
          await this.sessions.get(agent.id)!.disconnect();
          this.sessions.delete(agent.id);
          this.unsubscribers.delete(agent.id);
        }
        const session = await this.resumeAgent(agent);
        this.attach(agent.id, session);
        if (agent.phase === "error") {
          agent.phase = "idle";
          if (agent.activity !== "Empty session restored; no messages lost") agent.activity = "Ready to chat";
        }
      } catch (error) {
        this.report(error, agent);
      }
    }
    await this.publish();
  }

  private profile(id: string): ModelProfile {
    const profile = this.state.modelProfiles?.find(item => item.id === id);
    if (!profile) throw new Error(`Model profile ${id} is unavailable; session was not changed.`);
    return profile;
  }

  async addModelProfile(input: unknown): Promise<void> {
    const profile = validateProfile(input);
    if (this.state.modelProfiles!.some(item => item.id === profile.id)) throw new Error("Model profile ID already exists; profiles are immutable to preserve assignment provenance.");
    this.state.modelProfiles!.push(profile);
    await this.publish();
  }

  async chooseDefaultModelProfile(id: string): Promise<void> {
    const profile = this.profile(id);
    sessionModel(profile);
    this.state.defaultModelProfileId = id;
    await this.publish();
    await this.connect();
  }

  async listCopilotModels(): Promise<{ id: string; name: string }[]> {
    if (!this.adapter.listModels) throw new Error("Model listing is not supported by this adapter.");
    return this.adapter.listModels();
  }

  private async resumeAgent(agent: Agent, repository: RepositoryGrant | null = agent.repository ?? null): Promise<LiveSession> {
    const epoch = randomUUID();
    this.permissionEpochs.set(agent.id, epoch);
    this.toolStarts.delete(agent.id);
    const grant = repository ?? undefined;
    const profile = this.profile(this.state.assignments!.find(item => item.id === agent.assignmentId)!.modelProfileId!);
    if (grant?.remote) {
      if (!this.repositories) throw new Error("GitHub cache verifier unavailable; cannot resume a repository grant.");
      await this.repositories.verify(grant.remote);
    }
    try {
      const assignmentId = agent.assignmentId;
      const session = await this.adapter.resume(agent.sessionId, agent.workspace,
        (request, invocation) => this.permission(agent.id, request, assignmentId, invocation, epoch), grant,
        intent => this.requestAccessForAssignment(agent.id, assignmentId, intent),
        fullName => this.researchGrant(agent.id, assignmentId, fullName), profile,
        () => this.meetingTurns.has(agent.id), this.assignmentGuidance(agent));
      if (session.sessionId !== agent.sessionId) {
        await session.disconnect();
        throw new Error("SDK resumed a different session identity; repository access was not changed.");
      }
      return session;
    } catch (error) {
      if (agent.messages.length !== 0 || !(error instanceof Error) ||
        !error.message.includes(`Session not found: ${agent.sessionId}`)) throw error;
      const assignmentId = agent.assignmentId;
      const session = await this.adapter.create(agent.workspace,
        (request, invocation) => this.permission(agent.id, request, assignmentId, invocation, epoch), agent.sessionId, grant,
        intent => this.requestAccessForAssignment(agent.id, assignmentId, intent),
        fullName => this.researchGrant(agent.id, assignmentId, fullName), profile,
        () => this.meetingTurns.has(agent.id), this.assignmentGuidance(agent));
      if (session.sessionId !== agent.sessionId) {
        await session.disconnect();
        throw new Error("SDK returned a different identity for the empty-session recovery.");
      }
      agent.activity = "Empty session restored; no messages lost";
      return session;
    }
  }

  private availableDesk(preferred?: number): number | null {
    const occupied = new Set(this.state.agents.filter(agent => !agent.archived).map(agent => agent.deskIndex));
    for (const reserved of this.creating) occupied.add(reserved);
    if (preferred !== undefined && !occupied.has(preferred)) return preferred;
    return Array.from({ length: MAX_AGENTS }, (_, index) => index).find(index => !occupied.has(index)) ?? null;
  }

  async create(deskIndex: number): Promise<Agent> {
    if (!Number.isInteger(deskIndex) || deskIndex < 0 || deskIndex >= MAX_AGENTS) throw new Error("Invalid desk.");
    if (this.state.agents.filter(agent => !agent.archived).length + this.creating.size >= MAX_AGENTS) throw new Error("All office desks are occupied.");
    if (this.availableDesk(deskIndex) !== deskIndex) throw new Error("This desk is already occupied.");
    this.creating.add(deskIndex);
    const id = randomUUID();
    const epoch = randomUUID();
    this.permissionEpochs.set(id, epoch);
    const profile = this.profile(this.state.defaultModelProfileId!);
    sessionModel(profile);
    try {
      const workspace = await this.adapter.prepareWorkspace(this.state.workspace, id);
      const session = await this.adapter.create(workspace, (request, invocation) => this.permission(id, request, id, invocation, epoch), undefined, undefined,
        intent => this.requestAccessForAssignment(id, id, intent),
        fullName => this.researchGrant(id, id, fullName), profile, () => this.meetingTurns.has(id),
        personaGuidance({
          profile: { instructions: "", workingStyle: "", specialties: [], title: "", rank: "" }, memories: [] }));
      if (this.state.assignments!.some(assignment => assignment.sessionId === session.sessionId)) {
        throw new Error("SDK returned a session identity already assigned in recorded history.");
      }
      const now = Date.now();
      const occupied = new Set(this.state.agents.map(item => item.persona));
      const all = Array.from({ length: MAX_AGENTS }, (_, index) => index);
      const choices = all.filter(index => !occupied.has(index));
      if (!choices.length) {
        const active = new Set(this.state.agents.filter(item => !item.archived).map(item => item.persona));
        choices.push(...all.filter(index => !active.has(index)));
      }
      const persona = choices[Math.floor(Math.random() * choices.length)];
      const names = new Set(this.state.personas!.map(item => item.name));
      let name = uniqueAgentName(session.sessionId, names);
      while (this.state.personas!.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        names.add(name);
        name = uniqueAgentName(session.sessionId, names);
      }
      const agent: Agent = { id, deskIndex, archived: false, workspace, workspaceKind: "scratch", createdAt: now, updatedAt: now, idleSince: now, sessionId: session.sessionId, persona, name,
        personaId: id, assignmentId: id, phase: "idle", activity: "Ready to chat", messages: [] };
      this.state.agents.push(agent);
      this.state.personas!.push({ id, name, artId: persona, createdAt: now, updatedAt: now, setupCompleted: false,
        profile: { instructions: "", workingStyle: "", specialties: [], title: "", rank: "" }, memories: [], repositoryPolicies: [] });
      this.state.assignments!.push({ id, personaId: id, sessionId: session.sessionId, workspace,
        modelProfileId: profile.id, modelProfile: structuredClone(profile),
        personaGuidance: personaGuidance(this.persona(id)),
        startedAt: now, status: "active", messages: agent.messages });
      if (this.state.usage) this.state.usage.stale = true;
      this.attach(id, session);
      this.state.connected = true;
      this.state.error = null;
      await this.publish();
      return agent;
    } finally {
      this.creating.delete(deskIndex);
    }
  }

  private attach(agentId: string, session: LiveSession): void {
    this.sessions.set(agentId, session);
    this.unsubscribers.set(agentId, session.onEvent(event => {
      try { this.event(agentId, event); } catch (error) { this.report(error, this.agent(agentId)); }
    }));
  }

  private agent(agentId: string): Agent {
    const agent = this.state.agents.find(item => item.id === agentId);
    if (!agent) throw new Error("Unknown agent.");
    return agent;
  }

  private persona(personaId: string): AgentPersona {
    const persona = this.state.personas!.find(item => item.id === personaId);
    if (!persona) throw new Error("Unknown persona.");
    return persona;
  }

  private assignmentGuidance(agent: Agent): string {
    const assignment = this.state.assignments!.find(item => item.id === agent.assignmentId);
    if (!assignment || typeof assignment.personaGuidance !== "string") {
      throw new Error("Assignment persona guidance is missing; refusing to resume.");
    }
    return assignment.personaGuidance;
  }

  guidancePreview(personaId: string): { next: string; current: string | null } {
    const persona = this.persona(personaId);
    const agent = this.state.agents.find(item => item.personaId === personaId);
    return { next: personaGuidance(persona),
      current: agent ? this.assignmentGuidance(agent) : null };
  }

  private project(fullName: string) {
    return this.state.projects!.find(item => item.repository.fullName.toLowerCase() === fullName.toLowerCase());
  }

  private canRead(agent: Agent, fullName: string): boolean {
    if (agent.archived || this.lifecycle.has(agent.id) && agent.accessRequest?.status !== "cloning") return false;
    const project = this.project(fullName);
    if (!project) return false;
    const policy = this.persona(agent.personaId!).repositoryPolicies!.find(item =>
      item.fullName.toLowerCase() === fullName.toLowerCase());
    return !policy?.excluded && (!!policy?.read || !!policy?.write || project.sharedRead || !!project.sharedWrite ||
      agent.repository?.remote?.fullName.toLowerCase() === fullName.toLowerCase() &&
      ["task", "session", "edit"].includes(agent.repository.scope ?? ""));
  }

  private canWrite(agent: Agent, fullName: string): boolean {
    const project = this.project(fullName);
    if (!project) return false;
    const policy = this.persona(agent.personaId!).repositoryPolicies!.find(item =>
      item.fullName.toLowerCase() === fullName.toLowerCase());
    return !policy?.excluded && (!!policy?.write || !!project.sharedWrite);
  }

  async createMeeting(input: { kind: "meeting" | "review"; participantIds: string[]; agenda: string;
    sharedText: string; repository?: string; maxTurns: number }): Promise<Meeting> {
    if (!["meeting", "review"].includes(input.kind) || !Array.isArray(input.participantIds) ||
      input.participantIds.length < 2 || input.participantIds.length > 4 ||
      new Set(input.participantIds).size !== input.participantIds.length ||
      typeof input.agenda !== "string" || !input.agenda.trim() || input.agenda.length > 1000 ||
      typeof input.sharedText !== "string" || input.sharedText.length > 6000 ||
      input.kind === "review" && !input.sharedText.trim() ||
      !Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 8 ||
      input.repository !== undefined && (typeof input.repository !== "string" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))) {
      throw new Error("Choose 2–4 agents, an agenda, explicit review material, and 1–8 turns.");
    }
    if (this.state.meetings!.some(meeting => meeting.status === "open" || meeting.status === "running")) {
      throw new Error("Finish or cancel the current handoff before starting another.");
    }
    for (const id of input.participantIds) {
      const agent = this.agent(id);
      this.meetingAgent(agent, input.repository);
    }
    const now = Date.now();
    const meeting: Meeting = { id: randomUUID(), kind: input.kind, status: "open",
      participantIds: [...input.participantIds], agenda: input.agenda.trim(),
      sharedText: input.sharedText.trim(), repository: input.repository, maxTurns: input.maxTurns,
      nextIndex: 0, turns: [], summary: "", owners: [], createdAt: now, updatedAt: now };
    this.state.meetings!.push(meeting);
    await this.publish();
    return meeting;
  }

  private meeting(id: string): Meeting {
    const meeting = this.state.meetings!.find(item => item.id === id);
    if (!meeting) throw new Error("Unknown meeting.");
    return meeting;
  }

  private meetingAgent(agent: Agent, repository?: string): void {
    if (!this.persona(agent.personaId!).setupCompleted ||
      agent.archived || agent.phase !== "idle" || agent.review || agent.accessRequest ||
      this.lifecycle.has(agent.id) || !this.sessions.has(agent.id) || this.meetingTurns.has(agent.id)) {
      throw new Error(`${agent.name ?? "Agent"} is not available for this handoff.`);
    }
    if (repository && !this.canRead(agent, repository)) {
      throw new Error(`${agent.name ?? "Agent"} cannot read ${repository}; no material was shared.`);
    }
  }

  async advanceMeeting(id: string, handoffText = ""): Promise<void> {
    const meeting = this.meeting(id);
    if (meeting.status !== "open" || meeting.nextIndex >= meeting.maxTurns) {
      throw new Error("This meeting has no approved turns remaining.");
    }
    if (typeof handoffText !== "string" || handoffText.length > 4000) throw new Error("Handoff excerpt is too long.");
    const agentId = meeting.participantIds[meeting.nextIndex % meeting.participantIds.length];
    const agent = this.agent(agentId);
    this.meetingAgent(agent, meeting.repository);
    if (meeting.repository && meeting.participantIds.some(participantId =>
      !this.canRead(this.agent(participantId), meeting.repository!))) {
      throw new Error("A participant lost repository access; do not forward material from this project.");
    }
    if (this.redact(handoffText) !== handoffText || this.redact(meeting.sharedText) !== meeting.sharedText ||
      this.redact(meeting.agenda) !== meeting.agenda) throw new Error("Meeting material contains a configured credential.");
    const prompt = `Explicit ${meeting.kind} handoff (${meeting.nextIndex + 1}/${meeting.maxTurns}). ` +
      `Respond only to the supplied agenda and material. Do not use tools or consult other repositories or prior transcripts. ` +
      `Do not assume a repository grant or tool approval from this handoff.\n` +
      `Agenda:\n${meeting.agenda}\n` +
      `Shared material${meeting.repository ? ` (source: ${meeting.repository})` : ""}:\n${meeting.sharedText || "(none)"}\n` +
      `User-approved excerpt for this turn:\n${handoffText.trim() || "(none)"}\n` +
      `Give a concise actionable result, proposed owner and next step.`;
    if (prompt.length > 12000) throw new Error("Meeting prompt exceeds the SDK message limit.");
    meeting.status = "running";
    meeting.error = undefined;
    meeting.updatedAt = Date.now();
    const timer = setTimeout(() => {
      void this.stop(agentId).catch(error => {
        this.endMeetingTurn(agentId, "Timed-out handoff could not be stopped: " + this.redact(error));
        this.report(error, agent);
      });
    }, this.meetingTimeoutMs);
    this.meetingTurns.set(agentId, { meetingId: id, start: agent.messages.length, handoffText: handoffText.trim(), timer });
    try {
      await this.send(agentId, prompt, id);
    } catch (error) {
      this.endMeetingTurn(agentId, "Could not send handoff: " + this.redact(error));
      throw error;
    }
  }

  private endMeetingTurn(agentId: string, error?: string): void {
    const active = this.meetingTurns.get(agentId);
    if (!active) return;
    clearTimeout(active.timer);
    this.meetingTurns.delete(agentId);
    const meeting = this.meeting(active.meetingId);
    if (meeting.status !== "running") return;
    const agent = this.agent(agentId);
    if (!error) {
      const response = agent.messages.slice(active.start).filter(message => message.role === "assistant" && !message.pending)
        .map(message => message.content).join("\n").slice(0, 6000);
      if (response.trim()) {
        meeting.turns.push({ agentId, handoffText: active.handoffText, response, at: Date.now() });
        meeting.nextIndex++;
        meeting.status = "open";
      } else error = "The agent finished without a response; review its transcript before proceeding.";
    }
    if (error) { meeting.status = "interrupted"; meeting.error = error; }
    meeting.updatedAt = Date.now();
    void this.publish().catch(cause => console.error("Cannot save meeting result:", cause));
  }

  async cancelMeeting(id: string): Promise<void> {
    const meeting = this.meeting(id);
    if (!["open", "running", "interrupted"].includes(meeting.status)) throw new Error("Meeting already ended.");
    const active = [...this.meetingTurns.entries()].find(([, turn]) => turn.meetingId === id);
    if (active) {
      try {
        await this.stop(active[0]);
      } catch (error) {
        meeting.status = "interrupted";
        meeting.error = "SDK could not confirm cancellation: " + this.redact(error);
        meeting.updatedAt = Date.now();
        await this.publish();
        throw error;
      }
    }
    meeting.status = "cancelled";
    meeting.updatedAt = Date.now();
    await this.publish();
  }

  async finishMeeting(id: string, summary: string, owners: { agentId: string; task: string }[]): Promise<void> {
    const meeting = this.meeting(id);
    if (!["open", "interrupted"].includes(meeting.status)) throw new Error("Wait for the turn or cancel the meeting.");
    if (typeof summary !== "string" || !summary.trim() || summary.length > 4000 ||
      !Array.isArray(owners) || owners.length > 4 || owners.some(owner =>
        !owner || !meeting.participantIds.includes(owner.agentId) || typeof owner.task !== "string" ||
        !owner.task.trim() || owner.task.length > 500)) throw new Error("Add a decision summary and up to four participant follow-ups.");
    if (this.redact(summary) !== summary || owners.some(owner => this.redact(owner.task) !== owner.task)) {
      throw new Error("Meeting result contains a configured credential.");
    }
    meeting.summary = summary.trim();
    meeting.owners = owners.map(owner => {
      const assignment = this.state.assignments!.find(item => item.id ===
        this.state.agents.find(agent => agent.id === owner.agentId)?.assignmentId) ??
        [...this.state.assignments!].reverse().find(item => item.personaId === owner.agentId);
      return { agentId: owner.agentId, task: owner.task.trim(), assignmentId: assignment?.id };
    });
    for (const owner of meeting.owners) {
      if (owner.assignmentId) this.state.assignments!.find(item => item.id === owner.assignmentId)!.followUps ??= [];
      if (owner.assignmentId) this.state.assignments!.find(item => item.id === owner.assignmentId)!.followUps!.push({
        meetingId: id, task: owner.task
      });
    }
    meeting.status = "completed";
    meeting.updatedAt = Date.now();
    await this.publish();
  }

  private interruptMeetings(agentId: string): void {
    for (const meeting of this.state.meetings!) {
      if (meeting.status === "open" && meeting.participantIds.includes(agentId)) {
        meeting.status = "interrupted";
        meeting.error = "A participant's assignment or availability changed; finish partial results or cancel.";
        meeting.updatedAt = Date.now();
      }
    }
  }

  private async researchGrant(agentId: string, assignmentId: string | undefined, fullName: string): Promise<RepositoryGrant | undefined> {
    const agent = this.state.agents.find(item => item.id === agentId);
    if (!agent || agent.assignmentId !== assignmentId || !this.canRead(agent, fullName)) return undefined;
    const project = this.project(fullName)!;
    const active = agent.repository;
    if (active?.remote?.fullName.toLowerCase() === fullName.toLowerCase() &&
      active.remote.url === project.repository.url && active.remote.ref === project.repository.defaultBranch &&
      active.remote.privacy === project.repository.privacy &&
      ["task", "session", "edit"].includes(active.scope ?? "")) {
      if (!this.repositories) throw new Error("GitHub cache verifier unavailable; cannot research this repository.");
      await this.repositories.verify(active.remote);
      if (active.worktree) await validateResearchWorktree(active);
      return agent.assignmentId === assignmentId && this.canRead(agent, fullName) ? active : undefined;
    }
    const snapshot = await this.snapshotFor(project.repository, false, new AbortController().signal);
    if (agent.assignmentId !== assignmentId || !this.canRead(agent, fullName)) return undefined;
    await this.repositories!.verify(snapshot);
    if (agent.assignmentId !== assignmentId || !this.canRead(agent, fullName)) return undefined;
    return { path: snapshot.path, name: snapshot.fullName, remote: snapshot, scope: "session" };
  }

  async lookupProject(hint: string): Promise<RemoteRepository[]> {
    if (!this.repositories) throw new Error("GitHub repository discovery is unavailable.");
    return (await this.repositories.lookup(hint)).map(validateRemoteRepository);
  }

  private async verifiedProject(repository: RemoteRepository): Promise<RemoteRepository> {
    if (!this.repositories) throw new Error("GitHub repository discovery is unavailable.");
    validateRemoteRepository(repository);
    const matches = await this.repositories.lookup(repository.fullName);
    const verified = matches.find(item => item.fullName === repository.fullName &&
      item.url === repository.url && item.defaultBranch === repository.defaultBranch &&
      item.privacy === repository.privacy && item.sizeKiB === repository.sizeKiB);
    if (!verified) throw new Error("GitHub identity or default branch changed. Look up the project again.");
    return verified;
  }

  async addProject(repository: RemoteRepository, sharedRead: boolean, sharedWrite = false): Promise<void> {
    if (typeof sharedRead !== "boolean" || typeof sharedWrite !== "boolean") throw new Error("Choose valid office project eligibility.");
    const verified = await this.verifiedProject(repository);
    if (this.project(verified.fullName)) throw new Error("Project already exists; change its sharing policy instead.");
    this.state.projects!.push({ repository: verified, sharedRead, sharedWrite });
    await this.publish();
  }

  private cancelProjectRequests(fullName: string, personaId?: string): void {
    for (const agent of this.state.agents) {
      if (personaId && agent.personaId !== personaId) continue;
      const request = agent.accessRequest;
      if (!request) continue;
      // A short-name lookup might still be resolving; require a fresh human review
      // rather than guessing which policy its pending candidate will match.
      this.clones.get(agent.id)?.abort();
      this.resolveAccess(agent.id, request.id, "denied", `Policy for ${fullName} changed; review access again.`);
    }
  }

  async shareProject(fullName: string, sharedRead: boolean): Promise<void> {
    const project = this.project(fullName);
    if (!project || typeof sharedRead !== "boolean") throw new Error("Choose a catalogued GitHub project and sharing setting.");
    project.sharedRead = sharedRead;
    if (!sharedRead) this.cancelProjectRequests(fullName);
    await this.publish();
  }

  async setProjectWrite(fullName: string, sharedWrite: boolean): Promise<void> {
    const project = this.project(fullName);
    if (!project || typeof sharedWrite !== "boolean") throw new Error("Choose a catalogued GitHub project and write eligibility.");
    project.sharedWrite = sharedWrite;
    if (!sharedWrite) this.cancelProjectRequests(fullName);
    await this.revokeIneligibleWorktrees(fullName);
    await this.publish();
  }

  private async revokeIneligibleWorktrees(fullName: string): Promise<void> {
    for (const agent of this.state.agents) {
      if (agent.repository?.configuredProject?.toLowerCase() !== fullName.toLowerCase() ||
        this.canWrite(agent, fullName)) continue;
      if (agent.archived) {
        agent.repository = undefined;
        continue;
      }
      if (["thinking", "working", "permission"].includes(agent.phase)) await this.stop(agent.id, "project eligibility revoked");
      await this.revokeRepository(agent.id);
    }
  }

  async setPersonaProject(personaId: string, fullName: string, choice: "read" | "write" | "remove" | "exclude" | "inherit"): Promise<void> {
    const persona = this.persona(personaId);
    const project = this.project(fullName);
    if (!project) throw new Error("Add a verified GitHub project to the office catalog first.");
    if (!["read", "write", "remove", "exclude", "inherit"].includes(choice)) throw new Error("Unknown project policy decision.");
    persona.repositoryPolicies = persona.repositoryPolicies!.filter(item =>
      item.fullName.toLowerCase() !== fullName.toLowerCase());
    if (choice === "read") persona.repositoryPolicies.push({ fullName: project.repository.fullName, read: true, excluded: false });
    if (choice === "write") persona.repositoryPolicies.push({ fullName: project.repository.fullName, read: true, write: true, excluded: false });
    // Removing read access must not silently restore an assignment or office grant.
    if (choice === "exclude" || choice === "remove") persona.repositoryPolicies.push({
      fullName: project.repository.fullName, read: false, excluded: true
    });
    persona.updatedAt = Date.now();
    if (choice !== "write") this.cancelProjectRequests(fullName, personaId);
    await this.revokeIneligibleWorktrees(fullName);
    await this.publish();
  }

  async editPersona(personaId: string, input: {
    name: string; artId: number; instructions: string; workingStyle: string; specialties: string[]; title: string; rank: string
  }): Promise<void> {
    const persona = this.persona(personaId);
    const name = input.name.trim();
    if (!name || name.length > 80 || !Number.isInteger(input.artId) || input.artId < 0 || input.artId >= MAX_AGENTS ||
      typeof input.instructions !== "string" || input.instructions.length > 600 ||
      [input.workingStyle, input.title, input.rank].some(value => typeof value !== "string" || value.length > 1000) ||
      !Array.isArray(input.specialties) || input.specialties.length > 20 ||
      input.specialties.some(value => typeof value !== "string" || !value.trim() || value.length > 80)) {
      throw new Error("Invalid persona profile.");
    }
    if (this.state.personas!.some(other => other.id !== personaId &&
      other.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("Persona name must be unique.");
    const agent = this.state.agents.find(item => item.personaId === personaId);
    if (agent && this.lifecycle.has(agent.id)) throw new Error("Persona is changing assignments.");
    if (agent && !agent.archived && this.state.agents.some(other => other.id !== agent.id &&
      !other.archived && other.persona === input.artId)) throw new Error("This art is already in use at an active desk.");
    const nextProfile = { instructions: input.instructions.trim(), workingStyle: input.workingStyle.trim(),
      specialties: input.specialties.map(s => s.trim()), title: input.title.trim(), rank: input.rank.trim() };
    if (personaGuidance({ profile: nextProfile, memories: persona.memories }).length > MAX_GUIDANCE_LENGTH) {
      throw new Error("Persona guidance exceeds the assignment limit.");
    }
    persona.name = name;
    persona.artId = input.artId;
    persona.profile = nextProfile;
    persona.updatedAt = Date.now();
    if (agent) { agent.name = name; agent.persona = input.artId; agent.updatedAt = persona.updatedAt; }
    await this.publish();
  }

  async completePersonaSetup(personaId: string): Promise<void> {
    const persona = this.persona(personaId);
    if (persona.setupCompleted) throw new Error("Persona setup is already complete.");
    if (!persona.profile.instructions.trim() && !persona.profile.workingStyle.trim()) {
      throw new Error("Add behavior instructions or a working style before completing setup.");
    }
    const agent = this.state.agents.find(item => item.personaId === personaId);
    if (!agent || agent.messages.length || agent.archived) {
      throw new Error("Initial persona setup requires an active, unused assignment.");
    }
    this.availableForLifecycle(agent);
    const assignment = this.state.assignments!.find(item => item.id === agent.assignmentId)!;
    const previous = assignment.personaGuidance!;
    const guidance = personaGuidance(persona);
    if (guidance.length > MAX_GUIDANCE_LENGTH) throw new Error("Persona guidance exceeds the assignment limit.");
    this.lifecycle.add(agent.id);
    try {
      const session = this.sessions.get(agent.id);
      if (session) {
        await session.disconnect();
        this.unsubscribers.get(agent.id)?.();
        this.sessions.delete(agent.id);
        this.unsubscribers.delete(agent.id);
      }
      assignment.personaGuidance = guidance;
      try {
        if (session) this.attach(agent.id, await this.resumeAgent(agent));
      } catch (error) {
        assignment.personaGuidance = previous;
        throw error;
      }
      persona.setupCompleted = true;
      persona.updatedAt = Date.now();
      await this.publish();
    } finally {
      this.lifecycle.delete(agent.id);
    }
  }

  async addMemory(personaId: string, text: string, provenance: string): Promise<void> {
    const persona = this.persona(personaId);
    if (typeof text !== "string" || !text.trim() || text.length > 500 ||
      typeof provenance !== "string" || !provenance.trim() || provenance.length > 160 ||
      persona.memories.length >= MAX_MEMORIES) {
      throw new Error("Memory requires a note (max 500 characters), provenance (max 160), and space among 12 approved notes.");
    }
    const note = { id: randomUUID(), text: text.trim(), provenance: provenance.trim(), approvedAt: Date.now() };
    if (personaGuidance({ profile: persona.profile, memories: [...persona.memories, note] }).length > MAX_GUIDANCE_LENGTH) {
      throw new Error("Persona guidance exceeds the assignment limit.");
    }
    persona.memories.push(note);
    persona.updatedAt = Date.now();
    await this.publish();
  }

  async removeMemory(personaId: string, memoryId: string): Promise<void> {
    const persona = this.persona(personaId);
    const index = persona.memories.findIndex(item => item.id === memoryId);
    if (index < 0) throw new Error("Unknown memory note.");
    persona.memories.splice(index, 1);
    persona.updatedAt = Date.now();
    await this.publish();
  }

  async newAssignment(agentId: string, outcome = "", modelProfileId?: string): Promise<void> {
    const agent = this.agent(agentId);
    if (agent.archived) throw new Error("Restore this persona before assigning new work.");
    this.availableForLifecycle(agent);
    if (!this.sessions.has(agentId)) throw new Error("Connect this persona's SDK session before switching assignments.");
    if (outcome.length > 1000) throw new Error("Outcome is too long.");
    const previous = this.state.assignments!.find(item => item.id === agent.assignmentId)!;
    if (!this.persona(agent.personaId!).setupCompleted) {
      throw new Error("Complete this persona's setup before starting another assignment.");
    }
    const profile = this.profile(modelProfileId ?? previous.modelProfileId!);
    const guidance = personaGuidance(this.persona(agent.personaId!));
    if (guidance.length > MAX_GUIDANCE_LENGTH) throw new Error("Persona guidance exceeds the assignment limit.");
    sessionModel(profile);
    this.lifecycle.add(agentId);
    const assignmentId = randomUUID();
    const epoch = randomUUID();
    const previousEpoch = this.permissionEpochs.get(agentId);
    this.permissionEpochs.set(agentId, epoch);
    this.toolStarts.delete(agentId);
    try {
      const workspace = await this.adapter.prepareWorkspace(this.state.workspace, assignmentId);
      const session = await this.adapter.create(workspace,
        (request, invocation) => this.permission(agentId, request, assignmentId, invocation, epoch),
        undefined, undefined, intent => this.requestAccessForAssignment(agentId, assignmentId, intent),
        fullName => this.researchGrant(agentId, assignmentId, fullName), profile,
        () => this.meetingTurns.has(agentId), guidance);
      if (this.state.assignments!.some(item => item.sessionId === session.sessionId)) {
        throw new Error("SDK returned an existing session identity; assignment was not changed.");
      }
      try {
        await this.sessions.get(agentId)!.disconnect();
      } catch (error) {
        await session.disconnect();
        throw error;
      }
      this.unsubscribers.get(agentId)?.();
      this.sessions.delete(agentId);
      this.unsubscribers.delete(agentId);
      previous.status = "completed";
      this.clearTrustedLocal(agentId);
      previous.endedAt = Date.now();
      previous.outcome = outcome.trim();
      previous.messages = agent.messages;
      if (agent.repository) previous.repository = agent.repository;
      agent.assignmentId = assignmentId;
      agent.sessionId = session.sessionId;
      agent.workspace = workspace;
      agent.workspaceKind = "scratch";
      agent.repository = undefined;
      agent.messages = [];
      agent.phase = "idle";
      agent.activity = "New assignment · no repository access";
      agent.updatedAt = Date.now();
      agent.idleSince = agent.updatedAt;
      this.armedTaskGrants.delete(agentId);
      this.state.assignments!.push({ id: assignmentId, personaId: agent.personaId!, sessionId: session.sessionId,
        workspace, modelProfileId: profile.id, modelProfile: structuredClone(profile), personaGuidance: guidance,
        startedAt: agent.updatedAt, status: "active", messages: agent.messages });
      this.interruptMeetings(agentId);
      this.attach(agentId, session);
      if (this.state.usage) this.state.usage.stale = true;
      await this.publish();
    } finally {
      if (agent.assignmentId !== assignmentId) {
        if (previousEpoch) this.permissionEpochs.set(agentId, previousEpoch);
        else this.permissionEpochs.delete(agentId);
      }
      this.lifecycle.delete(agentId);
    }
  }

  private availableForLifecycle(agent: Agent): void {
    if (this.lifecycle.has(agent.id)) throw new Error("This agent is already being archived, restored or sent home.");
    if (agent.review || agent.accessRequest || ["thinking", "working", "permission"].includes(agent.phase)) {
      throw new Error("Wait for the turn to finish or decide the pending permission before changing this agent.");
    }
  }

  async archive(agentId: string): Promise<void> {
    const agent = this.agent(agentId);
    if (agent.archived) throw new Error("This agent is already archived.");
    this.availableForLifecycle(agent);
    this.lifecycle.add(agentId);
    try {
      await this.sessions.get(agentId)?.disconnect();
      this.clearTrustedLocal(agentId);
      this.unsubscribers.get(agentId)?.();
      this.unsubscribers.delete(agentId);
      this.sessions.delete(agentId);
      agent.lastDeskIndex = agent.deskIndex!;
      agent.deskIndex = null;
      agent.archived = true;
      agent.archivedAt = Date.now();
      agent.activity = "Archived; conversation and SDK session preserved";
      agent.updatedAt = Date.now();
      this.interruptMeetings(agentId);
      if (this.state.usage) this.state.usage.stale = true;
      await this.publish();
    } finally {
      this.lifecycle.delete(agentId);
    }
  }

  async restore(agentId: string): Promise<void> {
    const agent = this.agent(agentId);
    if (!agent.archived) throw new Error("This agent is already in the office.");
    this.availableForLifecycle(agent);
    if (this.availableDesk(agent.lastDeskIndex) === null) throw new Error("Office full (16 desks). Archive an agent before restoring this one.");
    if (this.state.agents.some(other => !other.archived && other.persona === agent.persona)) {
      throw new Error("This agent's sprite persona is in use by another office agent. Archive that agent before restoring; identity was not changed.");
    }
    this.lifecycle.add(agentId);
    try {
      const session = await this.resumeAgent(agent);
      const deskIndex = this.availableDesk(agent.lastDeskIndex);
      if (deskIndex === null) {
        await session.disconnect();
        throw new Error("Office full (16 desks). Archive an agent before restoring this one.");
      }
      agent.deskIndex = deskIndex;
      agent.archived = false;
      agent.archivedAt = undefined;
      agent.phase = "idle";
      agent.activity = "Ready to chat";
      agent.updatedAt = Date.now();
      agent.idleSince = agent.updatedAt;
      if (this.state.usage) this.state.usage.stale = true;
      this.attach(agentId, session);
      await this.publish();
    } finally {
      this.lifecycle.delete(agentId);
    }
  }

  async fire(agentId: string, retention: "keep" | "delete-sdk"): Promise<void> {
    if (retention !== "keep" && retention !== "delete-sdk") throw new Error("Choose a retention policy.");
    const agent = this.agent(agentId);
    this.availableForLifecycle(agent);
    this.lifecycle.add(agentId);
    try {
      await this.sessions.get(agentId)?.disconnect();
      this.clearTrustedLocal(agentId);
      this.unsubscribers.get(agentId)?.();
      this.unsubscribers.delete(agentId);
      this.sessions.delete(agentId);
      if (retention === "delete-sdk") {
        try {
          await this.adapter.deleteSession(agent.sessionId);
        } catch (error) {
          this.report(error, agent);
          throw error;
        }
      }
      const assignment = this.state.assignments!.find(item => item.id === agent.assignmentId)!;
      assignment.status = "completed";
      assignment.endedAt = Date.now();
      assignment.outcome = "Persona fired; files and recorded assignment history retained";
      assignment.retention = retention;
      this.state.agents.splice(this.state.agents.indexOf(agent), 1);
      this.interruptMeetings(agentId);
      if (this.state.usage) this.state.usage.stale = true;
      await this.publish();
    } finally {
      this.lifecycle.delete(agentId);
    }
  }

  async sendHome(agentId: string): Promise<void> {
    await this.fire(agentId, "delete-sdk");
  }

  requestAccess(agentId: string, intent: AccessIntent): Promise<string> {
    const agent = this.agent(agentId);
    if (agent.archived || this.stopped.has(agentId) || !this.listeners.size || agent.accessRequest || agent.review ||
      this.lifecycle.has(agentId) || this.meetingTurns.has(agentId)) {
      return Promise.resolve(JSON.stringify({ status: "denied", reason: "No available browser or another request is pending." }));
    }
    const id = randomUUID();
    agent.accessRequest = { id, repoHint: intent.repoHint.slice(0, 150), purpose: intent.purpose.slice(0, 500),
      scope: intent.scope, status: "resolving", progress: "Checking GitHub identity (no clone yet)" };
    agent.phase = "permission";
    agent.activity = "Waiting for repository access decision";
    agent.updatedAt = Date.now();
    void this.publish().catch(error => console.error("Cannot save access request:", error));
    const decision = new Promise<string>(resolveResult => {
      const timer = setTimeout(() => this.resolveAccess(agentId, id, "denied", "Repository request timed out."), EXPIRE_MS);
      this.access.set(id, { agentId, resolve: resolveResult, timer });
    });
    void this.findRepository(agentId, id, intent.repoHint).catch(error => {
      if (agent.accessRequest?.id !== id) return;
      agent.accessRequest.status = "error";
      agent.accessRequest.error = error instanceof Error ? error.message : String(error);
      agent.accessRequest.progress = undefined;
      void this.publish().catch(cause => console.error("Cannot save access lookup failure:", cause));
    });
    return decision;
  }

  private requestAccessForAssignment(agentId: string, assignmentId: string | undefined, intent: AccessIntent): Promise<string> {
    if (this.state.agents.find(agent => agent.id === agentId)?.assignmentId !== assignmentId) {
      return Promise.resolve(JSON.stringify({ status: "denied", reason: "This SDK assignment is no longer active." }));
    }
    return this.requestAccess(agentId, intent);
  }

  guidedAccess(agentId: string): RepositoryRequest {
    const agent = this.agent(agentId);
    if (agent.archived || agent.accessRequest || agent.review || this.lifecycle.has(agentId) || !this.listeners.size ||
      ["thinking", "working", "permission"].includes(agent.phase)) {
      throw new Error("This agent cannot request repository access right now.");
    }

    const request: RepositoryRequest = { id: randomUUID(), repoHint: "", purpose: "Research or edit a GitHub repository",
      scope: "edit", status: "error", error: "Enter an owner/repo or repository name to look up; no clone has started." };
    agent.accessRequest = request;
    void this.publish().catch(error => console.error("Cannot save guided request:", error));
    return request;
  }

  async prepareProjectWorktree(agentId: string, fullName: string): Promise<RepositoryRequest> {
    const agent = this.agent(agentId);
    if (!this.canWrite(agent, fullName)) throw new Error("No effective write eligibility for this verified project.");
    const project = this.project(fullName)!;
    const verified = await this.verifiedProject(project.repository);
    if (!this.canWrite(agent, fullName) || this.project(fullName)?.repository !== project.repository) {
      throw new Error("Project eligibility changed; request a new assignment.");
    }
    const request = this.guidedAccess(agentId);
    request.repoHint = verified.fullName;
    request.purpose = "Assign this verified project to this task's edit worktree";
    request.configuredProject = verified.fullName;
    request.candidates = [verified];
    request.status = "review";
    request.error = undefined;
    request.progress = "Review this task's worktree assignment; tools need approval unless you separately opt into trusted-local autonomy.";
    await this.publish();
    return request;
  }

  async findRepository(agentId: string, id: string, hint: string): Promise<void> {
    const agent = this.agent(agentId);
    const request = agent.accessRequest;
    if (!request || request.id !== id || this.lifecycle.has(agentId) || request.status === "cloning") {
      throw new Error("Repository request is stale or already being provisioned.");
    }
    if (request.configuredProject) throw new Error("Configured worktree identity cannot be changed; deny and request another project.");
    if (!this.repositories) throw new Error("GitHub repository discovery is unavailable.");
    request.repoHint = hint;
    request.status = "resolving";
    request.error = undefined;
    request.candidates = undefined;
    request.progress = "Checking GitHub identity (no clone yet)";
    const lookup = (this.lookups.get(id) ?? 0) + 1;
    this.lookups.set(id, lookup);
    await this.publish();
    try {
      const candidates = (await this.repositories.lookup(hint)).map(validateRemoteRepository);
      if (agent.accessRequest !== request || request.status !== "resolving" || this.lookups.get(id) !== lookup) return;
      request.candidates = candidates;
      request.status = "review";
      request.progress = candidates.length > 1 ? "Choose the exact owner/repo before approving." : "Ready for your decision; no clone yet.";
    } catch (error) {
      if (agent.accessRequest !== request || request.status !== "resolving" || this.lookups.get(id) !== lookup) return;
      request.status = "error";
      request.error = error instanceof Error ? error.message : String(error);
      request.progress = undefined;
    }
    await this.publish();
  }

  private async snapshotFor(repository: RemoteRepository, fresh: boolean, signal: AbortSignal): Promise<RepositorySnapshot> {
    if (!this.repositories) throw new Error("GitHub clone service unavailable.");
    const key = repository.fullName.toLowerCase();
    const cached = !fresh && this.state.snapshots?.find(snapshot =>
      snapshot.fullName.toLowerCase() === key && snapshot.ref === repository.defaultBranch &&
      snapshot.privacy === repository.privacy && snapshot.url === repository.url &&
      Date.now() - snapshot.fetchedAt < CACHE_AGE_MS);
    if (cached) {
      await this.repositories.verify(cached);
      return cached;
    }
    const snapshot = await this.repositories.provision(repository, signal);
    if (signal.aborted) throw new Error("Repository clone cancelled; no access granted.");
    this.state.snapshots!.unshift(snapshot);
    await this.publish();
    return snapshot;
  }

  private resolveAccess(agentId: string, id: string, status: string, reason?: string, grant?: RepositoryGrant): void {
    const agent = this.agent(agentId);
    if (agent.accessRequest?.id !== id) throw new Error("Repository request is stale or belongs to another agent.");
    const pending = this.access.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.access.delete(id);
      pending.resolve(JSON.stringify({ status, reason, repository: grant?.name, scope: grant?.scope,
        worktree: grant?.worktree?.path }));
    }
    agent.accessRequest = undefined;
    this.lookups.delete(id);
    agent.updatedAt = Date.now();
    if (agent.phase === "permission") agent.phase = "thinking";
    agent.activity = status === "approved" ? `Repository access: ${grant?.name}` : reason ?? "Repository access denied";
    void this.publish().catch(error => console.error("Cannot save access decision:", error));
  }

  async decideAccess(agentId: string, id: string, choice: "deny" | "task" | "session" | "persona" | "office" | "edit",
    fullName?: string, fresh = false): Promise<void> {
    const agent = this.agent(agentId);
    const request = agent.accessRequest;
    if (!request || request.id !== id || this.lifecycle.has(agentId)) throw new Error("Repository request is stale or belongs to another agent.");
    if (choice === "deny") {
      if (request.status === "cloning") throw new Error("Clone is in progress; use Stop to cancel this turn.");
      this.resolveAccess(agentId, id, "denied", "User denied repository access.");
      return;
    }
    if (request.status !== "review" || !fullName || !request.candidates?.length) {
      throw new Error("Choose a verified GitHub repository before granting access.");
    }
    if (choice === "edit" && request.scope !== "edit") throw new Error("This agent requested read access, not edit access.");
    if (request.configuredProject && (choice !== "edit" ||
      fullName.toLowerCase() !== request.configuredProject.toLowerCase() ||
      !this.canWrite(agent, fullName))) {
      throw new Error("Configured worktree assignment requires current write eligibility for this project.");
    }
    const candidate = request.candidates.find(item => item.fullName === fullName);
    if (!candidate) throw new Error("Repository identity was not offered in this agent's request.");
    const session = this.sessions.get(agentId);
    if (!session || agent.archived) throw new Error("This agent must be connected before access can be granted.");
    const controller = new AbortController();
    this.clones.set(agentId, controller);
    const pending = this.access.get(id);
    if (pending) clearTimeout(pending.timer);
    request.status = "cloning";
    request.progress = `Preparing ${candidate.fullName} · ${candidate.defaultBranch} in the app-managed cache…`;
    this.lifecycle.add(agentId);
    let switchedDirectory = false;
    let committed = false;
    const previousRepository = agent.repository;
    try {
      await this.publish();
      const snapshot = await this.snapshotFor(candidate, fresh, controller.signal);
      if (controller.signal.aborted || agent.accessRequest !== request) return;
      if (request.configuredProject && !this.canWrite(agent, candidate.fullName)) {
        throw new Error("Write eligibility was revoked while provisioning the worktree.");
      }
      const grant = await validateRepository(snapshot.path);
      let next: RepositoryGrant = { ...grant, name: snapshot.fullName,
        remote: snapshot, scope: choice === "task" ? "task" : "session" };
      if (choice === "edit") {
        this.clearTrustedLocal(agentId);
        next = await createResearchWorktree(this.worktreeRoot, next, agentId);
        if (request.configuredProject) next.configuredProject = request.configuredProject;
        this.state.worktrees!.push({ agentId, repository: snapshot.fullName, path: next.worktree!.path, branch: next.worktree!.branch });
        await this.publish();
        if (controller.signal.aborted || agent.accessRequest !== request) return;
        try {
          switchedDirectory = true;
          await session.setWorkingDirectory(next.worktree!.path);
        } catch (error) {
          throw new Error(`Created worktree at ${next.worktree!.path} (branch ${next.worktree!.branch}), but SDK could not change this session's working directory. Worktree preserved for manual inspection. ${String(error)}`);
        }
      } else if (agent.repository?.worktree && (choice === "task" || choice === "session")) {
        switchedDirectory = true;
        await session.setWorkingDirectory(agent.workspace);
      }
      if (controller.signal.aborted || agent.accessRequest !== request) return;
      const existing = this.project(candidate.fullName);
      if (existing && (existing.repository.url !== candidate.url ||
        existing.repository.defaultBranch !== candidate.defaultBranch ||
        existing.repository.privacy !== candidate.privacy)) {
        throw new Error("Catalogued GitHub identity changed; recheck the project before granting access.");
      }
      if (!existing) this.state.projects!.push({ repository: candidate, sharedRead: false });
      if (choice === "persona" || choice === "office") {
        const persona = this.persona(agent.personaId!);
        persona.repositoryPolicies = persona.repositoryPolicies!.filter(item =>
          item.fullName.toLowerCase() !== candidate.fullName.toLowerCase());
        persona.repositoryPolicies.push({ fullName: candidate.fullName, read: true, excluded: false });
        persona.updatedAt = Date.now();
        if (choice === "office") this.project(candidate.fullName)!.sharedRead = true;
      } else {
        agent.repository = next;
      }
      if (choice === "task" && agent.phase === "idle") this.armedTaskGrants.add(agentId);
      else this.armedTaskGrants.delete(agentId);
      await this.publish();
      committed = true;
      this.resolveAccess(agentId, id, "approved", undefined, next);
    } catch (error) {
      if (!committed) agent.repository = previousRepository;
      if (agent.accessRequest === request) {
        request.status = "error";
        request.error = error instanceof Error ? error.message : String(error);
        request.progress = undefined;
        const waiting = this.access.get(id);
        if (waiting) waiting.timer = setTimeout(() =>
          this.resolveAccess(agentId, id, "denied", "Repository request timed out."), EXPIRE_MS);
        await this.publish();
      }
      throw error;
    } finally {
      if (switchedDirectory && !committed) {
        try {
          await session.setWorkingDirectory(previousRepository?.worktree?.path ?? agent.workspace);
        } catch (error) {
          this.report(new Error(`Could not restore the prior SDK working directory after repository access failed. ${String(error)}`), agent);
        }
      }
      this.clones.delete(agentId);
      this.lifecycle.delete(agentId);
    }
  }

  async revokeRepository(agentId: string): Promise<void> {
    const agent = this.agent(agentId);
    this.availableForLifecycle(agent);
    this.clearTrustedLocal(agentId);
    this.lifecycle.add(agentId);
    try {
      if (agent.repository?.worktree && !agent.archived) {
        const session = this.sessions.get(agentId);
        if (!session) throw new Error("SDK session unavailable; could not leave the worktree.");
        await session.setWorkingDirectory(agent.workspace);
      }
      const preserved = agent.repository?.worktree?.path;
      const fullName = agent.repository?.remote?.fullName;
      agent.repository = undefined;
      this.armedTaskGrants.delete(agentId);
      if (fullName && this.project(fullName)?.sharedRead) {
        const persona = this.persona(agent.personaId!);
        persona.repositoryPolicies = persona.repositoryPolicies!.filter(item => item.fullName.toLowerCase() !== fullName.toLowerCase());
        persona.repositoryPolicies.push({ fullName, read: false, excluded: true });
      }
      if (fullName) this.cancelProjectRequests(fullName, agent.personaId);
      agent.activity = preserved ? `Assignment access revoked; worktree preserved at ${preserved}` :
        "Assignment access revoked; persona or office read access may remain";
      await this.publish();
    } finally {
      this.lifecycle.delete(agentId);
    }
  }

  async refreshUsage(): Promise<void> {
    if (!this.state.connected) throw new Error("Connect to the SDK before loading usage.");
    let tokens = 0, calls = 0, filesChanged = 0, measured = 0;
    let startedAt: string | undefined;
    for (const agent of this.state.agents) {
      let temporary: LiveSession | undefined;
      try {
        if (agent.archived) temporary = await this.resumeAgent(agent);
        const metrics = await (temporary ?? this.sessions.get(agent.id))?.getUsage();
        if (!metrics) continue;
        measured++;
        tokens += metrics.tokens;
        calls += metrics.calls;
        filesChanged += metrics.filesChanged;
        if (!startedAt || metrics.startedAt < startedAt) startedAt = metrics.startedAt;
      } catch (error) {
        console.error(`Usage unavailable for agent ${agent.id}:`, error);
      } finally {
        if (temporary) await temporary.disconnect();
      }
    }
    const total = this.state.agents.length;
    this.state.usage = { status: measured === 0 ? "unavailable" : measured === total ? "ready" : "partial",
      measured, total, tokens, calls, filesChanged, startedAt, updatedAt: Date.now() };
    await this.publish();
  }

  async setRepository(agentId: string, path: string | null): Promise<void> {
    if (path !== null) throw new Error("Local paths cannot become project grants. Select a verified GitHub project.");
    const agent = this.agent(agentId);
    this.availableForLifecycle(agent);
    this.lifecycle.add(agentId);
    try {
      const repository: RepositoryGrant | undefined = path === null ? undefined : await validateRepository(path);
      if (repository?.path === agent.repository?.path) return;
      if (agent.archived) {
        agent.repository = repository;
      } else {
        const current = this.sessions.get(agentId);
        if (!current) throw new Error("Agent unavailable. Retry its SDK connection before changing repository access.");
        await current.disconnect();
        this.unsubscribers.get(agentId)?.();
        this.sessions.delete(agentId);
        this.unsubscribers.delete(agentId);
        try {
          this.attach(agentId, await this.resumeAgent(agent, repository ?? null));
        } catch (error) {
          try { this.attach(agentId, await this.resumeAgent(agent)); }
          catch (restoreError) { this.report(restoreError, agent); }
          throw error;
        }
        agent.repository = repository;
      }
      agent.updatedAt = Date.now();
      agent.activity = repository ? `Research access: ${repository.name} (tracked files only)` : "Repository research access revoked";
      await this.publish();
    } finally {
      this.lifecycle.delete(agentId);
    }
  }

  async stop(agentId: string, reason = "user"): Promise<void> {
    const agent = this.agent(agentId);
    if (agent.archived || (this.lifecycle.has(agentId) && agent.accessRequest?.status !== "cloning") ||
      !["thinking", "working", "permission"].includes(agent.phase)) {
      throw new Error("No active turn to stop for this agent.");
    }
    const session = this.sessions.get(agentId);
    if (!session) throw new Error("Agent SDK session is unavailable; cannot confirm cancellation.");
    this.lifecycle.add(agentId);
    this.clearTrustedLocal(agentId);
    this.stopping.add(agentId);
    const message = reason === "user" ? "Turn stopped by user" : `Turn stopped: ${reason}`;
    try {
      this.clones.get(agentId)?.abort();
      const abort = session.abort();
      for (const [id, pending] of this.pending) {
        if (pending.agentId !== agentId) continue;
        clearTimeout(pending.timer);
        pending.resolve({ kind: "reject", feedback: `${message}.` });
        this.pending.delete(id);
      }
      if (agent.accessRequest) this.resolveAccess(agentId, agent.accessRequest.id, "denied", `${message}.`);
      if (agent.repository?.scope === "task") agent.repository = undefined;
      this.armedTaskGrants.delete(agentId);
      await abort;
      this.endMeetingTurn(agentId, "Turn stopped; partial response remains in the agent transcript.");
      agent.review = undefined;
      const last = agent.messages.at(-1);
      if (last?.pending) last.pending = false;
      this.stopped.add(agentId);
      agent.phase = "idle";
      agent.activity = `${message} · ready to chat`;
      agent.messages.push({ id: randomUUID(), role: "system", content: `${message}.` });
      agent.updatedAt = Date.now();
      agent.idleSince = agent.updatedAt;
      await this.publish();
    } catch (error) {
      this.endMeetingTurn(agentId, "Could not stop handoff: " + this.redact(error));
      this.report(error, agent);
      throw error;
    } finally {
      this.stopping.delete(agentId);
      this.lifecycle.delete(agentId);
    }
  }

  async send(agentId: string, text: string, meetingId?: string): Promise<void> {
    const agent = this.agent(agentId);
    if (!this.persona(agent.personaId!).setupCompleted) throw new Error("Complete this persona's setup before chatting.");
    if (agent.archived || this.lifecycle.has(agentId)) throw new Error("This agent is not active in the office.");
    const meetingTurn = this.meetingTurns.get(agentId);
    if (meetingTurn && meetingTurn.meetingId !== meetingId) throw new Error("This agent has an approved meeting turn in progress.");
    const session = this.sessions.get(agentId);
    if (!session) throw new Error("Session unavailable. Retry connection before sending.");
    const prompt = text.trim();
    if (!prompt || prompt.length > 12000) throw new Error("Prompt must contain 1–12000 characters.");
    if (this.redact(prompt) !== prompt) throw new Error("Prompt contains a configured credential; remove it before sending.");
    if (["thinking", "working", "permission"].includes(agent.phase)) throw new Error("Wait for the current turn to finish.");
    this.stopped.delete(agentId);
    this.armedTaskGrants.delete(agentId);
    agent.messages.push({ id: randomUUID(), role: "user", content: prompt });
    if (this.state.usage) this.state.usage.stale = true;
    agent.phase = "thinking";
    agent.activity = "Thinking";
    agent.updatedAt = Date.now();
    await this.publish();
    try {
      await session.send(prompt);
    } catch (error) {
      agent.activity = "Message was not sent";
      this.report(error, agent);
      throw error;
    }
  }

  private event(agentId: string, event: SessionEvent): void {
    const agent = this.agent(agentId);
    if (agent.archived) return;
    if (this.stopping.has(agentId) || this.stopped.has(agentId) && event.type !== "session.idle") return;
    if (event.type === "tool.execution_start" && ["thinking", "working", "permission"].includes(agent.phase)) {
      const { toolCallId, toolName, mcpServerName, mcpConfigServerName, mcpToolName } = event.data;
      if (toolCallId && !mcpServerName && !mcpConfigServerName && !mcpToolName &&
        ROUTINE_TOOLS[toolName] && !event.agentId) {
        const starts = this.toolStarts.get(agentId) ?? new Map();
        starts.set(toolCallId, { name: toolName, kind: ROUTINE_TOOLS[toolName] });
        this.toolStarts.set(agentId, starts);
      }
    }
    if (event.type === "tool.execution_complete") this.toolStarts.get(agentId)?.delete(event.data.toolCallId);
    switch (event.type) {
      case "assistant.message_delta": {
        const delta = event.data.deltaContent;
        if (!delta) break;
        let draft = agent.messages.at(-1);
        if (!draft || draft.role !== "assistant" || !draft.pending) {
          draft = { id: randomUUID(), role: "assistant", content: "", pending: true };
          agent.messages.push(draft);
        }
        draft.content = this.redact(draft.content + delta);
        agent.phase = "thinking";
        agent.activity = "Speaking";
        break;
      }
      case "assistant.message": {
        const last = agent.messages.at(-1);
        if (last?.role === "assistant" && last.pending) {
          last.content = this.redact(event.data.content);
          last.pending = false;
        } else if (event.data.content) {
          agent.messages.push({ id: randomUUID(), role: "assistant", content: this.redact(event.data.content) });
        }
        break;
      }
      case "tool.execution_start":
        agent.phase = "working";
        agent.activity = `Using ${event.data.toolName || "a tool"}`;
        break;
      case "tool.execution_complete":
        agent.phase = "thinking";
        agent.activity = event.data.error ? "Tool finished with an error" : "Tool finished";
        break;
      case "session.idle":
        this.toolStarts.delete(agentId);
        if (agent.repository?.scope === "task" && !this.armedTaskGrants.has(agentId)) agent.repository = undefined;
        if (agent.phase !== "idle") agent.idleSince = Date.now();
        agent.phase = "idle";
        agent.activity = this.stopped.has(agentId) ? "Turn stopped by user · ready to chat" : "Ready to chat";
        if (this.meetingTurns.has(agentId)) this.endMeetingTurn(agentId);
        break;
      case "session.error":
        this.toolStarts.delete(agentId);
        agent.phase = "error";
        agent.activity = event.data.message ? this.redact(event.data.message) : "SDK session error";
        this.endMeetingTurn(agentId, agent.activity);
        break;
      default:
        return;
    }
    agent.updatedAt = Date.now();
    void this.publish().catch(error => console.error("Cannot save SDK event:", error));
  }

  private clearTrustedLocal(agentId: string): void {
    this.trustedLocal.delete(agentId);
    this.toolStarts.delete(agentId);
    const agent = this.state.agents.find(item => item.id === agentId);
    if (agent) agent.trustedLocal = false;
  }

  async setTrustedLocal(agentId: string, assignmentId: string, enabled: boolean): Promise<void> {
    const agent = this.agent(agentId);
    if (typeof enabled !== "boolean" || agent.assignmentId !== assignmentId || agent.archived ||
      this.lifecycle.has(agentId)) throw new Error("Select an active agent and its current assignment.");
    if (!enabled) {
      this.clearTrustedLocal(agentId);
      await this.publish();
      return;
    }
    if (agent.review || agent.accessRequest || agent.phase !== "idle" || !this.sessions.has(agentId) ||
      !this.listeners.size || !agent.repository?.worktree || !agent.repository.configuredProject ||
      !this.canWrite(agent, agent.repository.configuredProject)) {
      throw new Error("Autonomous local work requires an idle, connected edit assignment in an eligible worktree and an open browser.");
    }
    this.trustedLocal.set(agentId, { assignmentId, sessionId: agent.sessionId,
      worktreePath: agent.repository.worktree.path });
    agent.trustedLocal = true;
    const notice = { id: randomUUID(), role: "system" as const, content:
      "Trusted-local autonomy enabled for this agent's current edit assignment. Built-in routine tools may run as your account without individual prompts; this is not sandboxed." };
    agent.messages.push(notice);
    try { await this.publish(); }
    catch (error) {
      this.clearTrustedLocal(agentId);
      agent.messages.splice(agent.messages.indexOf(notice), 1);
      throw error;
    }
  }

  private permission(agentId: string, request: PermissionRequest, assignmentId?: string,
    invocation?: { sessionId: string; managedSettingsEnabled?: boolean }, epoch?: string): Promise<PermissionRequestResult> {
    const agent = this.state.agents.find(item => item.id === agentId);
    if (!agent || agent.assignmentId !== assignmentId || epoch !== this.permissionEpochs.get(agentId)) {
      return Promise.resolve({ kind: "reject", feedback: "This SDK assignment is no longer active." });
    }
    if (this.stopping.has(agentId) || this.stopped.has(agentId)) {
      return Promise.resolve({ kind: "reject", feedback: "This SDK turn was stopped." });
    }
    if (this.meetingTurns.has(agentId)) {
      return Promise.resolve({ kind: "reject", feedback: "Meeting handoffs are limited to shared material; tools require a separate ordinary turn." });
    }
    const requiresHuman = "managedApprovalRequired" in request && request.managedApprovalRequired === true;
    const consent = this.trustedLocal.get(agentId);
    const start = request.toolCallId && this.toolStarts.get(agentId)?.get(request.toolCallId);
    if (consent && start && !requiresHuman && invocation?.managedSettingsEnabled !== true &&
      invocation?.sessionId === agent.sessionId &&
      !agent.archived && !this.lifecycle.has(agentId) &&
      ["thinking", "working", "permission"].includes(agent.phase) &&
      !agent.review && !agent.accessRequest && this.listeners.size &&
      consent.assignmentId === assignmentId && consent.sessionId === agent.sessionId &&
      consent.worktreePath === agent.repository?.worktree?.path &&
      !!agent.repository?.configuredProject && this.canWrite(agent, agent.repository.configuredProject) &&
      start.kind === request.kind && ROUTINE_TOOLS[start.name] === request.kind &&
      !(("requestSandboxBypass" in request) && request.requestSandboxBypass === true) &&
      (request.kind !== "shell" || typeof request.fullCommandText === "string") &&
      (request.kind !== "write" || typeof request.fileName === "string") &&
      (request.kind !== "read" || typeof request.path === "string")) {
      this.toolStarts.get(agentId)?.delete(request.toolCallId!);
      agent.messages.push({ id: randomUUID(), role: "system",
        content: `Trusted-local autoapproval: ${start.name} (${request.kind}), tool call ${request.toolCallId}.` });
      agent.updatedAt = Date.now();
      void this.publish().catch(error => console.error("Cannot save trusted-local decision:", error));
      return Promise.resolve({ kind: "approve-once" });
    }
    if (request.toolCallId) this.toolStarts.get(agentId)?.delete(request.toolCallId);
    if (!requiresHuman && invocation?.managedSettingsEnabled !== true &&
      request.kind === "custom-tool" && request.toolName === "research_attached_repository") {
      const name = typeof request.args === "object" && request.args !== null &&
        "repository" in request.args && typeof request.args.repository === "string" ? request.args.repository : "";
      const valid = typeof request.args === "object" && request.args !== null &&
        "action" in request.args && (request.args.action === "list" || request.args.action === "read") &&
        "path" in request.args && typeof request.args.path === "string" &&
        Object.keys(request.args).sort().join(",") === "action,path,repository";
      if (!valid) return Promise.resolve({ kind: "reject", feedback: "Invalid bounded repository research request." });
      return Promise.resolve(this.canRead(agent, name) ?
        { kind: "approve-once" } : { kind: "reject", feedback: "No active repository research grant." });
    }
    if (!requiresHuman && invocation?.managedSettingsEnabled !== true &&
      request.kind === "custom-tool" && request.toolName === "request_repository_access") {
      return Promise.resolve(agent && !agent.archived && !this.lifecycle.has(agentId) ? { kind: "approve-once" } :
        { kind: "reject", feedback: "Agent unavailable." });
    }
    if (!this.listeners.size || !agent || agent.archived || this.lifecycle.has(agentId) || agent.review) {
      return Promise.resolve({ kind: "user-not-available" });
    }
    const id = randomUUID();
    const review: Review = {
      id,
      kind: request.kind,
      tool: "toolName" in request ? String(request.toolName) : request.kind,
      detail: JSON.stringify(request, null, 2)
    };
    agent.review = review;
    agent.phase = "permission";
    agent.activity = "Waiting for your decision";
    agent.updatedAt = Date.now();
    void this.publish().catch(error => console.error("Cannot save permission request:", error));
    return new Promise(resolve => {
      const timer = setTimeout(() => this.decide(agentId, id, false, true), EXPIRE_MS);
      this.pending.set(id, { agentId, resolve, timer });
    });
  }

  decide(agentId: string, id: string, allow: boolean, expired = false): void {
    const pending = this.pending.get(id);
    const agent = this.state.agents.find(item => item.id === agentId);
    if (!pending || pending.agentId !== agentId || agent?.review?.id !== id) throw new Error("Permission request is stale or belongs to another agent.");
    clearTimeout(pending.timer);
    this.pending.delete(id);
    agent.review = undefined;
    agent.phase = "thinking";
    agent.activity = allow ? "Approved once; waiting for tool" : expired ? "Permission timed out" : "Tool denied";
    agent.updatedAt = Date.now();
    void this.publish().catch(error => console.error("Cannot save permission decision:", error));
    pending.resolve(allow ? { kind: "approve-once" } : { kind: "reject", feedback: expired ? "No human decision before timeout." : "User denied this action." });
  }

  private denyPending(): void {
    for (const agentId of this.trustedLocal.keys()) this.clearTrustedLocal(agentId);
    for (const controller of this.clones.values()) controller.abort();
    for (const [id, pending] of this.access) {
      this.resolveAccess(pending.agentId, id, "denied", "No browser available; request denied.");
    }
    if (!this.pending.size) return;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ kind: "user-not-available" });
      this.pending.delete(id);
      const agent = this.agent(pending.agentId);
      agent.review = undefined;
      agent.phase = "interrupted";
      agent.activity = "No browser available; tool denied";
      agent.updatedAt = Date.now();
    }
    void this.publish().catch(error => console.error("Cannot save permission disconnect:", error));
  }

  async close(): Promise<void> {
    this.denyPending();
    this.permissionEpochs.clear();
    this.toolStarts.clear();
    for (const [agentId] of this.meetingTurns) this.endMeetingTurn(agentId, "Handoff interrupted by server shutdown.");
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    try {
      const results = await Promise.allSettled([...this.sessions.values()].map(session => session.disconnect()));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } finally {
      await this.adapter.stop();
      await this.economyQueue;
      await this.saving;
    }
  }
}
