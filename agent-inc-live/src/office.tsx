import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@base-ui/react/button";
import { Disclosure, SelectField, Toggle } from "./controls";
import "../../agent-inc/app/styles.css";
import "../live.css";
import "../sdk-chat.css";
import "../overview.css";
import "../controls.css";
import { MAX_AGENTS, type Agent as ServerAgent, type Room as ServerRoom } from "../../server/types";
import {
  COFFEE_SPOTS, DESKS, initialProgress, Simulation,
} from "../../agent-inc/game/simulation";
import type { Agent, Request } from "../../agent-inc/game/simulation";
import { sampleDaylight } from "../../agent-inc/game/lighting";
import { deskPresence, nextDeskBreak } from "../../agent-inc/game/desk-behavior";
import {
  EXTRA_DESKS, LIVE_COFFEE_Z, MAX_LIVE_DESKS, MIN_LIVE_DESKS,
  assignLoungeSpots, routeAroundDividers,
} from "../../agent-inc/game/live-layout";
import {
  HAPPY_MACHINES_BADGE, HAPPY_MACHINES_DARK_MARK, HAPPY_MACHINES_MARK, HAPPY_MACHINES_WORDMARK, PIXEL_LETTERS,
  agentPortrait, happyMachinesFavicon,
} from "../../agent-inc/game/sprite-art";
import { createWorld } from "../../agent-inc/game/world";
import { effectiveProjectAccess, groupedProjectAccess, noticeActivityForActor, roomActors } from "./room";
import type { Actor, PersonaRepositoryPolicy, ProjectPolicy, Room as OfficeRoom, Status } from "./room";
import { SafeMarkdown } from "./markdown";
import { greetingForPersona } from "./greeting";
import type { ModelProfile } from "../../server/providers";
import type { RemoteRepository } from "../../server/github-repositories";
import { progression, RANKS, SPECIALTIES, UPGRADES, assignmentEvidence, reviewEvidence,
  type ProgressEvent, type Specialty } from "../../server/progression";

const LIVE_DESKS = [...DESKS, ...EXTRA_DESKS];
const LIVE_COFFEE_SPOTS = COFFEE_SPOTS.map(({ x }) => ({ x, z: LIVE_COFFEE_Z + 0.75 }));
const STEP = 1 / 30;
const connectedStatus = "Live local Copilot SDK office";
const themeKey = "agentcorp-harness-theme";
type AgentPersona = {
  id: string; name: string; artId: number; createdAt: number; updatedAt: number;
  setupCompleted?: boolean;
  profile: { workingStyle: string; specialties: string[]; title: string; rank: string; instructions?: string };
  memories: { id: string; text: string; provenance: string; approvedAt: number }[];
  repositoryPolicies?: PersonaRepositoryPolicy[];
};
type Assignment = {
  id: string; personaId: string; sessionId: string; workspace: string;
  repository?: ServerAgent["repository"]; startedAt: number; endedAt?: number;
  outcome?: string; status: "active" | "completed" | "interrupted";
  messages: ServerAgent["messages"]; modelProfileId?: string; modelProfile?: ModelProfile;
};
type SdkAgent = ServerAgent & { personaId?: string; assignmentId?: string };
type Meeting = {
  id: string; kind: "meeting" | "review"; status: "open" | "running" | "completed" | "cancelled" | "interrupted";
  agenda: string; participantIds: string[]; sharedText: string; repository?: string; maxTurns: number;
  turns: { agentId: string; handoffText: string; response: string; at: number }[]; nextIndex: number;
  summary: string; owners: { agentId: string; task: string; assignmentId?: string }[];
  createdAt: number; updatedAt: number; error?: string;
};
type SdkRoom = ServerRoom & { agents: SdkAgent[]; personas?: AgentPersona[]; assignments?: Assignment[];
  projects?: ProjectPolicy[]; meetings?: Meeting[] };
type DeskActor = Actor & { idleSince?: number };
function personaFor(room: SdkRoom | null, agent: SdkAgent | undefined): AgentPersona | undefined {
  return room?.personas?.find(persona => persona.id === agent?.personaId);
}
function agentName(room: SdkRoom | null, agent: SdkAgent | undefined): string {
  return personaFor(room, agent)?.name || agent?.name || agent?.id || "Agent";
}
function agentArt(room: SdkRoom | null, agent: SdkAgent): number {
  return personaFor(room, agent)?.artId ?? agent.persona ?? 0;
}
function isActive(agent: SdkAgent): agent is SdkAgent & { deskIndex: number } {
  return !agent.archived && agent.deskIndex !== null;
}
const wordmarkPaths = [...HAPPY_MACHINES_WORDMARK.toUpperCase()].map((letter, index) =>
  PIXEL_LETTERS[letter].flatMap((row, y) =>
    [...row].flatMap((bit, x) => bit === "1" ? [`M${index * 6 + x} ${y}h1v1h-1z`] : []),
  ).join(""));

function officeRoom(room: SdkRoom | null): OfficeRoom {
  if (!room) return { currentSessionId: "", sessions: [] };
  return {
    currentSessionId: "",
    sessions: room.agents.map(agent => {
      const status: Status = agent.archived ? "offline" :
        agent.phase === "working" ? "tool" :
        agent.phase === "permission" ? "blocked" :
        agent.phase === "thinking" ? "thinking" :
        agent.phase === "idle" ? "idle" : "offline";
      return {
      sessionId: agent.sessionId,
      status, activity: agent.activity, tools: [],
      subagents: [], messages: agent.messages.length,
      ...(status === "tool" ? { recentTool: { kind: "Working" as const, at: Date.now() } } : {}),
      events: agent.messages.slice(-6).map((message, index) => ({
        kind: "message" as const,
        label: message.role === "user" ? "Message sent" : message.pending ? "Response streaming" : "Assistant replied",
        at: agent.updatedAt + index
      })),
      updatedAt: agent.updatedAt, seenAt: agent.createdAt
    }; })
  };
}

function deskActors(room: SdkRoom): (DeskActor | null)[] {
  const names = new Map(room.agents.map(agent => [agent.sessionId, agentName(room, agent)]));
  const bySession = new Map(roomActors(officeRoom(room)).map(actor => [actor.key, {
    ...actor, name: names.get(actor.key) ?? actor.name
  }]));
  const active = room.agents.filter(isActive);
  const slots: (DeskActor | null)[] = Array.from({ length: Math.max(0, ...active.map(agent => agent.deskIndex + 1)) }, () => null);
  for (const agent of active) {
    const actor = bySession.get(agent.sessionId);
    slots[agent.deskIndex] = actor ? {
      ...actor, idleSince: agent.phase === "idle" ? agent.idleSince ?? agent.updatedAt : undefined,
    } : null;
  }
  return slots;
}

async function post(path: string, body: Record<string, unknown>): Promise<SdkRoom> {
  const response = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: SdkRoom & { error?: string } = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function makeAgent(id: number): Agent {
  return {
    id, state: "idle", x: 100, z: 100, target: { x: 100, z: 100 },
    route: [], workLeft: 0, workTotal: 0, visitedContext: false,
  };
}

function makeScene() {
  const scene = new Simulation(initialProgress());
  scene.agents = Array.from({ length: MIN_LIVE_DESKS }, (_, id) => makeAgent(id));
  scene.requests = [];
  scene.progress.capacity = 0;
  scene.progress.context = false;
  scene.progress.workflow = 1;
  return scene;
}

function applyRoom(scene: Simulation, actors: (DeskActor | null)[], occupied: boolean[], now = Date.now()) {
  const shown = actors.slice(0, MAX_LIVE_DESKS);
  while (scene.agents.length < shown.length) scene.agents.push(makeAgent(scene.agents.length));
  scene.agents.length = Math.max(MIN_LIVE_DESKS, shown.length);
  scene.progress.capacity = shown.length;
  scene.requests = [];
  const presence = shown.map(actor => actor ? deskPresence(actor.status, actor.idleSince, now) : null);
  const loungeSpots = assignLoungeSpots(presence.slice(MIN_LIVE_DESKS).map(value => value === "break"));
  shown.forEach((actor, id) => {
    const agent = scene.agents[id];
    if (!actor) {
      occupied[id] = false;
      agent.x = agent.z = 100;
      agent.target = { x: 100, z: 100 };
      agent.route = [];
      agent.taskId = undefined;
      agent.state = "idle";
      agent.deskIdle = false;
      return;
    }
    const busy = presence[id] === "working";
    const destination = presence[id] !== "break" ? LIVE_DESKS[id] :
      id < MIN_LIVE_DESKS ? LIVE_COFFEE_SPOTS[id] : loungeSpots[id - MIN_LIVE_DESKS];
    if (!destination) throw new Error(`Missing idle destination for worker ${id}`);
    if (!occupied[id]) {
      agent.x = destination.x;
      agent.z = destination.z;
    }
    occupied[id] = true;
    agent.deskIdle = presence[id] === "waiting";
    if (agent.target.x !== destination.x || agent.target.z !== destination.z) {
      agent.route = routeAroundDividers(agent, destination);
    }
    agent.target = { ...destination };
    if (busy) {
      agent.taskId = id + 1;
      const status: Request["status"] = actor.status === "blocked" ? "failed" :
        actor.status === "thinking" ? "assigned" : "working";
      scene.requests.push({
        id: id + 1, stationId: id, title: actor.activity, kind: "chat",
        status, progress: 0, reward: 0,
        ...(status === "failed" ? { resolvedAt: scene.time } : {}),
      });
    } else {
      agent.taskId = undefined;
    }
  });
  for (let id = shown.length; id < scene.agents.length; id++) {
    occupied[id] = false;
    const agent = scene.agents[id];
    agent.x = agent.z = 100;
    agent.target = { x: 100, z: 100 };
    agent.route = [];
    agent.taskId = undefined;
    agent.state = "idle";
    agent.deskIdle = false;
  }
  occupied.length = scene.agents.length;
}

function updatePersonas(world: ReturnType<typeof createWorld> | undefined, room: SdkRoom): void {
  if (!world) return;
  for (const agent of room.agents) {
    if (isActive(agent)) world.setAgentPersona(agent.deskIndex, agentArt(room, agent));
  }
}

function moveAgents(scene: Simulation, delta: number) {
  for (let id = 0; id < scene.progress.capacity; id++) {
    const agent = scene.agents[id];
    const waypoint = agent.route[0] ?? agent.target;
    const dx = waypoint.x - agent.x;
    const dz = waypoint.z - agent.z;
    const distance = Math.hypot(dx, dz);
    const busy = agent.taskId !== undefined;
    if (distance > 0.02) {
      const step = Math.min(distance, 2.05 * delta);
      agent.x += dx / distance * step;
      agent.z += dz / distance * step;
      agent.state = busy ? "walking" : "returning";
    } else {
      agent.x = waypoint.x;
      agent.z = waypoint.z;
      if (agent.route.length) agent.route.shift();
      agent.state = agent.route.length || Math.hypot(agent.target.x - agent.x, agent.target.z - agent.z) > 0.02 ?
        busy ? "walking" : "returning" : busy ? "working" : "idle";
    }
  }
}

function LiveOffice() {
  const [sdkRoom, setSdkRoom] = useState<SdkRoom | null>(null);
  const [connection, setConnection] = useState("Connecting to local Copilot SDK…");
  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState<"office" | "store" | "agents" | "meetings">("office");
  const [meetingKind, setMeetingKind] = useState<Meeting["kind"]>("meeting");
  const [meetingParticipants, setMeetingParticipants] = useState<string[]>([]);
  const [meetingAgenda, setMeetingAgenda] = useState("");
  const [meetingSharedText, setMeetingSharedText] = useState("");
  const [meetingRepository, setMeetingRepository] = useState("");
  const [meetingMaxTurns, setMeetingMaxTurns] = useState(4);
  const [meetingId, setMeetingId] = useState("");
  const [meetingHandoffs, setMeetingHandoffs] = useState<Record<string, string>>({});
  const [meetingSummary, setMeetingSummary] = useState("");
  const [meetingOwners, setMeetingOwners] = useState<Record<string, string>>({});
  const [meetingBusy, setMeetingBusy] = useState(false);
  const [previewOffset, setPreviewOffset] = useState(0);
  const [selected, setSelected] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hover, setHover] = useState<{ name: string; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [repoHint, setRepoHint] = useState("");
  const [projectHint, setProjectHint] = useState("");
  const [projectCandidates, setProjectCandidates] = useState<RemoteRepository[]>([]);
  const [projectCandidate, setProjectCandidate] = useState("");
  const [projectLookingUp, setProjectLookingUp] = useState(false);
  const [projectChooserOpen, setProjectChooserOpen] = useState(false);
  const [projectAccessChoice, setProjectAccessChoice] = useState<"read" | "write">("read");
  const [projectSaving, setProjectSaving] = useState(false);
  const [selectedRepository, setSelectedRepository] = useState("");
  const [freshSnapshot, setFreshSnapshot] = useState(false);
  const [copiedId, setCopiedId] = useState("");
  const [actionError, setActionError] = useState("");
  const [searchCapability, setSearchCapability] = useState("Checking web search availability…");
  const [menuAgentId, setMenuAgentId] = useState<string | null>(null);
  const [deskChoice, setDeskChoice] = useState<{ kind: "create" } |
    { kind: "move"; agentId: string; deskIndex: number } | { kind: "restore"; agentId: string } | null>(null);
  const [deskTarget, setDeskTarget] = useState<{ index: number; occupantId: string | null } | null>(null);
  const [deskBusy, setDeskBusy] = useState(false);
  const [chatOptionsOpen, setChatOptionsOpen] = useState(false);
  const [editingRepoHint, setEditingRepoHint] = useState(false);
  const [confirmAgentId, setConfirmAgentId] = useState<string | null>(null);
  const [confirmIdentity, setConfirmIdentity] = useState("");
  const [retention, setRetention] = useState<"keep" | "delete-sdk">("keep");
  const [confirmError, setConfirmError] = useState("");
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);
  const [assignmentAgentId, setAssignmentAgentId] = useState<string | null>(null);
  const [assignmentOutcome, setAssignmentOutcome] = useState("");
  const [assignmentModelProfileId, setAssignmentModelProfileId] = useState("");
  const [assignmentSubmitting, setAssignmentSubmitting] = useState(false);
  const [outcomeTarget, setOutcomeTarget] = useState<{ source: "assignment" | "review" | "merged-pr"; sourceId: string; personaId: string } | null>(null);
  const [outcomeEvidence, setOutcomeEvidence] = useState("");
  const [prNumber, setPrNumber] = useState("");
  const [outcomeSpecialty, setOutcomeSpecialty] = useState<Specialty>("Engineering");
  const [outcomeConfirmed, setOutcomeConfirmed] = useState(false);
  const [modelDraft, setModelDraft] = useState({
    id: "", kind: "ollama" as ModelProfile["kind"], model: "", endpoint: "http://127.0.0.1:11434/v1",
    credentialEnv: "", wireApi: "completions" as "completions" | "responses", wireModel: "",
    maxPromptTokens: "", maxOutputTokens: "", maxContextWindowTokens: "", azureApiVersion: "",
    supportsVision: false, supportsReasoningEffort: false
  });
  const [copilotModels, setCopilotModels] = useState<{ id: string; name: string }[] | null>(null);
  const [profileEditingId, setProfileEditingId] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState({
    name: "", artId: 0, workingStyle: "", instructions: "", specialties: "", title: "",
  });
  const [guidancePreview, setGuidancePreview] = useState<{ next: string; current: string | null } | null>(null);
  const [guidanceLoading, setGuidanceLoading] = useState(false);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, { text: string; provenance: string }>>({});
  const [profileBusy, setProfileBusy] = useState(false);
  const [themePreference, setThemePreference] = useState<"system" | "light" | "dark">(() => {
    const saved = localStorage.getItem(themeKey);
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const host = useRef<HTMLDivElement>(null);
  const activityToggle = useRef<HTMLButtonElement>(null);
  const activityClose = useRef<HTMLButtonElement>(null);
  const agentDetailBack = useRef<HTMLButtonElement>(null);
  const editAgentButton = useRef<HTMLButtonElement>(null);
  const chatOptionsButton = useRef<HTMLButtonElement>(null);
  const restoreChatScroll = useRef<number | null>(null);
  const returnAgentFocus = useRef<"edit" | "settings" | null>(null);
  const storeEntry = useRef<HTMLButtonElement>(null);
  const storeBack = useRef<HTMLButtonElement>(null);
  const returnStoreFocus = useRef(false);
  const sceneRef = useRef<Simulation | null>(null);
  const worldRef = useRef<ReturnType<typeof createWorld> | null>(null);
  const actorsRef = useRef<(DeskActor | null)[]>([]);
  const nextBreakRef = useRef(Infinity);
  const occupiedRef = useRef<boolean[]>(Array(MIN_LIVE_DESKS).fill(false));
  const hoverDeskRef = useRef<number | null>(null);
  const hoverLabelRef = useRef<HTMLDivElement>(null);
  const confirmCheckboxRef = useRef<HTMLInputElement>(null);
  const confirmTriggerRef = useRef<HTMLButtonElement>(null);
  const deskTriggerRef = useRef<HTMLElement | null>(null);
  const deskDialogRef = useRef<HTMLDivElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const seenReviews = useRef(new Set<string>());
  const focusedKey = useRef("");
  const selectedRef = useRef("");
  const returnFocus = useRef(false);
  const previewRef = useRef(0);
  const roomRef = useRef<SdkRoom | null>(null);
  const room = officeRoom(sdkRoom);
  const darkTheme = themePreference === "system" ? systemDark : themePreference === "dark";
  const mark = darkTheme ? HAPPY_MACHINES_DARK_MARK : HAPPY_MACHINES_MARK;

  useLayoutEffect(() => {
    document.documentElement.dataset.officeTheme = darkTheme ? "dark" : "light";
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!favicon) throw new Error("HappyMachines favicon link is missing.");
    favicon.href = `data:image/svg+xml,${encodeURIComponent(happyMachinesFavicon(darkTheme))}`;
  }, [darkTheme]);
  useEffect(() => {
    const preference = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(preference.matches);
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  const toggleTheme = () => {
    const next = darkTheme ? "light" : "dark";
    try {
      localStorage.setItem(themeKey, next);
      setThemePreference(next);
      setActionError("");
    } catch (error) {
      setActionError(`Theme preference could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const updateRoom = (next: SdkRoom) => {
    if (roomRef.current && next.revision < roomRef.current.revision) return;
    roomRef.current = next;
    const actors = deskActors(next);
    actorsRef.current = actors;
    const scene = sceneRef.current;
    if (scene) {
      worldRef.current?.capturePositions();
      applyRoom(scene, actors, occupiedRef.current);
      nextBreakRef.current = nextDeskBreak(actors.filter((actor): actor is DeskActor => !!actor), Date.now());
      updatePersonas(worldRef.current ?? undefined, next);
      worldRef.current?.setUpgrades((next.progression ?? [])
        .filter(event => event.kind === "purchase").map(event => event.upgradeId));
    }
    setSdkRoom(next);
    setConnection(next.connected ? connectedStatus : next.error || "SDK connection unavailable");
    for (const agent of next.agents) {
      const requestId = agent.review?.id ?? agent.accessRequest?.id;
      if (!agent.archived && requestId && !seenReviews.current.has(requestId)) {
        seenReviews.current.add(requestId);
        selectActor(agent.sessionId);
      }
    }
  };
  const act = async (path: string, body: Record<string, unknown>): Promise<boolean> => {
    try {
      setActionError("");
      updateRoom(await post(path, body));
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  const createAgent = async (deskIndex: number): Promise<boolean> => {
    const previousIds = new Set(roomRef.current?.agents.map(agent => agent.id) ?? []);
    try {
      setActionError("");
      const next = await post("create", { deskIndex });
      updateRoom(next);
      const created = next.agents.find(agent => !previousIds.has(agent.id));
      if (!created) throw new Error("Agent created, but the new agent was not found in the office response.");
      selectActor(created.sessionId);
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  const openDeskChoice = (choice: NonNullable<typeof deskChoice>, trigger: HTMLElement) => {
    deskTriggerRef.current = trigger.closest("[data-agent-menu]")?.querySelector<HTMLElement>(".agent-menu-toggle") ?? trigger;
    setPanelOpen(true);
    setDeskTarget(null);
    setActionError("");
    setMenuAgentId(null);
    setDeskChoice(choice);
  };
  const closeDeskChoice = (restoreFocus = true) => {
    setDeskChoice(null);
    setDeskTarget(null);
    if (restoreFocus) window.setTimeout(() => deskTriggerRef.current?.focus(), 0);
  };
  const chooseDesk = async (index: number, occupantId: string | null) => {
    if (!deskChoice || deskBusy) return;
    const agent = deskChoice.kind === "create" ? undefined :
      roomRef.current?.agents.find(item => item.id === deskChoice.agentId);
    if (deskChoice.kind !== "create" && !agent) {
      setActionError("Agent no longer exists. Reopen the seating plan.");
      return;
    }
    if (deskChoice.kind === "move" && occupantId && (!deskTarget || deskTarget.index !== index)) {
      setDeskTarget({ index, occupantId });
      return;
    }
    setDeskBusy(true);
    try {
      setActionError("");
      if (deskChoice.kind === "create") {
        if (await createAgent(index)) closeDeskChoice(false);
      } else if (deskChoice.kind === "restore") {
        if (await act("restore", { agentId: agent!.id, deskIndex: index })) closeDeskChoice();
      } else if (await act("move-desk", { agentId: agent!.id, deskIndex: index,
        expectedDeskIndex: deskChoice.deskIndex, expectedOccupantId: occupantId })) {
        closeDeskChoice();
      }
    } finally {
      setDeskBusy(false);
    }
  };
  const meetingAction = async (path: string, body: Record<string, unknown>): Promise<SdkRoom | null> => {
    setMeetingBusy(true);
    try {
      setActionError("");
      const next = await post(path, body);
      updateRoom(next);
      return next;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setMeetingBusy(false);
    }
  };
  const lookupProject = async () => {
    setProjectLookingUp(true);
    setProjectCandidates([]);
    setProjectCandidate("");
    setActionError("");
    try {
      const response = await fetch("/api/project-lookup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hint: projectHint.trim() }),
      });
      const result: RemoteRepository[] | { error?: string } = await response.json();
      if (!response.ok) throw new Error(!Array.isArray(result) && result.error || `Lookup failed (${response.status})`);
      if (!Array.isArray(result)) throw new Error("Invalid GitHub repository lookup response.");
      setProjectCandidates(result);
      setProjectCandidate(result.length === 1 ? result[0].fullName : "");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectLookingUp(false);
    }
  };

  const clearSelection = () => {
    selectedRef.current = "";
    focusedKey.current = ":-1";
    setSelected("");
    setSettingsOpen(false);
    setProfileEditingId(null);
    restoreChatScroll.current = null;
    returnAgentFocus.current = null;
    setChatOptionsOpen(false);
    setHover(null);
    hoverDeskRef.current = null;
  };
  const unfocusActor = () => {
    worldRef.current?.focusAgent(null);
    clearSelection();
  };
  const backToActivity = () => {
    unfocusActor();
    setTab("agents");
  };
  const backToConversation = () => {
    returnAgentFocus.current = settingsOpen ? "settings" : "edit";
    setSettingsOpen(false);
    setProfileEditingId(null);
    setChatOptionsOpen(false);
  };
  const openSettings = () => {
    restoreChatScroll.current = chatScroll.current?.scrollTop ?? 0;
    followTail.current = false;
    setChatOptionsOpen(false);
    setSettingsOpen(true);
  };
  useLayoutEffect(() => {
    if (!panelOpen || !selected) return;
    if (settingsOpen || profileEditingId) agentDetailBack.current?.focus();
    else if (returnAgentFocus.current) {
      (returnAgentFocus.current === "edit" ? editAgentButton : chatOptionsButton).current?.focus();
      returnAgentFocus.current = null;
    }
  }, [panelOpen, selected, settingsOpen, profileEditingId]);
  const backToOverview = () => {
    returnStoreFocus.current = true;
    setTab("office");
  };
  const closeActivity = () => {
    unfocusActor();
    if (tab === "store") setTab("office");
    returnFocus.current = true;
    setPanelOpen(false);
    setMenuAgentId(null);
    setChatOptionsOpen(false);
  };
  const closeConfirmation = () => {
    setConfirmAgentId(null);
    setConfirmIdentity("");
    setRetention("keep");
    setConfirmError("");
    window.setTimeout(() => confirmTriggerRef.current?.focus(), 0);
  };

  const selectActor = (key: string) => {
    const index = actorsRef.current.findIndex((actor) => actor?.key === key);
    const agent = roomRef.current?.agents.find(item => item.sessionId === key);
    if (!agent || (!agent.archived && (index < 0 || index >= MAX_LIVE_DESKS))) {
      throw new Error(`Worker has no desk: ${key}`);
    }
    selectedRef.current = key;
    worldRef.current?.focusAgent(agent.archived ? null : index);
    if (!agent.archived && index >= 0) {
      const point = worldRef.current?.projectAgent(index);
      const actor = actorsRef.current[index];
      if (point && actor) setHover({ name: actor.name, ...point });
      hoverDeskRef.current = index;
    } else {
      setHover(null);
      hoverDeskRef.current = null;
    }
    focusedKey.current = `${key}:${agent.archived ? "archived" : index}`;
    setSelected(key);
    setSettingsOpen(false);
    setPanelOpen(true);
    setTab("agents");
    setMenuAgentId(null);
    setChatOptionsOpen(false);
  };

  useEffect(() => {
    if (deskChoice) return;
    const focusTimer = window.setTimeout(() => {
      if (panelOpen) {
        if (selected || !document.activeElement?.closest("#system-panel")) activityClose.current?.focus();
      } else if (returnFocus.current) {
        returnFocus.current = false;
        activityToggle.current?.focus();
      }
    }, 50);
    return () => window.clearTimeout(focusTimer);
  }, [panelOpen, selected, deskChoice]);

  useEffect(() => {
    if (!panelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (deskChoice) {
          if (!deskBusy) closeDeskChoice();
        } else if (confirmAgentId) {
          if (!confirmSubmitting) closeConfirmation();
        } else if (assignmentAgentId && !assignmentSubmitting) {
          setAssignmentAgentId(null);
        } else if (chatOptionsOpen) {
          setChatOptionsOpen(false);
          chatOptionsButton.current?.focus();
        }
        else if (menuAgentId) setMenuAgentId(null);
        else if (selectedRef.current && (settingsOpen || profileEditingId)) backToConversation();
        else if (selectedRef.current) backToActivity();
        else if (tab === "store") backToOverview();
        else closeActivity();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panelOpen, tab, selected, settingsOpen, profileEditingId, menuAgentId, chatOptionsOpen, confirmAgentId, confirmSubmitting, assignmentAgentId, assignmentSubmitting, deskChoice, deskBusy]);

  useEffect(() => {
    if (deskChoice) deskDialogRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [deskChoice]);

  useLayoutEffect(() => {
    if (!panelOpen || selected) return;
    if (tab === "store") storeBack.current?.focus();
    else if (tab === "office" && returnStoreFocus.current) {
      returnStoreFocus.current = false;
      storeEntry.current?.focus();
    }
  }, [panelOpen, selected, tab]);

  useEffect(() => {
    if (confirmAgentId) confirmCheckboxRef.current?.focus();
  }, [confirmAgentId]);

  useEffect(() => {
    if (!menuAgentId) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest("[data-agent-menu]"))) setMenuAgentId(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menuAgentId]);

  useEffect(() => {
    if (!chatOptionsOpen) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest("[data-chat-options]"))) setChatOptionsOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [chatOptionsOpen]);

  useLayoutEffect(() => {
    if (!panelOpen || !selected || settingsOpen || setupOpen || !chatScroll.current?.querySelector(".conversation-view")) return;
    followTail.current = true;
    const scroll = chatScroll.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [selected, panelOpen]);

  useLayoutEffect(() => {
    const scroll = chatScroll.current;
    if (scroll?.querySelector(".conversation-view") && selected && followTail.current) scroll.scrollTop = scroll.scrollHeight;
  }, [sdkRoom?.revision, selected]);

  useEffect(() => {
    if (!host.current) return;
    const scene = makeScene();
    sceneRef.current = scene;
    occupiedRef.current = Array(MIN_LIVE_DESKS).fill(false);
    let world: ReturnType<typeof createWorld> | undefined;
    try {
      world = createWorld(host.current, scene, "live", {
        onAgentHover(index) {
          if (selectedRef.current) {
            const focusedIndex = actorsRef.current.findIndex(actor => actor?.key === selectedRef.current);
            index = focusedIndex < 0 ? null : focusedIndex;
          }
          const actor = index === null ? undefined : actorsRef.current[index];
          if (hoverDeskRef.current === index) return;
          hoverDeskRef.current = index;
          const position = index === null ? null : world?.projectAgent(index);
          setHover(actor && position ? { name: actor.name, ...position } : null);
        },
        onAgentSelect(index) {
          const actor = actorsRef.current[index];
          if (actor) selectActor(actor.key);
        },
        onFocusCleared() {
          clearSelection();
        },
        noticeActivityForStation(index) {
          const actor = actorsRef.current[index];
          return actor ? noticeActivityForActor(actor) : null;
        },
      });
      worldRef.current = world;
    } catch (error) {
      host.current.classList.add("static-fallback");
      setConnection(`3D office unavailable; live status remains visible. ${error instanceof Error ? error.message : String(error)}`);
    }
    const feed = new EventSource("/api/events");
    feed.onmessage = (event) => {
      try {
        const update = JSON.parse(event.data) as SdkRoom;
        if (typeof update.revision !== "number" || typeof update.workspace !== "string") {
          throw new Error("Invalid SDK office status");
        }
        updateRoom(update);
      } catch (error) {
        setConnection(`Office update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    feed.addEventListener("error", () => {
      setConnection("Connection interrupted; reconnecting to the local SDK office…");
    });
    void fetch("/api/state").then(async response => {
      if (!response.ok) throw new Error(`Local server returned ${response.status}`);
      const initial = await response.json() as SdkRoom;
      if (!roomRef.current || initial.revision >= roomRef.current.revision) {
        updateRoom(initial);
      }
    }).catch(error => setConnection(`Cannot reach local SDK office: ${error instanceof Error ? error.message : String(error)}`));
    void fetch("/api/search-capability").then(async response => {
      if (!response.ok) throw new Error(`Local server returned ${response.status}`);
      const capability: unknown = await response.json();
      if (!capability || typeof capability !== "object" || !("reason" in capability) ||
        typeof capability.reason !== "string" || !("available" in capability) ||
        typeof capability.available !== "boolean") throw new Error("Invalid search capability");
      setSearchCapability(capability.reason);
    }).catch(error => setSearchCapability(`Web search status unavailable: ${error instanceof Error ? error.message : String(error)}`));
    let raf = 0;
    let last = performance.now();
    let accumulator = 0;
    let animationTime = last / 1000;
    const onVisibility = () => {
      last = performance.now();
      accumulator = 0;
      world?.capturePositions();
    };
    const frame = (now: number) => {
      if (Date.now() >= nextBreakRef.current && roomRef.current) {
        const actors = deskActors(roomRef.current);
        world?.capturePositions();
        applyRoom(scene, actors, occupiedRef.current);
        nextBreakRef.current = nextDeskBreak(actors.filter((actor): actor is DeskActor => !!actor), Date.now());
      }
      const elapsed = Math.min((now - last) / 1000, 0.2);
      last = now;
      if (!document.hidden) {
        accumulator += elapsed;
        let advanced = false;
        while (accumulator >= STEP) {
          world?.capturePositions();
          moveAgents(scene, STEP);
          scene.time += STEP;
          accumulator -= STEP;
          advanced = true;
        }
        animationTime += elapsed;
        world?.render(animationTime, previewRef.current, accumulator / STEP, advanced);
        if (world && host.current) {
          if (hoverDeskRef.current !== null && hoverLabelRef.current) {
            const position = world.projectAgent(hoverDeskRef.current);
            hoverLabelRef.current.hidden = !position;
            if (position) {
              hoverLabelRef.current.style.left = `${position.x}px`;
              hoverLabelRef.current.style.top = `${position.y}px`;
            }
          }
          host.current.querySelectorAll<HTMLButtonElement>("[data-desk-index]").forEach(button => {
            const position = world.projectDesk(Number(button.dataset.deskIndex));
            button.hidden = !position;
            if (position) {
              button.style.left = `${position.x}px`;
              button.style.top = `${position.y}px`;
            }
          });
          host.current.querySelectorAll<HTMLButtonElement>("[data-agent-desk]").forEach(button => {
            const position = world.projectAgent(Number(button.dataset.agentDesk));
            button.hidden = !position;
            if (position) {
              button.style.left = `${position.x}px`;
              button.style.top = `${position.y}px`;
            }
          });
        }
      }
      raf = requestAnimationFrame(frame);
    };
    document.addEventListener("visibilitychange", onVisibility);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      feed.close();
      world?.dispose();
      worldRef.current = null;
      sceneRef.current = null;
    };
  }, []);

  const names = new Map(sdkRoom?.agents.map(agent => [agent.sessionId, agentName(sdkRoom, agent)]) ?? []);
  const actors = roomActors(room).map(actor => ({ ...actor, name: names.get(actor.key) ?? actor.name }));
  const activeAgents = sdkRoom?.agents.filter(isActive) ?? [];
  const formerPersonas = (sdkRoom?.personas ?? []).filter(persona =>
    !sdkRoom?.agents.some(agent => agent.personaId === persona.id));
  const career = progression(sdkRoom?.progression ?? [], (sdkRoom?.personas ?? []).map(item => item.id),
    sdkRoom?.assignments ?? [], sdkRoom?.meetings ?? []);
  const rewardEvents = (sdkRoom?.progression ?? []).filter((event): event is Extract<ProgressEvent, { kind: "reward" }> =>
    event.kind === "reward");
  const deskCount = MAX_LIVE_DESKS;
  const firstEmptyDesk = Array.from({ length: MAX_AGENTS }, (_, index) => index)
    .find(index => !activeAgents.some(agent => agent.deskIndex === index));
  const officeFull = activeAgents.length >= MAX_AGENTS;
  const working = actors.filter((actor) => actor.status === "thinking" || actor.status === "tool").length;
  const idle = actors.filter((actor) => actor.status === "idle").length;
  const blocked = actors.filter((actor) => actor.status === "blocked").length;
  const unavailable = activeAgents.length - working - idle - blocked;
  const connected = sdkRoom?.connected === true && connection === connectedStatus;
  const signKind = connected ? "online" : sdkRoom?.error ? "error" :
    connection.startsWith("Connecting") ? "connecting" : "offline";
  const signLabel = connected ? "SDK online" : sdkRoom?.error ? "SDK needs attention" :
    signKind === "connecting" ? "Connecting…" : "SDK offline";
  const compactStatus = connected ? "Online" : sdkRoom?.error ? "Error" :
    signKind === "connecting" ? "Connecting" : "Offline";
  const selectedAgent = sdkRoom?.agents.find(agent => agent.sessionId === selected);
  const selectedPersona = personaFor(sdkRoom, selectedAgent);
  useEffect(() => {
    if (selectedAgent?.accessRequest || selectedAgent?.review) {
      setSettingsOpen(false);
      if (selectedPersona?.setupCompleted !== false) setProfileEditingId(null);
    }
  }, [selectedAgent?.accessRequest?.id, selectedAgent?.review?.id]);
  const setupOpen = !!selectedPersona && (selectedPersona.setupCompleted === false ||
    profileEditingId === selectedPersona.id);
  useLayoutEffect(() => {
    if (!selected || setupOpen || settingsOpen) chatScroll.current?.scrollTo(0, 0);
    else if (restoreChatScroll.current !== null && chatScroll.current) {
      chatScroll.current.scrollTop = restoreChatScroll.current;
      restoreChatScroll.current = null;
    }
  }, [selected, setupOpen, settingsOpen, tab]);
  const previousAssignments = (sdkRoom?.assignments ?? [])
    .filter(assignment => assignment.personaId === selectedPersona?.id && assignment.id !== selectedAgent?.assignmentId)
    .sort((a, b) => b.startedAt - a.startedAt);
  const currentAssignment = sdkRoom?.assignments?.find(assignment => assignment.id === selectedAgent?.assignmentId);
  const displayedMessages = selectedAgent?.messages.length ? selectedAgent.messages :
    selectedAgent && !selectedAgent.archived ?
      [{ id: `greeting-${selectedAgent.id}`, role: "assistant" as const,
        content: greetingForPersona(agentArt(sdkRoom, selectedAgent)) }] : [];
  useEffect(() => {
    setProfileEditingId(null);
    if (selectedPersona) setProfileDraft({
      name: selectedPersona.name, artId: selectedPersona.artId,
      workingStyle: selectedPersona.profile.workingStyle,
      instructions: selectedPersona.profile.instructions ?? "",
      specialties: selectedPersona.profile.specialties.join(", "),
      title: selectedPersona.profile.title,
    });
    setGuidancePreview(null);
  }, [selectedPersona?.id, selected]);
  useEffect(() => {
    setGuidancePreview(null);
  }, [selectedPersona?.updatedAt, selectedAgent?.assignmentId]);
  useLayoutEffect(() => {
    const bubbles = Array.from(chatScroll.current?.querySelectorAll<HTMLElement>(
      ".conversation-message:not(.access-message) .message-bubble") ?? []);
    const measure = () => {
      for (const bubble of bubbles) {
        const markdown = bubble.querySelector(".message-markdown");
        const paragraph = markdown?.children.length === 1 ? markdown.firstElementChild : null;
        const lineHeight = paragraph ? Number.parseFloat(getComputedStyle(paragraph).lineHeight) : 0;
        bubble.classList.toggle("single-line", paragraph?.tagName === "P" &&
          lineHeight > 0 && paragraph.getBoundingClientRect().height <= lineHeight + 1);
      }
    };
    const observer = new ResizeObserver(measure);
    for (const bubble of bubbles) {
      const markdown = bubble.querySelector(".message-markdown");
      if (markdown) observer.observe(markdown);
    }
    measure();
    return () => observer.disconnect();
  }, [selected, displayedMessages]);
  useEffect(() => {
    setCopiedId("");
  }, [selected]);
  useEffect(() => {
    setRepoHint(selectedAgent?.accessRequest?.repoHint ?? "");
    setSelectedRepository("");
    setFreshSnapshot(false);
    setEditingRepoHint(!selectedAgent?.accessRequest?.repoHint);
  }, [selectedAgent?.accessRequest?.id]);
  const candidates = selectedAgent?.accessRequest?.candidates ?? [];
  const chosenRepository = candidates.find(item => item.fullName === selectedRepository) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  const cachedSnapshot = sdkRoom?.snapshots?.find(item => item.fullName === chosenRepository?.fullName &&
    item.ref === chosenRepository.defaultBranch);
  const selectedActor = actors.find(actor => actor.key === selected);
  const confirmAgent = sdkRoom?.agents.find(agent => agent.id === confirmAgentId);
  const confirmName = agentName(sdkRoom, confirmAgent);
  const assignmentAgent = sdkRoom?.agents.find(agent => agent.id === assignmentAgentId);
  const lifecycleBusy = (agent: SdkAgent) =>
    !!agent.review || !!agent.accessRequest || ["thinking", "working", "permission"].includes(agent.phase);
  const canStartAssignment = (agent: SdkAgent) => !agent.archived && agent.phase === "idle" && !lifecycleBusy(agent);
  const meetings = [...(sdkRoom?.meetings ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const currentMeeting = meetings.find(item => item.id === meetingId) ?? meetings[0];
  const meetingName = (id: string) => sdkRoom?.personas?.find(persona => persona.id === id)?.name ??
    agentName(sdkRoom, sdkRoom?.agents.find(agent => agent.id === id));
  const meetingReady = (agent: SdkAgent) => isActive(agent) && canStartAssignment(agent);
  const selectedMeetingAgents = meetingParticipants.map(id => sdkRoom?.agents.find(agent => agent.id === id));
  const canCreateMeeting = connected && !meetingBusy &&
    !meetings.some(meeting => meeting.status === "open" || meeting.status === "running") &&
    (meetingKind !== "review" || !!meetingSharedText.trim()) &&
    meetingAgenda.trim().length <= 1000 && meetingSharedText.length <= 6000 &&
    meetingParticipants.length >= 2 &&
    meetingParticipants.length <= 4 && selectedMeetingAgents.every(agent => agent && meetingReady(agent)) &&
    !!meetingAgenda.trim() && Number.isInteger(meetingMaxTurns) && meetingMaxTurns >= 1 && meetingMaxTurns <= 8;
  const meetingTurnPending = currentMeeting?.status === "running";
  const handoffKey = currentMeeting ? `${currentMeeting.id}:${currentMeeting.nextIndex}` : "";
  const handoffText = meetingHandoffs[handoffKey]?.trim() ?? "";
  const nextMeetingAgent = currentMeeting?.participantIds[currentMeeting.nextIndex % currentMeeting.participantIds.length];
  const nextMeetingParticipant = sdkRoom?.agents.find(agent => agent.id === nextMeetingAgent);
  const canAdvanceMeeting = connected && !meetingBusy && currentMeeting?.status === "open" &&
    currentMeeting.nextIndex < currentMeeting.maxTurns &&
    (currentMeeting.turns.length === 0 || !!handoffText) &&
    !!nextMeetingParticipant && meetingReady(nextMeetingParticipant);
  const sceneMeeting = meetings.find(item => item.status === "open" || item.status === "running");
  const createMeeting = async () => {
    if (!canCreateMeeting) return;
    const existing = new Set((sdkRoom?.meetings ?? []).map(item => item.id));
    const next = await meetingAction("meeting-create", {
      kind: meetingKind, participantIds: meetingParticipants, agenda: meetingAgenda.trim(),
      sharedText: meetingSharedText.trim(), ...(meetingRepository.trim() ? { repository: meetingRepository.trim() } : {}),
      maxTurns: meetingMaxTurns,
    });
    if (next) {
      const created = next.meetings?.find(item => !existing.has(item.id));
      if (created) setMeetingId(created.id);
      setMeetingParticipants([]);
      setMeetingAgenda("");
      setMeetingSharedText("");
      setMeetingRepository("");
      setMeetingSummary("");
      setMeetingOwners({});
    }
  };
  const selectMeeting = (meeting: Meeting) => {
    setMeetingId(meeting.id);
    setMeetingSummary(meeting.summary);
    setMeetingOwners(Object.fromEntries(meeting.owners.map(owner => [owner.agentId, owner.task])));
  };
  const finishMeeting = async () => {
    if (!currentMeeting || !meetingSummary.trim()) return;
    await meetingAction("meeting-finish", {
      meetingId: currentMeeting.id, summary: meetingSummary.trim(),
      owners: currentMeeting.participantIds.flatMap(agentId => {
        const task = meetingOwners[agentId]?.trim();
        return task ? [{ agentId, task }] : [];
      }),
    });
  };
  const advanceMeeting = async () => {
    if (!currentMeeting || !canAdvanceMeeting) return;
    const id = currentMeeting.id;
    const key = handoffKey;
    const next = await meetingAction("meeting-advance", {
      meetingId: id, ...(handoffText ? { handoffText } : {}),
    });
    if (next) setMeetingHandoffs(handoffs => ({ ...handoffs, [key]: "" }));
  };
  const startProfileEdit = (persona: AgentPersona) => {
    if (selectedAgent?.personaId === persona.id && !settingsOpen) {
      restoreChatScroll.current = chatScroll.current?.scrollTop ?? 0;
      followTail.current = false;
    }
    setProfileDraft({
      name: persona.name, artId: persona.artId, workingStyle: persona.profile.workingStyle,
      instructions: persona.profile.instructions ?? "",
      specialties: persona.profile.specialties.join(", "), title: persona.profile.title,
    });
    setProfileEditingId(persona.id);
  };
  const saveProfile = async (persona: AgentPersona): Promise<boolean> => {
    followTail.current = false;
    setProfileBusy(true);
    try {
      const saved = await act("persona-profile", {
        personaId: persona.id, name: profileDraft.name.trim(), artId: Number(profileDraft.artId),
        workingStyle: profileDraft.workingStyle.trim(), specialties: profileDraft.specialties
          .split(/[,\n]/).map(item => item.trim()).filter(Boolean),
        instructions: profileDraft.instructions.trim(), title: profileDraft.title.trim(), rank: persona.profile.rank,
      });
      if (saved) {
        if (selectedAgent?.personaId === persona.id && persona.setupCompleted !== false) returnAgentFocus.current = "edit";
        setProfileEditingId(null);
      }
      return saved;
    } finally {
      setProfileBusy(false);
    }
  };
  const finishSetup = async (persona: AgentPersona) => {
    if (!profileDraft.workingStyle.trim() && !profileDraft.instructions.trim()) return;
    if (await saveProfile(persona)) await act("persona-setup-complete", { personaId: persona.id });
  };
  const loadGuidance = async (persona: AgentPersona) => {
    setGuidanceLoading(true);
    setGuidancePreview(null);
    try {
      const response = await fetch(`/api/persona-guidance?personaId=${encodeURIComponent(persona.id)}`);
      const result: { next?: string; current?: string | null; error?: string } = await response.json();
      if (!response.ok) throw new Error(result.error || `Guidance preview failed (${response.status})`);
      if (typeof result.next !== "string") throw new Error("Invalid guidance preview response.");
      setGuidancePreview({ next: result.next, current: result.current ?? null });
    } catch (error) {
      setActionError(`Guidance preview unavailable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setGuidanceLoading(false);
    }
  };
  const profileEditor = (persona: AgentPersona) => <form className="persona-form" onSubmit={event => {
    event.preventDefault();
    void saveProfile(persona);
  }}>
    <label>Name <input required maxLength={80} value={profileDraft.name}
      onChange={event => setProfileDraft({ ...profileDraft, name: event.target.value })} /></label>
    <label>Working style <textarea rows={3} value={profileDraft.workingStyle}
      onChange={event => setProfileDraft({ ...profileDraft, workingStyle: event.target.value })} /></label>
    <label>Instructions for future assignments <textarea rows={3} maxLength={600} value={profileDraft.instructions}
      placeholder="How should this agent approach work?"
      onChange={event => setProfileDraft({ ...profileDraft, instructions: event.target.value })} /></label>
    <Disclosure.Root className="profile-extras">
      <Disclosure.Trigger className="overview-disclosure">More profile details</Disclosure.Trigger>
      <Disclosure.Panel className="ui-disclosure-panel profile-extras-panel">
        <label>Portrait number <input required type="number" min="0" max={MAX_AGENTS - 1} step="1" value={profileDraft.artId}
          onChange={event => setProfileDraft({ ...profileDraft, artId: Number(event.target.value) })} /></label>
        <label>Title <input maxLength={1000} value={profileDraft.title}
          onChange={event => setProfileDraft({ ...profileDraft, title: event.target.value })} /></label>
        <label>Specialties (comma-separated) <input value={profileDraft.specialties}
          onChange={event => setProfileDraft({ ...profileDraft, specialties: event.target.value })} /></label>
      </Disclosure.Panel>
    </Disclosure.Root>
    <div className="persona-actions">
      <button type="button" disabled={profileBusy} onClick={() => {
        if (persona.setupCompleted === false) backToActivity();
        else setProfileEditingId(null);
      }}>{persona.setupCompleted === false ? "Set up later" : "Cancel"}</button>
      <button type="submit" disabled={profileBusy || !profileDraft.name.trim()}>Save profile</button>
      {persona.setupCompleted === false && <Button type="button" className="setup-finish"
        disabled={profileBusy || selectedAgent?.archived || !profileDraft.name.trim() ||
          (!profileDraft.workingStyle.trim() && !profileDraft.instructions.trim())}
        onClick={() => void finishSetup(persona)}>Save & start chat</Button>}
    </div>
  </form>;
  const addNote = async (persona: AgentPersona) => {
    const note = noteDrafts[persona.id];
    if (!note?.text.trim() || !note.provenance.trim()) return;
    followTail.current = false;
    setProfileBusy(true);
    try {
      if (await act("persona-memory", {
        personaId: persona.id, text: note.text.trim(), provenance: note.provenance.trim(),
      })) setNoteDrafts(drafts => {
        const next = { ...drafts };
        delete next[persona.id];
        return next;
      });
    } finally {
      setProfileBusy(false);
    }
  };
  const personaNotes = (persona: AgentPersona) => {
    const note = noteDrafts[persona.id] ?? { text: "", provenance: "" };
    return <div className="persona-notes panel-section">
    <h4>Curated notes</h4>
    {!persona.memories.length && <p>No approved notes yet.</p>}
    <ul>{persona.memories.map(memory => <li key={memory.id}>
      <span>{memory.text}</span>
      <small>Source: {memory.provenance} · {new Date(memory.approvedAt).toLocaleDateString()}</small>
      <button type="button" disabled={profileBusy} aria-label={`Remove note: ${memory.text}`}
        onClick={() => {
          if (window.confirm("Remove this curated note?")) {
            followTail.current = false;
            setProfileBusy(true);
            void act("persona-memory-remove", { personaId: persona.id, memoryId: memory.id })
              .finally(() => setProfileBusy(false));
          }
        }}>Remove note</button>
    </li>)}</ul>
    <form className="persona-form" onSubmit={event => {
      event.preventDefault();
      void addNote(persona);
    }}>
      <label>New curated note <textarea required rows={2} maxLength={500} value={note.text}
        onChange={event => setNoteDrafts(drafts => ({
          ...drafts, [persona.id]: { ...note, text: event.target.value },
        }))} /></label>
      <label>Provenance (where this came from) <input required maxLength={160} value={note.provenance}
        onChange={event => setNoteDrafts(drafts => ({
          ...drafts, [persona.id]: { ...note, provenance: event.target.value },
        }))} /></label>
      <button type="submit" disabled={profileBusy || !note.text.trim() || !note.provenance.trim()}>Add note</button>
    </form>
  </div>;
  };
  const personaCareer = (persona: AgentPersona) => {
    const earned = career.xp.get(persona.id) ?? 0;
    const level = career.ranks.get(persona.id) ?? 0;
    const candidates = [
      ...(sdkRoom?.assignments ?? []).filter(item => item.personaId === persona.id && assignmentEvidence(item))
        .map(item => ({ source: "assignment" as const, sourceId: item.id, label: item.outcome || "Completed assignment" })),
      ...(sdkRoom?.meetings ?? []).filter(item => reviewEvidence(item, persona.id))
        .map(item => ({ source: "review" as const, sourceId: item.id, label: `Review: ${item.agenda}` })),
    ].filter(item => !career.rewards.has(`${item.source}:${item.sourceId}:${item.source === "review" ? persona.id : ""}`) &&
      (item.source !== "assignment" || !career.rewards.has(`pr-assignment:${item.sourceId}`)));
    const prAssignments = (sdkRoom?.assignments ?? []).filter(item =>
      item.personaId === persona.id && !!item.repository?.remote &&
      !career.rewards.has(`assignment:${item.id}:`) && !career.rewards.has(`pr-assignment:${item.id}`));
    const evidence = rewardEvents.filter(event => event.personaId === persona.id);
    return <section className="career-panel panel-section" aria-label={`${persona.name} career`}>
      <h4>Career · {RANKS[level].name}</h4>
      <p>{earned} XP · {level + 1 < RANKS.length ?
        `${RANKS[level + 1].xp - earned} XP to ${RANKS[level + 1].name}` : "Highest level eligible"}</p>
      <div className="career-meter" role="progressbar" aria-label="Career XP" aria-valuenow={earned}
        aria-valuemin={0} aria-valuemax={RANKS.at(-1)!.xp}><span style={{ width: `${Math.min(100, earned / RANKS.at(-1)!.xp * 100)}%` }} /></div>
      <p>Earned specialties: {[...career.specialties.get(persona.id) ?? []]
        .map(([name, points]) => `${name} ${points} XP`).join(" · ") || "None yet"}</p>
      {level + 1 < RANKS.length && earned >= RANKS[level + 1].xp &&
        <button type="button" onClick={() => {
          if (window.confirm(`Promote ${persona.name} to ${RANKS[level + 1].name}? Cosmetic title only; no permissions change.`)) {
            void act("promotion", { personaId: persona.id, rank: level + 1, confirmed: true });
          }
        }}>Confirm promotion to {RANKS[level + 1].name}</button>}
      <h4>Outcome evidence</h4>
      {!evidence.length && <p>No confirmed outcomes yet. Existing completion labels do not award XP.</p>}
      <ul>{evidence.map(event => <li key={event.id}>
        <strong>{event.source === "review" ? "Review" : event.source === "merged-pr" ? "GitHub-verified merged PR" :
          "Assignment"} · {event.specialty} · +{event.xp} XP</strong>
        <span>{event.evidence} · {new Date(event.at).toLocaleString()}</span>
        <small>Source ID: {event.sourceId}{event.verifiedPr && ` · merge ${event.verifiedPr.mergeSha.slice(0, 12)}`}</small>
      </li>)}</ul>
      {candidates.length > 0 && <div className="career-candidates">
        <h4>Confirm completed work</h4>
        <p>Only you can confirm an outcome. A prompt/response or completed review is required;
          a completion label alone is not evidence. Maximum three rewards per persona per UTC day.</p>
        {candidates.map(item => <button type="button" key={`${item.source}:${item.sourceId}`}
          onClick={() => {
            setOutcomeTarget({ source: item.source, sourceId: item.sourceId, personaId: persona.id });
            setOutcomeEvidence(""); setOutcomeConfirmed(false);
            setOutcomeSpecialty(item.source === "review" ? "Review" : "Engineering");
          }}>Review {item.label}…</button>)}
      </div>}
      {prAssignments.length > 0 && <div className="career-candidates">
        <h4>Verify merged pull request</h4>
        <p>Requires a recorded assignment repository, your explicit attribution and a live GitHub API check.
          One PR award per assignment; an assignment outcome cannot also earn a separate award.</p>
        {prAssignments.map(item => <button type="button" key={item.id} onClick={() => {
          setOutcomeTarget({ source: "merged-pr", sourceId: item.id, personaId: persona.id });
          setOutcomeEvidence(""); setOutcomeConfirmed(false); setPrNumber(""); setOutcomeSpecialty("Engineering");
        }}>Verify PR for {item.repository?.remote?.fullName} · {item.outcome || "assignment"}…</button>)}
      </div>}
    </section>;
  };
  const projectChooser = (persona?: AgentPersona) => <div className="project-chooser">
    <button type="button" className="project-chooser-toggle" aria-expanded={projectChooserOpen}
      onClick={() => setProjectChooserOpen(open => !open)}>
      {persona ? "Select GitHub Repos" : "Assign projects globally"}</button>
    {projectChooserOpen && <div className="project-chooser-content">
      <p>Find a repository on GitHub, then select its verified identity. Paths and unverified names cannot grant access.</p>
      <form className="project-lookup" onSubmit={event => { event.preventDefault(); void lookupProject(); }}>
        <label>Repository name or owner/repo <input value={projectHint} placeholder="owner/repo"
          maxLength={150} onChange={event => {
            setProjectHint(event.target.value); setProjectCandidates([]); setProjectCandidate("");
          }} /></label>
        <button type="submit" disabled={!connected || !projectHint.trim() || projectLookingUp}>
          {projectLookingUp ? "Looking up…" : "Find on GitHub"}</button>
      </form>
      {projectCandidates.length > 0 && <div className="project-confirm">
        <SelectField label="Verified repository" value={projectCandidate} onValueChange={setProjectCandidate}
          options={[
            ...(projectCandidates.length > 1 ? [{ value: "", label: "Select owner/repo…" }] : []),
            ...projectCandidates.map(candidate => ({
              value: candidate.fullName,
              label: `${candidate.fullName} · ${candidate.privacy} · ${candidate.defaultBranch}`,
            })),
          ]} />
        {persona && <SelectField label="Agent access" value={projectAccessChoice}
          onValueChange={setProjectAccessChoice} options={[
            { value: "read", label: "Read for this agent" },
            { value: "write", label: "Eligible for task worktree (manual tools prompt by default)" },
          ]} />}
        <button type="button" disabled={!connected || !projectCandidate || projectSaving}
          onClick={() => void (async () => {
            const repository = projectCandidates.find(item => item.fullName === projectCandidate);
            if (!repository) { setActionError("Select a verified repository."); return; }
            setProjectSaving(true);
            try {
              const exists = sdkRoom?.projects?.find(item =>
                item.repository.fullName.toLowerCase() === repository.fullName.toLowerCase());
              if (!exists && !await act("project-policy", { repository, sharedRead: !persona })) return;
              if (exists && !persona && !exists.sharedRead &&
                !await act("project-share", { fullName: repository.fullName, sharedRead: true })) return;
              if (persona && !await act("persona-project", {
                personaId: persona.id, fullName: repository.fullName, choice: projectAccessChoice,
              })) return;
              setProjectCandidates([]); setProjectCandidate(""); setProjectHint(""); setProjectChooserOpen(false);
            } finally { setProjectSaving(false); }
          })()}>{projectSaving ? "Saving…" : persona ? "Assign to agent" : "Share read with all agents"}</button>
      </div>}
      <p className="project-edit-notice">Edit via task worktree; manual tools prompt by default. A worktree is not an OS sandbox.</p>
    </div>}
  </div>;
  const personaProjects = (persona: AgentPersona) => <div className="persona-projects panel-section">
    <h4>Assign projects</h4>
    <p>Choose verified repositories for this agent. Office access applies unless excluded.</p>
    {projectChooser(persona)}
    {!sdkRoom?.projects?.length && <p>No verified repositories yet.</p>}
    {(["agent", "global"] as const).map(group => {
      const items = groupedProjectAccess(effectiveProjectAccess(sdkRoom?.projects ?? [], persona.repositoryPolicies,
        sdkRoom?.agents.find(agent => agent.personaId === persona.id)?.repository))[group];
      if (!items.length) return null;
      return <section className="project-group" key={group}>
        {group === "agent" && <h5>Agent</h5>}
        <ul>{items.map(({ project, read, write, source }) => {
      const fullName = project.repository.fullName;
      const policy = persona.repositoryPolicies?.find(item => item.fullName.toLowerCase() === fullName.toLowerCase());
      const change = (choice: "read" | "write" | "remove" | "exclude" | "inherit") =>
        void act("persona-project", { personaId: persona.id, fullName, choice });
      return <li key={fullName}>
        <div><strong>{fullName}</strong><span>{write ? "Eligible for task worktree · manual by default" : read ?
          source === "persona" ? "Read · agent" : source === "assignment" ? "Read · current task" : "Read" :
          source === "excluded" ? "Not readable · excluded" : "Not readable"}</span></div>
        <div className="project-actions">
          {!policy?.read ? <button type="button" disabled={!connected}
            onClick={() => change("read")}>Give read</button> :
            <button type="button" disabled={!connected}
              onClick={() => change("remove")}>Remove agent access</button>}
          {(!write || policy?.write) && <button type="button" disabled={!connected}
            onClick={() => change(policy?.write ? "read" : "write")}>
            {policy?.write ? project.sharedWrite ? "Remove direct write (global remains)" : "Keep read only" :
              "Allow task worktrees"}</button>}
          {write && selectedAgent?.personaId === persona.id && <button type="button"
            disabled={!connected || selectedAgent.archived || selectedAgent.phase !== "idle" ||
              !!selectedAgent.accessRequest || !!selectedAgent.review}
            onClick={() => void act("project-worktree", { agentId: selectedAgent.id, fullName })}>
            Review Edit worktree for this task</button>}
          {!policy?.excluded && project.sharedRead ? <button type="button" disabled={!connected}
            onClick={() => change("exclude")}>Exclude agent</button> : policy?.excluded ?
            <button type="button" disabled={!connected}
              onClick={() => change("inherit")}>Restore global read</button> : null}
        </div>
      </li>;
        })}</ul>
      </section>;
    })}
  </div>;
  const newAssignment = async () => {
    if (!assignmentAgent || !canStartAssignment(assignmentAgent) || assignmentSubmitting) return;
    setAssignmentSubmitting(true);
    try {
      if (await act("new-assignment", { agentId: assignmentAgent.id, modelProfileId: assignmentModelProfileId ||
        sdkRoom?.assignments?.find(item => item.id === assignmentAgent.assignmentId)?.modelProfileId || "copilot",
        ...(assignmentOutcome.trim() ? { outcome: assignmentOutcome.trim() } : {}) })) {
        setAssignmentAgentId(null);
        setAssignmentOutcome("");
        setAssignmentModelProfileId("");
        backToActivity();
      }
    } finally {
      setAssignmentSubmitting(false);
    }
  };
  const archiveAgent = async (agent: SdkAgent) => {
    setMenuAgentId(null);
    if (await act("archive", { agentId: agent.id })) {
      closeActivity();
      setTab("agents");
    }
  };
  const confirmSendHome = async () => {
    if (!confirmAgent || confirmIdentity.trim() !== confirmName && confirmIdentity.trim() !== confirmAgent.id ||
      confirmSubmitting) return;
    setConfirmSubmitting(true);
    try {
      setConfirmError("");
      setActionError("");
      updateRoom(await post("fire", {
        agentId: confirmAgent.id, confirmedAgentId: confirmAgent.id, retention,
      }));
      setConfirmAgentId(null);
      setConfirmIdentity("");
      closeActivity();
      setTab("agents");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConfirmError(`Could not fire this agent; its record remains unchanged. ${message}`);
      setActionError(message);
    } finally {
      setConfirmSubmitting(false);
    }
  };
  useEffect(() => {
    const index = actorsRef.current.findIndex((actor) => actor?.key === selected);
    const agent = roomRef.current?.agents.find(item => item.sessionId === selected);
    if (selected && !agent) {
      unfocusActor();
      return;
    }
    const key = `${selected}:${agent?.archived ? "archived" : index}`;
    if (focusedKey.current !== key) {
      worldRef.current?.focusAgent(!agent?.archived && index >= 0 && index < MAX_LIVE_DESKS ? index : null);
      focusedKey.current = key;
    }
  }, [sdkRoom?.revision, selected]);
  const daylight = sampleDaylight(sceneRef.current?.time ?? 0, previewOffset);
  const previewLight = () => {
    previewRef.current = (previewRef.current + 0.25) % 1;
    setPreviewOffset(previewRef.current);
  };

  return (
    <main className={`shell live-shell ${panelOpen ? "activity-visible" : ""}`}>
      <style>{`
        .live-shell .activity-tabs { grid-template-columns: repeat(3, 1fr); }
        .career-panel, .upgrade-shop { display: grid; gap: 8px; padding: 12px; margin: 12px 0;
          border: 1px solid var(--office-border); border-radius: 8px; background: var(--office-panel); }
        .career-panel h4, .upgrade-shop h4 { margin: 4px 0; }
        .career-panel p, .upgrade-shop p { margin: 0; }
        .career-panel ul { display: grid; gap: 8px; padding-left: 17px; }
        .career-panel li span, .career-panel li small { display: block; overflow-wrap: anywhere; }
        .career-meter { height: 8px; border-radius: 8px; background: var(--office-muted); overflow: hidden; }
        .career-meter span { display: block; height: 100%; background: var(--office-accent); }
        .career-candidates, .upgrade-shop ul { display: grid; gap: 7px; }
        .career-panel button, .upgrade-shop button, .outcome-dialog button { min-height: 30px; padding: 5px 9px;
          border: 1px solid var(--office-border); border-radius: 5px; color: var(--office-text);
          background: var(--office-muted); cursor: pointer; }
        .career-panel button:disabled, .upgrade-shop button:disabled { opacity: .5; cursor: not-allowed; }
        .upgrade-shop ul { padding: 0; margin: 0; list-style: none; }
        .upgrade-shop li { display: grid; gap: 4px; padding: 8px; border: 1px solid var(--office-border);
          border-radius: 6px; }
        .outcome-dialog { display: grid; gap: 12px; }
        .outcome-dialog label { display: grid; gap: 5px; }
        .outcome-dialog textarea, .outcome-dialog select { width: 100%; padding: 7px; box-sizing: border-box;
          background: var(--office-muted); color: var(--office-text); border: 1px solid var(--office-border); }
        .meeting-panel { display: grid; gap: 0; padding: 0 0 32px; }
        .meeting-panel h3 { margin: 0; font-size: 15px; }
        .meeting-intro h3 { margin: 6px 0 8px; font-size: 19px; }
        .meeting-panel p, .meeting-panel small { color: var(--office-secondary); font-size: 11px; line-height: 1.5; }
        .meeting-panel p { margin: 0; }
        .meeting-panel form, .meeting-detail { display: grid; gap: 13px; }
        .meeting-panel label { display: grid; gap: 5px; font-size: 11px; font-weight: 600; }
        .meeting-panel input:not([type="checkbox"]), .meeting-panel textarea {
          width: 100%; min-width: 0; box-sizing: border-box; padding: 7px; border: 1px solid var(--office-border);
          border-radius: 5px; color: var(--office-text); background: var(--office-muted); font: 12px var(--sans); }
        .meeting-panel textarea { resize: vertical; }
        .meeting-panel fieldset { display: grid; gap: 8px; margin: 0; padding: 12px 0;
          border: 0; border-top: 1px solid var(--office-border); border-bottom: 1px solid var(--office-border); }
        .meeting-panel legend { font-size: 11px; font-weight: 650; }
        .meeting-panel fieldset label { display: flex; align-items: center; gap: 7px; font-weight: 400; }
        .meeting-panel fieldset input { flex: none; }
        .meeting-panel .meeting-owners label { display: grid; }
        .meeting-panel button { min-height: 30px; padding: 5px 8px; border: 1px solid var(--office-border);
          border-radius: 5px; color: var(--office-text); background: var(--office-muted); cursor: pointer; }
        .meeting-panel button:disabled { opacity: .55; cursor: not-allowed; }
        .meeting-panel .meeting-list { display: grid; gap: 5px; }
        .meeting-panel .meeting-list button { text-align: left; overflow-wrap: anywhere; }
        .meeting-panel .meeting-list button[aria-current="true"] { border-color: var(--office-accent); background: var(--office-accent-bg); }
        .meeting-panel .meeting-actions { display: flex; flex-wrap: wrap; gap: 6px; }
        .meeting-panel .meeting-turn { padding: 11px 0 11px 13px; border-left: 2px solid var(--office-accent);
          background: transparent; overflow-wrap: anywhere; }
        .meeting-panel .meeting-turn strong { font-size: 11px; }
        .meeting-panel .meeting-turn .message-markdown { font-size: 12px; }
        .meeting-panel .meeting-turn .message-markdown p { color: var(--office-text); }
        .meeting-panel .meeting-status { width: fit-content; padding: 6px 9px; border-radius: 5px;
          background: var(--office-accent-bg); color: var(--office-accent); font-weight: 650; text-transform: capitalize; }
        .meeting-panel .meeting-status-interrupted { background: var(--office-warning-bg); color: var(--office-warning); }
        .meeting-panel .meeting-status-cancelled { background: var(--office-muted); color: var(--office-secondary); }
        .meeting-panel .meeting-primary { justify-self: start; background: var(--office-accent-bg); color: var(--office-accent); }
        .meeting-options-panel { display: grid; gap: 11px; padding: 10px 0; }
        .meeting-options-panel[hidden] { display: none; }
        .meeting-panel :is(button, input, textarea, select, summary):focus-visible {
          outline: 2px solid var(--office-accent); outline-offset: 2px; }
        .live-shell .keyboard-agent-target[data-meeting-participant="true"]::after {
          content: ""; position: absolute; right: -3px; top: -3px; width: 9px; height: 9px;
          border: 2px solid #fff; border-radius: 50%; background: #8254b7; box-shadow: 0 0 0 1px #483068; }
      `}</style>
      <header className="topbar">
        <div className="identity">
          <span className="brand-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" shapeRendering="crispEdges" focusable="false">
              <rect width="16" height="16" rx={HAPPY_MACHINES_BADGE.radius}
                fill={darkTheme ? HAPPY_MACHINES_BADGE.dark : HAPPY_MACHINES_BADGE.light} />
              {mark.flatMap(({ color, rects }, layer) =>
                rects.map(([x, y, width, height], index) =>
                  <rect key={`${layer}-${index}`} x={x} y={y} width={width} height={height} fill={color} />))}
            </svg>
          </span>
          <svg className="brand-wordmark" viewBox={`0 0 ${HAPPY_MACHINES_WORDMARK.length * 6 - 1} 7`}
            role="img" aria-label="HappyMachines"
            shapeRendering="crispEdges">
            {wordmarkPaths.map((path, index) =>
              <path key={index} d={path} fill={index < 5 ? "var(--office-text)" : "var(--office-purple)"} />)}
          </svg>
          <div className="identity-controls">
            <button type="button" className="time-preview" onClick={previewLight}
              title="Preview the next six hours of decorative office lighting"
              aria-label={`Office lighting ${daylight.label}; preview next six hours`}>
              <span className="time-icon" aria-hidden="true">{daylight.sun > 1 ? "☼" : daylight.moon > 0.2 ? "☾" : "◑"}</span>
              <span className="time-value">{daylight.label}</span>
              <span className="time-arrow" aria-hidden="true">↻</span>
            </button>
            <button type="button" className="theme-toggle" onClick={toggleTheme}
              aria-label={`Switch to ${darkTheme ? "light" : "dark"} theme`}
              title={`HUD appearance: ${themePreference === "system" ? "system" : themePreference}`}>
              <span aria-hidden="true">{darkTheme ? "☼" : "☾"}</span>
            </button>
          </div>
        </div>
        <div className="top-stats" aria-hidden={panelOpen} inert={panelOpen}>
          <button type="button" className="add-agent-button" disabled={!connected || firstEmptyDesk === undefined}
            aria-label={officeFull ? `Office full (${MAX_AGENTS} desks)` : "Add agent: choose a desk"}
            title={officeFull ? `All ${MAX_AGENTS} office desks are occupied` : "Choose a desk for the new agent"}
            onClick={event => openDeskChoice({ kind: "create" }, event.currentTarget)}>
            {officeFull ? <>Office full <span className="desk-capacity">({MAX_AGENTS} desks)</span></> : "+ Add agent"}
          </button>
          <button ref={activityToggle} type="button" className="system-toggle" aria-expanded={panelOpen} aria-controls="system-panel"
            aria-label={`Manage agents${blocked ? `: ${blocked} agent${blocked === 1 ? "" : "s"} need permission review` : ""}${!connected ? `; ${signLabel}` : ""}`}
            onClick={() => setPanelOpen(true)}>Manage agents
            {(blocked > 0 || !connected) && <span className={`activity-attention ${!connected ? "connection-attention" : ""}`}
              aria-hidden="true">{blocked || "!"}</span>}
            <span className="toggle-chevron" aria-hidden="true" /></button>
        </div>
      </header>
      <div className="layout">
        <section className="world-panel" aria-label="Live Copilot office">
          <div ref={host} className="world-host">
            {hover && <div ref={hoverLabelRef} className="agent-hover" style={{ left: hover.x, top: hover.y }}>{hover.name}</div>}
            {connected && Array.from({ length: deskCount }, (_, deskIndex) =>
              activeAgents.some(agent => agent.deskIndex === deskIndex) ? null :
                <button key={deskIndex} type="button" className="desk-add" data-desk-index={deskIndex}
                  aria-label={`Add independent SDK agent at empty desk ${deskIndex + 1}`}
                  title={`Add agent at desk ${deskIndex + 1}`}
                  onClick={() => void createAgent(deskIndex)}>+</button>)}
            {activeAgents.map(agent => {
              const actor = actors.find(item => item.key === agent.sessionId);
              const inMeeting = sceneMeeting?.participantIds.includes(agent.id) ?? false;
              return <button key={agent.id} type="button" className="keyboard-agent-target"
                data-agent-desk={agent.deskIndex}
                data-meeting-participant={inMeeting || undefined}
                aria-label={`Chat with ${actor?.name ?? "agent"} at desk ${agent.deskIndex + 1}${inMeeting ? `; in ${sceneMeeting?.kind}` : ""}`}
                onFocus={() => {
                  const point = worldRef.current?.projectAgent(agent.deskIndex);
                  hoverDeskRef.current = agent.deskIndex;
                  if (point && actor) setHover({ name: `${actor.name}${inMeeting ? ` · ${sceneMeeting?.kind}` : ""}`, ...point });
                }}
                onBlur={() => {
                  if (selectedRef.current !== agent.sessionId) {
                    hoverDeskRef.current = null;
                    setHover(null);
                  }
                }}
                onClick={() => selectActor(agent.sessionId)} />;
            })}
            <div className="world-callout live-callout" role="status" aria-live="polite">
              <button type="button" className={`office-status-link sdk-${signKind}`}
                aria-label={`SDK status: ${signLabel}. Open connection details`}
                title={sdkRoom?.error || connection}
                onClick={() => { setTab("office"); setPanelOpen(true); }}>
                <span className="sdk-status-dot" aria-hidden="true" /> SDK {compactStatus}
              </button>
              <span className="callout-separator" aria-hidden="true" />
              <span>{activeAgents.length ? `${working} working · ${idle} idle${blocked ? ` · ${blocked} need permission` : ""}${unavailable ? ` · ${unavailable} unavailable` : ""}` :
                connected ? "Click + at a desk to create an agent" : "Open Manage agents for connection details"}</span>
              {sceneMeeting && <button type="button" className="office-status-link"
                onClick={() => { unfocusActor(); setTab("meetings"); selectMeeting(sceneMeeting); setPanelOpen(true); }}>
                {sceneMeeting.kind === "review" ? "Review" : "Meeting"} · {sceneMeeting.participantIds.length} agents
              </button>}
            </div>
          </div>
        </section>
        <aside id="system-panel" className={`sidebar activity-panel ${panelOpen ? "sidebar-open" : ""} ${selectedAgent ? "chat-open" : ""}`}
          aria-label={selectedAgent ? `${selectedActor?.name ?? "Agent"} ${setupOpen ? "profile setup" : settingsOpen ? "settings" : "conversation"}` : "Manage"}
          aria-hidden={!panelOpen} inert={!panelOpen}>
          <div className="activity-header">
            <div className="activity-title-row">
              {selectedAgent ? <button ref={setupOpen || settingsOpen ? agentDetailBack : undefined}
                type="button" className="chat-back"
                onClick={setupOpen && selectedPersona?.setupCompleted === false ? backToActivity :
                  setupOpen || settingsOpen ? backToConversation : backToActivity}
                aria-label={setupOpen && selectedPersona?.setupCompleted === false ? "Back to agents" :
                  setupOpen || settingsOpen ? "Back to conversation" : "Back to agents"}>←</button> : tab === "store" &&
                <button ref={storeBack} type="button" className="chat-back" onClick={backToOverview}
                  aria-label="Back to Overview">←</button>}
              <h2>{selectedAgent ? settingsOpen ? "Agent settings" : setupOpen && selectedPersona?.setupCompleted !== false ?
                "Edit agent" : selectedActor?.name : tab === "store" ? "Store" : "Manage"}</h2>
              {selectedAgent && <span className={`activity-tag chat-status status-${selectedActor?.status}`}>
                {selectedAgent.archived ? "Archived" : selectedAgent.phase}</span>}
              {selectedPersona && selectedPersona.setupCompleted !== false && selectedAgent && !setupOpen && !settingsOpen &&
                <Button ref={editAgentButton} type="button" className="profile-header-edit"
                  aria-label="Edit agent" title="Edit agent" onClick={() => startProfileEdit(selectedPersona)}>
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 14.5V17h2.5L16 7.5 12.5 4 3 13.5v3.5h3.5M11.5 5l3.5 3.5" /></svg>
                </Button>}
              {selectedAgent && !setupOpen && !settingsOpen && <div className="chat-options" data-chat-options>
                <button ref={chatOptionsButton} type="button" className="chat-options-toggle" aria-label={`Options for ${selectedActor?.name ?? "agent"}`}
                  aria-expanded={chatOptionsOpen} aria-controls="chat-options-menu"
                  onClick={() => setChatOptionsOpen(open => !open)}>⋯</button>
                {chatOptionsOpen && <div id="chat-options-menu" className="chat-options-menu"
                  aria-label={`Options for ${selectedActor?.name ?? "agent"}`}>
                  <button type="button" disabled={!!selectedAgent.review || !!selectedAgent.accessRequest}
                    title={selectedAgent.review || selectedAgent.accessRequest ? "Respond to the pending request first" : undefined}
                    onClick={openSettings}>Agent settings & more options</button>
                  <strong>Repository access</strong>
                  {selectedAgent.repository ? <>
                    <span>{selectedAgent.repository.name} · {selectedAgent.repository.worktree ? "edit worktree" :
                      selectedAgent.repository.scope === "task" ? "read this task" : "read this session"}</span>
                    <code>{selectedAgent.repository.worktree?.path ?? selectedAgent.repository.path}</code>
                    {selectedAgent.repository.worktree && <small>Branch {selectedAgent.repository.worktree.branch} stays on revoke.</small>}
                    <button type="button" disabled={lifecycleBusy(selectedAgent)}
                      onClick={() => void act("access-revoke", { agentId: selectedAgent.id }).then(ok => {
                        if (ok) setChatOptionsOpen(false);
                      })}>Revoke access</button>
                  </> : <span>No assignment repository attached.</span>}
                  {selectedPersona && <small>Effective project read: {effectiveProjectAccess(
                    sdkRoom?.projects ?? [], selectedPersona.repositoryPolicies, selectedAgent.repository)
                    .filter(item => item.read).map(item => item.project.repository.fullName).join(", ") || "none"}.
                    Manage direct and office access in the agent inspector.</small>}
                  {!selectedAgent.archived && <button type="button" disabled={lifecycleBusy(selectedAgent)}
                    onClick={() => void act("access-request", { agentId: selectedAgent.id }).then(ok => {
                      if (ok) setChatOptionsOpen(false);
                    })}>Find a GitHub repository…</button>}
                </div>}
              </div>}
              <button ref={activityClose} type="button" className="sidebar-close" onClick={closeActivity}
                aria-label={selectedAgent ? "Close conversation" : "Close Manage"}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
              </button>
            </div>
          </div>
          {!selectedAgent && tab !== "store" && <nav className="activity-tabs" aria-label="Manage views">
            {([["office", "Overview"], ["agents", "Agents"], ["meetings", "Meetings"]] as const).map(([item, label]) => (
              <button key={item} type="button" aria-pressed={tab === item}
                onClick={() => setTab(item)}>{label}</button>
            ))}
          </nav>}
          <div ref={chatScroll} className={`activity-scroll ${selectedAgent && !setupOpen && !settingsOpen ? "conversation-scroll" : "activity-list-scroll"}`}
            onScroll={event => {
              if (!selectedAgent || setupOpen || settingsOpen) return;
              const scroll = event.currentTarget;
              followTail.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 70;
            }}>
            {!selectedAgent && tab === "office" && (
              <section className="activity-view overview-list" aria-label="Office overview">
                <div className="activity-row activity-row-first overview-office">
                  <div className="activity-row-heading"><span className="activity-tag">{deskCount} desks</span></div>
                  <div className="overview-metrics">
                    <div><strong>{activeAgents.length}</strong><span>At desks</span></div>
                    <div><strong>{deskCount - activeAgents.length}</strong><span>Open</span></div>
                    <div><strong>{(sdkRoom?.agents.length ?? 0) - activeAgents.length}</strong><span>Archived</span></div>
                    <div className={blocked ? "attention" : ""}><strong>{blocked}</strong><span>Attention</span></div>
                  </div>
                  {!sdkRoom && <p role="status">Connecting to the local office…</p>}
                  {sdkRoom && !activeAgents.length && <p>No agents yet. Add one at an empty desk or from the top bar.</p>}
                </div>
                <div className="activity-row overview-store-entry">
                  <div className="activity-row-heading"><strong>Store</strong>
                    <span className="activity-tag">{career.balance} credits</span></div>
                  <p>Decorative office upgrades · {career.purchases.size} installed</p>
                  <Button ref={storeEntry} type="button" onClick={() => setTab("store")}>Open Store →</Button>
                </div>
                <div className="overview-group-label">Configuration</div>
                {!connected && <div className="activity-row overview-connection" role="status">
                  <strong>SDK needs attention</strong><p>{sdkRoom?.error || connection}</p>
                  <Button type="button" disabled={!sdkRoom} onClick={() => void act("retry", {})}>Retry SDK connection</Button>
                </div>}
                <Disclosure.Root className="activity-row overview-model">
                  <div className="activity-row-heading"><strong>Model provider</strong>
                    <span className="activity-tag">{sdkRoom?.defaultModelProfileId ?? "copilot"}</span></div>
                  <SelectField label="Default for new agents" disabled={!sdkRoom || !connected}
                    value={sdkRoom?.defaultModelProfileId ?? "copilot"}
                    onValueChange={id => void act("model-default", { id })}
                    options={(sdkRoom?.modelProfiles ?? [{ id: "copilot", kind: "copilot", model: "auto" }]).map(profile =>
                      ({ value: profile.id, label: `${profile.id} · ${profile.kind} / ${profile.model}` }))} />
                  <Disclosure.Trigger className="overview-disclosure">Add a model profile or see provider details</Disclosure.Trigger>
                  <Disclosure.Panel className="ui-disclosure-panel overview-disclosure-panel">
                    <p>Profiles are immutable. Changing the default affects new agents only; use a new assignment to change an existing agent's model.</p>
                    <p>Copilot requires CLI sign-in; external providers receive prompts and tool context. Use an environment variable name, never a key. GitHub authentication and tool permissions remain separate.</p>
                    <form className="overview-model-form" onSubmit={event => {
                    event.preventDefault();
                    const profile: ModelProfile = {
                      id: modelDraft.id.trim(), kind: modelDraft.kind, model: modelDraft.model.trim(),
                      ...(modelDraft.kind !== "copilot" ? { endpoint: modelDraft.endpoint.trim() } : {}),
                      ...(modelDraft.kind !== "copilot" && modelDraft.credentialEnv.trim() ?
                        { credentialEnv: modelDraft.credentialEnv.trim() } : {}),
                      ...(["openai", "azure"].includes(modelDraft.kind) ? { wireApi: modelDraft.wireApi } : {}),
                      ...(modelDraft.kind !== "copilot" && modelDraft.wireModel.trim() ? { wireModel: modelDraft.wireModel.trim() } : {}),
                      ...(modelDraft.azureApiVersion.trim() && modelDraft.kind === "azure" ?
                        { azureApiVersion: modelDraft.azureApiVersion.trim() } : {}),
                      ...(modelDraft.kind !== "copilot" && modelDraft.maxPromptTokens ? { maxPromptTokens: Number(modelDraft.maxPromptTokens) } : {}),
                      ...(modelDraft.kind !== "copilot" && modelDraft.maxOutputTokens ? { maxOutputTokens: Number(modelDraft.maxOutputTokens) } : {}),
                      ...(modelDraft.kind !== "copilot" && modelDraft.maxContextWindowTokens ?
                        { maxContextWindowTokens: Number(modelDraft.maxContextWindowTokens) } : {}),
                      ...(modelDraft.kind !== "copilot" && modelDraft.supportsVision ? { supportsVision: true } : {}),
                      ...(modelDraft.kind !== "copilot" && modelDraft.supportsReasoningEffort ? { supportsReasoningEffort: true } : {})
                    };
                    void act("model-profile", profile);
                  }}>
                    <h3>Add immutable model profile</h3>
                    <label>Profile ID <input required pattern="[a-zA-Z][a-zA-Z0-9_-]*" maxLength={64} value={modelDraft.id}
                      onChange={event => setModelDraft(draft => ({ ...draft, id: event.target.value }))} /></label>
                    <SelectField label="Provider" value={modelDraft.kind} onValueChange={kind => setModelDraft(draft => ({
                      ...draft, kind,
                      endpoint: kind === "ollama" ? "http://127.0.0.1:11434/v1" : ""
                    }))} options={[
                      { value: "copilot", label: "Copilot account model" },
                      { value: "ollama", label: "Local Ollama" },
                      { value: "openai", label: "OpenAI-compatible HTTPS" },
                      { value: "anthropic", label: "Anthropic HTTPS" },
                      { value: "azure", label: "Azure HTTPS" },
                    ]} />
                    <label>Model ID <input required value={modelDraft.model}
                      onChange={event => setModelDraft(draft => ({ ...draft, model: event.target.value }))} /></label>
                    {modelDraft.kind !== "copilot" && <label>Endpoint <input required type="url" value={modelDraft.endpoint}
                      onChange={event => setModelDraft(draft => ({ ...draft, endpoint: event.target.value }))} /></label>}
                    {modelDraft.kind !== "copilot" && <label>API key environment variable name {modelDraft.kind === "ollama" && "(optional)"}
                      <input required={modelDraft.kind !== "ollama"} placeholder="MY_PROVIDER_API_KEY" value={modelDraft.credentialEnv}
                        onChange={event => setModelDraft(draft => ({ ...draft, credentialEnv: event.target.value }))} /></label>}
                    {["openai", "azure"].includes(modelDraft.kind) && <SelectField label="Wire API"
                      value={modelDraft.wireApi} onValueChange={wireApi => setModelDraft(draft => ({ ...draft, wireApi }))}
                      options={[{ value: "completions", label: "Chat completions" },
                        { value: "responses", label: "Responses" }]} />}
                    {modelDraft.kind !== "copilot" && <Disclosure.Root className="overview-advanced">
                      <Disclosure.Trigger className="overview-disclosure">Advanced model settings</Disclosure.Trigger>
                      <Disclosure.Panel className="ui-disclosure-panel overview-advanced-panel">
                      <label>Wire model / Azure deployment <input value={modelDraft.wireModel}
                        onChange={event => setModelDraft(draft => ({ ...draft, wireModel: event.target.value }))} /></label>
                      {modelDraft.kind === "azure" && <label>Azure API version <input placeholder="2024-10-21" value={modelDraft.azureApiVersion}
                        onChange={event => setModelDraft(draft => ({ ...draft, azureApiVersion: event.target.value }))} /></label>}
                      <label>Max prompt tokens <input type="number" min="1024" value={modelDraft.maxPromptTokens}
                        onChange={event => setModelDraft(draft => ({ ...draft, maxPromptTokens: event.target.value }))} /></label>
                      <label>Max output tokens <input type="number" min="1" value={modelDraft.maxOutputTokens}
                        onChange={event => setModelDraft(draft => ({ ...draft, maxOutputTokens: event.target.value }))} /></label>
                      <label>Context window tokens <input type="number" min="1024" value={modelDraft.maxContextWindowTokens}
                        onChange={event => setModelDraft(draft => ({ ...draft, maxContextWindowTokens: event.target.value }))} /></label>
                      <div className="ui-toggle-row"><Toggle label="Model supports vision" checked={modelDraft.supportsVision}
                        onCheckedChange={supportsVision => setModelDraft(draft => ({ ...draft, supportsVision }))} />
                        <span>Model supports vision</span></div>
                      <div className="ui-toggle-row"><Toggle label="Model supports reasoning effort" checked={modelDraft.supportsReasoningEffort}
                        onCheckedChange={supportsReasoningEffort => setModelDraft(draft => ({ ...draft, supportsReasoningEffort }))} />
                        <span>Model supports reasoning effort</span></div>
                      </Disclosure.Panel>
                    </Disclosure.Root>}
                    <Button type="submit" className="overview-primary">Save profile (no secrets)</Button>
                  </form>
                  <Button type="button" className="overview-model-list" onClick={() => void fetch("/api/copilot-models").then(async response => {
                    const result: unknown = await response.json();
                    if (!response.ok) throw new Error((result as { error?: string }).error ?? `Model list returned ${response.status}`);
                    if (!Array.isArray(result)) throw new Error("Invalid model list.");
                    setCopilotModels(result as { id: string; name: string }[]);
                  }).catch(error => setActionError(`Copilot model list unavailable: ${error instanceof Error ? error.message : String(error)}`))}>
                    List Copilot account models</Button>
                  {copilotModels && <p role="status">{copilotModels.length ? copilotModels.map(model => `${model.name} (${model.id})`).join(", ") :
                    "No Copilot account models returned."}</p>}
                  </Disclosure.Panel>
                </Disclosure.Root>
                <div className="activity-row project-configurations">
                  <div className="activity-row-heading"><strong>Global project access</strong>
                    <span className="activity-tag">{sdkRoom?.projects?.length ?? 0} verified</span></div>
                  <p>Share read access with agents or allow separately approved task worktrees. Agent exclusions stay in the profile.</p>
                  {projectChooser()}
                  {!sdkRoom?.projects?.length && <p>No verified repositories yet.</p>}
                  <ul className="project-list">{sdkRoom?.projects?.map(project => <li key={project.repository.fullName}>
                    <div><strong>{project.repository.fullName}</strong>
                      <small>GitHub · {project.repository.privacy} · {project.repository.defaultBranch}</small></div>
                    <div className="overview-share"><Toggle checked={project.sharedRead} disabled={!connected}
                      label={`Global read for ${project.repository.fullName}`}
                      onCheckedChange={checked => void act("project-share", {
                        fullName: project.repository.fullName, sharedRead: checked,
                      })} /><span>Global read</span></div>
                    <div className="overview-share"><Toggle checked={project.sharedWrite === true} disabled={!connected}
                      label={`Task worktree eligibility for ${project.repository.fullName}`}
                      onCheckedChange={checked => void act("project-write", {
                        fullName: project.repository.fullName, sharedWrite: checked,
                      })} /><span>Eligible for task worktrees (manual tools prompt by default)</span></div>
                  </li>)}</ul>
                </div>
                <div className="activity-row">
                  <div className="activity-row-heading"><strong>Scratch workspace root</strong><span className="activity-tag">Local only</span></div>
                  <p className="workspace-path">{sdkRoom?.workspace || "Loading…"}</p>
                  <p>{sdkRoom?.agents.some(agent => agent.workspaceKind === "root") ?
                    "An existing agent retains this root; new agents use separate subfolders." :
                    "Each agent uses a separate subfolder."} Worktrees are not OS sandboxes; review shell and write permissions.</p>
                </div>
                <div className="activity-row">
                  <div className="activity-row-heading"><strong>SDK usage · all recorded agents</strong>
                    <span className="activity-tag">On demand</span></div>
                  {sdkRoom?.usage ? <p>{sdkRoom.usage.status === "unavailable" ? "Usage unavailable from the SDK." :
                    `${sdkRoom.usage.tokens.toLocaleString()} tokens · ${sdkRoom.usage.calls.toLocaleString()} model calls · ${sdkRoom.usage.filesChanged.toLocaleString()} session-file counts.`}
                    {" "}Last refreshed {new Date(sdkRoom.usage.updatedAt).toLocaleString()}
                    {sdkRoom.usage.status === "partial" ? ` · Partial: ${sdkRoom.usage.measured}/${sdkRoom.usage.total} sessions measured.` : ""}
                    {sdkRoom.usage.stale ? " · Outdated; refresh for recent work." : ""}</p> :
                    <p>Usage not loaded yet.</p>}
                  <button type="button" className="focus-button" disabled={!connected} onClick={() => void act("usage", {})}>Refresh SDK usage</button>
                </div>
                {!!sdkRoom?.worktrees?.length && <div className="activity-row">
                  <div className="activity-row-heading"><strong>Preserved worktrees</strong>
                    <span className="activity-tag">{sdkRoom.worktrees.length} created</span></div>
                  <p>Never deleted on revoke, archive or fire. Inspect or clean up manually with Git after reviewing changes.</p>
                  {sdkRoom.worktrees.map(tree => <p className="workspace-path" key={tree.path}>
                    {tree.branch} · {tree.path}</p>)}
                </div>}
              </section>
            )}
            {!selectedAgent && tab === "store" && (
              <section className="activity-view overview-list store-view" aria-label="Office Store">
                <div className="activity-row upgrade-shop">
                  <div className="activity-row-heading"><strong>Office upgrades</strong>
                    <span className="activity-tag">{career.balance} credits</span></div>
                  <p>Decorative upgrades only. Earn credits from confirmed outcomes.</p>
                  <ul>{UPGRADES.map(upgrade => <li key={upgrade.id}>
                    <strong>{upgrade.name}</strong>
                    <span>{upgrade.description}</span>
                    {career.purchases.has(upgrade.id) ? <span className="overview-installed">Installed</span> :
                      <Button type="button" disabled={career.balance < upgrade.price}
                        onMouseEnter={() => worldRef.current?.setUpgrades([...career.purchases, upgrade.id])}
                        onMouseLeave={() => worldRef.current?.setUpgrades([...career.purchases])}
                        onFocus={() => worldRef.current?.setUpgrades([...career.purchases, upgrade.id])}
                        onBlur={() => worldRef.current?.setUpgrades([...career.purchases])}
                        onClick={() => {
                          if (window.confirm(`Preview: ${upgrade.description}. Purchase ${upgrade.name} for ${upgrade.price} credits? Balance after: ${career.balance - upgrade.price}. Decorative only.`)) {
                            void act("upgrade-purchase", { upgradeId: upgrade.id, confirmed: true });
                          }
                        }}>Preview & buy · {upgrade.price}</Button>}
                  </li>)}</ul>
                  <small>{rewardEvents.length} confirmed outcomes · {career.purchases.size} installed</small>
                </div>
              </section>
            )}
            {!selectedAgent && tab === "meetings" && (
              <section className="activity-view meeting-panel" aria-label="Manual meetings and reviews">
                <div className="meeting-intro panel-section">
                  <span className="overview-group-label">Collaborate</span>
                  <h3>Meetings & reviews</h3>
                  <p>Choose 2–4 available agents. You decide what to share and approve each turn.
                    Chats and repository permissions are never shared automatically.</p>
                </div>
                <form className="panel-section" onSubmit={event => { event.preventDefault(); void createMeeting(); }}>
                  <h3>New handoff</h3>
                  <SelectField label="Format" value={meetingKind} disabled={meetingBusy}
                    onValueChange={setMeetingKind} options={[
                      { value: "meeting", label: "Meeting" }, { value: "review", label: "Review" },
                    ]} />
                  <fieldset>
                    <legend>Participants · select 2–4 active, idle agents</legend>
                    {activeAgents.length === 0 && <small>No agents at desks yet. Add an agent in the Agents tab to begin.</small>}
                    {activeAgents.map(agent => {
                      const checked = meetingParticipants.includes(agent.id);
                      return <label key={agent.id}>
                        <input type="checkbox" checked={checked}
                          disabled={meetingBusy || !connected || (!checked && (!meetingReady(agent) || meetingParticipants.length >= 4))}
                          onChange={() => setMeetingParticipants(ids => checked ?
                            ids.filter(id => id !== agent.id) : [...ids, agent.id])} />
                        {agentName(sdkRoom, agent)} · {agent.phase}{!meetingReady(agent) ? " (unavailable)" : ""}
                      </label>;
                    })}
                    <small>{meetingParticipants.length}/4 selected. Participants must be idle when created.</small>
                  </fieldset>
                  <label>Agenda
                    <textarea required rows={2} maxLength={1000} value={meetingAgenda}
                      onChange={event => setMeetingAgenda(event.target.value)} placeholder="What should the agents discuss or review?" />
                  </label>
                  <label>Excerpts to share explicitly {meetingKind === "review" ? "(required for review)" : "(optional)"}
                    <textarea rows={3} maxLength={6000} required={meetingKind === "review"} value={meetingSharedText}
                      onChange={event => setMeetingSharedText(event.target.value)}
                      placeholder="Paste only the facts or snippets these agents should see." />
                  </label>
                  <Disclosure.Root className="meeting-options">
                    <Disclosure.Trigger className="overview-disclosure">More options</Disclosure.Trigger>
                    <Disclosure.Panel className="ui-disclosure-panel meeting-options-panel">
                      <label>Repository context (optional; does not grant access)
                        <input type="text" maxLength={240} value={meetingRepository}
                          onChange={event => setMeetingRepository(event.target.value)} placeholder="owner/repo" />
                      </label>
                      <SelectField label="Maximum approved turns" value={meetingMaxTurns}
                        onValueChange={setMeetingMaxTurns}
                        options={Array.from({ length: 8 }, (_, index) => ({
                          value: index + 1, label: String(index + 1),
                        }))} />
                    </Disclosure.Panel>
                  </Disclosure.Root>
                  <button type="submit" className="meeting-primary" disabled={!canCreateMeeting}>
                    {meetingBusy ? "Saving…" : "Create handoff"}</button>
                </form>
                {meetings.length > 0 && <div className="panel-section meeting-records">
                  <h3>Handoffs</h3>
                  <div className="meeting-list" aria-label="Recorded handoffs">
                    {meetings.map(meeting => <button type="button" key={meeting.id}
                      aria-current={currentMeeting?.id === meeting.id}
                      onClick={() => selectMeeting(meeting)}>
                      {meeting.kind === "review" ? "Review" : "Meeting"} · {meeting.agenda}
                      {" · "}{meeting.status} · {meeting.turns.length}/{meeting.maxTurns} turns
                    </button>)}
                  </div>
                </div>}
                {currentMeeting && <div className="meeting-detail panel-section" key={currentMeeting.id}>
                  <h3>{currentMeeting.kind === "review" ? "Review" : "Meeting"} · {currentMeeting.agenda}</h3>
                  <p className={`meeting-status meeting-status-${currentMeeting.status}`} role="status">{currentMeeting.status}
                    {meetingTurnPending && " · turn in progress"}
                    {" · "}{currentMeeting.turns.length}/{currentMeeting.maxTurns} turns completed
                  </p>
                  <p>Participants: {currentMeeting.participantIds.map(meetingName).join(" · ")}</p>
                  {currentMeeting.repository && <p>Repository context: <code>{currentMeeting.repository}</code> (no access granted)</p>}
                  {currentMeeting.sharedText && <Disclosure.Root>
                    <Disclosure.Trigger>Explicitly shared excerpts</Disclosure.Trigger>
                    <Disclosure.Panel className="ui-disclosure-panel">
                      <div className="message-markdown"><SafeMarkdown content={currentMeeting.sharedText} /></div>
                    </Disclosure.Panel>
                  </Disclosure.Root>}
                  {currentMeeting.error && <p role="alert">Partial result · {currentMeeting.error}</p>}
                  {currentMeeting.turns.map((turn, index) => <div className="meeting-turn" key={`${index}-${turn.at}`}>
                    <strong>Turn {index + 1} · {meetingName(turn.agentId)} · {new Date(turn.at).toLocaleString()}</strong>
                    <div className="message-markdown"><SafeMarkdown content={turn.response} /></div>
                  </div>)}
                  {!currentMeeting.turns.length && <p>No turns yet. Creating a handoff does not send a turn.</p>}
                  {(currentMeeting.status === "open" || currentMeeting.status === "running") && <>
                    <p>{meetingTurnPending ? "Waiting for this turn to finish before another approval." :
                      currentMeeting.nextIndex >= currentMeeting.maxTurns ? "Turn limit reached. Record the outcome or cancel." :
                        `Next: ${meetingName(nextMeetingAgent ?? "")}. Approve only when ready.`}</p>
                    {currentMeeting.status === "open" && currentMeeting.turns.length > 0 && <>
                      <label>Curated handoff excerpt for the next agent (required)
                        <textarea rows={3} maxLength={4000} value={meetingHandoffs[handoffKey] ?? ""}
                          onChange={event => setMeetingHandoffs(handoffs =>
                            ({ ...handoffs, [handoffKey]: event.target.value }))}
                          placeholder="Write or paste only what the next agent should receive." />
                      </label>
                      <small>The previous response is displayed above for review, but is not automatically shared.
                        Select only the relevant excerpt yourself before approving the next turn.</small>
                    </>}
                    <div className="meeting-actions">
                      <button type="button" className="meeting-primary" disabled={!canAdvanceMeeting}
                        onClick={() => void advanceMeeting()}>
                        Approve one next turn
                      </button>
                      <button type="button" disabled={meetingBusy}
                        onClick={() => void meetingAction("meeting-cancel", { meetingId: currentMeeting.id })}>Cancel handoff</button>
                    </div>
                  </>}
                  {(currentMeeting.status === "open" || currentMeeting.status === "interrupted") && <>
                      <label>Outcome summary
                        <textarea rows={3} maxLength={4000} value={meetingSummary}
                          onChange={event => setMeetingSummary(event.target.value)}
                          placeholder="Record the decision, findings, or next steps." />
                      </label>
                      <fieldset className="meeting-owners"><legend>Optional owner tasks (recorded, not automatically assigned)</legend>
                        {currentMeeting.participantIds.map(agentId => <label key={agentId}>{meetingName(agentId)}
                          <input type="text" maxLength={500} value={meetingOwners[agentId] ?? ""}
                            onChange={event => setMeetingOwners(owners => ({ ...owners, [agentId]: event.target.value }))}
                            placeholder="Follow-up task, if any" />
                        </label>)}
                      </fieldset>
                      <button type="button" disabled={meetingBusy || !meetingSummary.trim()}
                        onClick={() => void finishMeeting()}>Finish with summary</button>
                  </>}
                  {currentMeeting.status === "interrupted" && <div className="meeting-actions">
                    <button type="button" disabled={meetingBusy}
                      onClick={() => void meetingAction("meeting-cancel", { meetingId: currentMeeting.id })}>Cancel handoff</button>
                    <small>Review the partial result above, then finish with a summary or cancel.</small>
                  </div>}
                  {(currentMeeting.status === "completed" || currentMeeting.status === "cancelled") && <>
                    {currentMeeting.summary && <div><strong>Summary</strong>
                      <div className="message-markdown"><SafeMarkdown content={currentMeeting.summary} /></div></div>}
                    {!!currentMeeting.owners.length && <div><strong>Recorded owner tasks</strong>
                      {currentMeeting.owners.map(owner => <p key={owner.agentId}>
                        {meetingName(owner.agentId)}: {owner.task}
                        {owner.assignmentId && <> · assignment {owner.assignmentId.slice(0, 8)}</>}</p>)}</div>}
                    {!currentMeeting.summary && <p>Handoff ended without a final summary. Completed turns above remain available.</p>}
                  </>}
                </div>}
              </section>
            )}
            {!selectedAgent && tab === "agents" && (
              <section className="activity-view conversations-list" aria-label="Agents and conversations">
                {!(sdkRoom?.agents.length) && <div className="activity-empty agents-empty">
                  <strong>Your office is ready for its first agent.</strong>
                  <p>Create an agent to start a conversation or assign work.</p>
                  <Button type="button" disabled={!connected || firstEmptyDesk === undefined}
                    onClick={event => openDeskChoice({ kind: "create" }, event.currentTarget)}>+ Add agent · choose desk</Button>
                </div>}
                {[...(sdkRoom?.agents ?? [])].sort((a, b) =>
                  Number(a.archived) - Number(b.archived) || b.updatedAt - a.updatedAt ||
                  (a.deskIndex ?? a.lastDeskIndex ?? 0) - (b.deskIndex ?? b.lastDeskIndex ?? 0)).map(agent => {
                  const actor = actors.find(item => item.key === agent.sessionId);
                  const last = agent.messages.at(-1);
                  const name = agentName(sdkRoom, agent);
                  return <div className={`conversation-row ${agent.archived ? "agent-archived" : ""}`} key={agent.id}>
                    <button type="button" className="agent-row-main" onClick={() => selectActor(agent.sessionId)}
                      aria-label={`Open ${name}${agent.archived ? " archived" : ""} conversation`}>
                      <span className="worker-avatar" aria-hidden="true">
                        <img src={agentPortrait(agentArt(sdkRoom, agent))} alt="" width="42" height="42" /></span>
                      <span className="conversation-row-text">
                        <strong>{name}</strong>
                        <span className="conversation-preview">{last ? <>
                          {last.role === "user" && "You: "}
                          <SafeMarkdown content={last.content} preview />
                        </> : agent.archived ? "No messages in this assignment" : greetingForPersona(agentArt(sdkRoom, agent))}</span>
                        <small>{agent.archived ? `Archived · former desk ${(agent.lastDeskIndex ?? 0) + 1}` :
                          `Home desk ${agent.deskIndex! + 1} · ${agent.activity}`}</small>
                        {agent.repository && <small>{agent.repository.worktree ? "Worktree" : "Research"}: {agent.repository.name} · {agent.repository.scope === "task" ? "this task" : "this session"}</small>}
                        {agent.accessRequest && <small>Repository access request awaiting you</small>}
                      </span>
                      {agent.review && <span className="activity-tag activity-tag-warning">Review</span>}
                    </button>
                    <div className="agent-actions" data-agent-menu>
                      <button type="button" className="agent-menu-toggle" aria-label={`Actions for ${name}`}
                        aria-haspopup="menu" aria-expanded={menuAgentId === agent.id}
                        onClick={event => {
                          setMenuAgentId(menuAgentId === agent.id ? null : agent.id);
                          event.currentTarget.scrollIntoView({ block: "center" });
                        }}>⋮</button>
                      {menuAgentId === agent.id && <div className="agent-action-menu" role="menu" aria-label={`${name} actions`}>
                        <button role="menuitem" type="button" disabled={!canStartAssignment(agent)}
                          title="Start with a new session; previous assignment and files stay preserved"
                          onClick={() => {
                            setAssignmentAgentId(agent.id);
                            setAssignmentOutcome("");
                            setAssignmentModelProfileId(sdkRoom?.assignments?.find(item => item.id === agent.assignmentId)?.modelProfileId ?? "copilot");
                            setMenuAgentId(null);
                          }}>New assignment…</button>
                        {agent.archived ?
                          <button role="menuitem" type="button" disabled={officeFull}
                            title={officeFull ? "Office full: archive another agent to free a desk" : "Return this agent to an empty desk"}
                            onClick={event => openDeskChoice({ kind: "restore", agentId: agent.id }, event.currentTarget)}>Restore to office…</button> :
                          <>
                          <button role="menuitem" type="button"
                            onClick={event => openDeskChoice({ kind: "move", agentId: agent.id,
                              deskIndex: agent.deskIndex! }, event.currentTarget)}>Move desk…</button>
                          <button role="menuitem" type="button" disabled={lifecycleBusy(agent)}
                            title={lifecycleBusy(agent) ? "Finish the turn or decide the permission first" : "Free the desk but keep the conversation"}
                            onClick={() => void archiveAgent(agent)}>Archive · keep conversation</button></>}
                        <button role="menuitem" type="button" className="agent-menu-danger" disabled={lifecycleBusy(agent)}
                          title={lifecycleBusy(agent) ? "Finish the turn or decide the permission first" : "Choose how to retain the SDK session; working files always remain"}
                          onClick={event => {
                            confirmTriggerRef.current = event.currentTarget.closest("[data-agent-menu]")
                              ?.querySelector<HTMLButtonElement>(".agent-menu-toggle") ?? null;
                            setConfirmAgentId(agent.id);
                            setConfirmIdentity("");
                            setRetention("keep");
                            setConfirmError("");
                            setMenuAgentId(null);
                          }}>
                          Fire agent…</button>
                        {lifecycleBusy(agent) && <small>Wait for the turn or decide its permission first.</small>}
                        {agent.archived && officeFull && <small>Office full: archive another agent before restoring.</small>}
                        <div className="agent-menu-workspace">
                          <span>Tool working directory · {agent.repository?.worktree ? "isolated worktree" :
                            agent.workspaceKind === "root" ? "original root" : "scratch"}</span>
                          <code>{agent.repository?.worktree?.path ?? agent.workspace}</code>
                          {agent.repository?.worktree && <small>Branch: {agent.repository.worktree.branch} · preserved on archive/fire</small>}
                          <small>Not an OS sandbox. Review each tool permission.</small>
                        </div>
                      </div>}
                    </div>
                  </div>;
                })}
                {formerPersonas.length > 0 && <>
                  <h3 className="former-personas-title">Retired agents</h3>
                  {formerPersonas.map(persona =>
                    <Disclosure.Root className="former-persona" key={persona.id}>
                      <Disclosure.Trigger><img src={agentPortrait(persona.artId)} alt="" width="36" height="36" />
                        <span>{persona.name} · {((sdkRoom?.assignments ?? [])
                          .filter(assignment => assignment.personaId === persona.id)).length} preserved assignments</span></Disclosure.Trigger>
                      <Disclosure.Panel className="ui-disclosure-panel persona-details">
                        <div className="panel-section"><p>{[persona.profile.title, persona.profile.rank, `Portrait #${persona.artId}`]
                          .filter(Boolean).join(" · ")}</p>
                        {persona.profile.workingStyle && <p><strong>Working style:</strong> {persona.profile.workingStyle}</p>}
                        {!!persona.profile.specialties.length &&
                          <p><strong>Specialties:</strong> {persona.profile.specialties.join(", ")}</p>}
                        {profileEditingId === persona.id ? profileEditor(persona) :
                          <button type="button" onClick={() => startProfileEdit(persona)}>Edit profile</button>}
                        </div>
                        {personaNotes(persona)}
                        {personaCareer(persona)}
                        {personaProjects(persona)}
                        <div className="assignment-history panel-section"><h4>Preserved assignments</h4>
                          <ul>{(sdkRoom?.assignments ?? []).filter(assignment => assignment.personaId === persona.id)
                            .sort((a, b) => b.startedAt - a.startedAt).map(assignment =>
                              <li key={assignment.id}><strong>{assignment.outcome || "Assignment"}</strong>
                                <span>{assignment.status} · {new Date(assignment.startedAt).toLocaleString()}</span>
                                <span>Model: {assignment.modelProfile?.model ?? "auto"} · profile {assignment.modelProfileId ?? "copilot"}</span>
                                {assignment.retention && <span>SDK session: {assignment.retention === "keep" ? "retained" : "deleted by request"}</span>}
                                <span>Workspace: <code>{assignment.workspace}</code></span>
                                <span>{assignment.messages.length} messages preserved</span>
                                {assignment.messages.length > 0 && <Disclosure.Root className="assignment-transcript">
                                  <Disclosure.Trigger>Read preserved transcript</Disclosure.Trigger>
                                  <Disclosure.Panel className="ui-disclosure-panel">
                                  {assignment.messages.map(message => <div key={message.id}>
                                    <strong>{message.role}</strong>
                                    <SafeMarkdown content={message.content} />
                                  </div>)}
                                  </Disclosure.Panel>
                                </Disclosure.Root>}
                              </li>)}</ul>
                        </div>
                      </Disclosure.Panel>
                    </Disclosure.Root>)}
                </>}
              </section>
            )}
            {selectedAgent && setupOpen && selectedPersona && (
              <section className="activity-view agent-setup" aria-label={`${selectedPersona.name} profile setup`}>
                <div className="agent-setup-intro panel-section">
                  <span className="overview-group-label">{selectedPersona.setupCompleted === false ? "New hire" : "Profile"}</span>
                  <h3>{selectedPersona.setupCompleted === false ? "Configure this agent" : `Edit ${selectedPersona.name}`}</h3>
                  <p>{selectedPersona.setupCompleted === false ?
                    "Set a working style or instructions before chatting. You can leave and resume setup later; the agent and its files stay here." :
                    "Profile changes are saved for future assignments. Current session context remains as it was."}</p>
                  {selectedAgent.archived && selectedPersona.setupCompleted === false && <p role="status">
                    This agent is archived. Restore it to an open desk before completing setup.
                    <Button type="button" disabled={officeFull}
                      onClick={event => openDeskChoice({ kind: "restore", agentId: selectedAgent.id }, event.currentTarget)}>
                      Restore to office
                    </Button>
                  </p>}
                </div>
                <div className="agent-setup-card panel-section">
                  <h4>Identity & working style</h4>
                  {profileEditor(selectedPersona)}
                </div>
                <div className="agent-setup-card panel-section">
                  <h4>Assign projects</h4>
                  {personaProjects(selectedPersona)}
                </div>
                <Disclosure.Root className="agent-setup-card panel-section">
                  <Disclosure.Trigger className="overview-disclosure">Preview profile instructions</Disclosure.Trigger>
                  <Disclosure.Panel className="ui-disclosure-panel setup-preview-panel">
                    <p>Saved profile instructions apply to this agent's next job or chat. The current chat keeps its existing context.
                      Save your edits before previewing.</p>
                    <Button type="button" disabled={guidanceLoading} onClick={() => void loadGuidance(selectedPersona)}>
                      {guidanceLoading ? "Loading preview…" : "Compare instructions"}</Button>
                    {guidancePreview && <div className="agent-guidance-preview" role="status">
                      <strong>Next job or chat</strong><p>{guidancePreview.next}</p>
                      <strong>Current chat</strong><p>{guidancePreview.current ?? "No snapshot available."}</p>
                    </div>}
                  </Disclosure.Panel>
                </Disclosure.Root>
              </section>
            )}
            {selectedAgent && settingsOpen && !setupOpen && (
              <section className="activity-view agent-settings" aria-label={`${agentName(sdkRoom, selectedAgent)} settings`}>
                  <div className="persona-details">
                    <div className="profile-summary panel-section"><div className="persona-heading">
                      <img src={agentPortrait(agentArt(sdkRoom, selectedAgent))} alt="" width="42" height="42" />
                      <div><h3>{agentName(sdkRoom, selectedAgent)}</h3>
                        {selectedPersona && <span>{[selectedPersona.profile.title, selectedPersona.profile.rank,
                          `Portrait #${selectedPersona.artId}`].filter(Boolean).join(" · ")}</span>}
                      </div>
                    </div>
                    {selectedPersona ? <>
                      {selectedPersona.profile.workingStyle && <p><strong>Working style:</strong> {selectedPersona.profile.workingStyle}</p>}
                      {!!selectedPersona.profile.specialties.length &&
                        <p><strong>Specialties:</strong> {selectedPersona.profile.specialties.join(", ")}</p>}
                    </> : <p>Profile is not available for this agent yet.</p>}
                    <p>{selectedAgent.archived ? `Former home desk ${(selectedAgent.lastDeskIndex ?? 0) + 1}` :
                      `Home desk ${selectedAgent.deskIndex! + 1}`}</p>
                    {selectedAgent.archived ?
                      <Button type="button" disabled={officeFull}
                        onClick={event => openDeskChoice({ kind: "restore", agentId: selectedAgent.id }, event.currentTarget)}>
                        Restore to an empty desk…
                      </Button> :
                      <Button type="button"
                        onClick={event => openDeskChoice({ kind: "move", agentId: selectedAgent.id,
                          deskIndex: selectedAgent.deskIndex! }, event.currentTarget)}>
                        Move desk…
                      </Button>}
                    </div>
                    <Disclosure.Root className="agent-settings-more panel-section">
                      <Disclosure.Trigger>More options · notes, career, projects & assignments</Disclosure.Trigger>
                      <Disclosure.Panel className="ui-disclosure-panel">
                    {selectedPersona && <>
                      {personaNotes(selectedPersona)}
                      {personaCareer(selectedPersona)}
                      {personaProjects(selectedPersona)}
                    </>}
                    <div className="assignment-history panel-section">
                      <h4>Assignment history</h4>
                      {currentAssignment && <p>Current: started {new Date(currentAssignment.startedAt).toLocaleString()}
                        {" · model "}{currentAssignment.modelProfile?.model ?? "auto"}
                        {" ("}{currentAssignment.modelProfileId ?? "copilot"}{")"}
                        {currentAssignment.outcome && <> · {currentAssignment.outcome}</>}</p>}
                      {!previousAssignments.length && <p>No previous assignments.</p>}
                      <ul>{previousAssignments.map(assignment => <li key={assignment.id}>
                        <strong>{assignment.outcome || "Previous assignment"}</strong>
                        <span>{assignment.status} · {new Date(assignment.startedAt).toLocaleString()}
                          {assignment.endedAt && <> – {new Date(assignment.endedAt).toLocaleString()}</>}</span>
                        <span>Model: {assignment.modelProfile?.model ?? "auto"} · profile {assignment.modelProfileId ?? "copilot"}</span>
                        <span>Workspace: <code>{assignment.workspace}</code></span>
                        {assignment.repository && <span>Repository: {assignment.repository.name}</span>}
                        <span>{assignment.messages.length} messages preserved</span>
                        {assignment.messages.length > 0 && <Disclosure.Root className="assignment-transcript">
                          <Disclosure.Trigger>Read preserved transcript</Disclosure.Trigger>
                          <Disclosure.Panel className="ui-disclosure-panel">
                          {assignment.messages.map(message => <div key={message.id}>
                            <strong>{message.role}</strong>
                            <SafeMarkdown content={message.content} />
                          </div>)}
                          </Disclosure.Panel>
                        </Disclosure.Root>}
                      </li>)}</ul>
                      {!selectedAgent.archived && <button type="button" disabled={!canStartAssignment(selectedAgent)}
                        title={!canStartAssignment(selectedAgent) ? "Available only when this agent is idle and no turn or permission is pending" : undefined}
                        onClick={() => {
                          setAssignmentAgentId(selectedAgent.id);
                          setAssignmentOutcome("");
                          setAssignmentModelProfileId(currentAssignment?.modelProfileId ?? "copilot");
                        }}>New assignment…</button>}
                    </div>
                    <p className="settings-search-status panel-section" role="status">{searchCapability}</p>
                      </Disclosure.Panel>
                    </Disclosure.Root>
                  </div>
              </section>
            )}
            {selectedAgent && !setupOpen && !settingsOpen && (
              <section className="activity-view conversation-view" aria-label="SDK conversation">
                  <div className="conversation-messages">
                    {selectedAgent.archived && selectedAgent.messages.length === 0 &&
                      <p className="activity-empty conversation-empty">No messages yet.</p>}
                    {displayedMessages.map(message =>
                      <div className={`conversation-message ${message.role}`} key={message.id}>
                        {message.role === "assistant" && <img className="message-avatar"
                          src={agentPortrait(agentArt(sdkRoom, selectedAgent))} alt="" width="28" height="28" />}
                        <span>{message.role === "user" ? "YOU" : message.role === "system" ? "OFFICE" : agentName(sdkRoom, selectedAgent)}{message.pending ? " · STREAMING" : ""}</span>
                        <div className="message-bubble">
                        <button type="button" className="copy-message" aria-label={`${copiedId === message.id ? "Copied" : "Copy"} ${message.role} message as Markdown`}
                          title={copiedId === message.id ? "Copied" : "Copy Markdown"}
                          onClick={() => void navigator.clipboard.writeText(message.content).then(() => setCopiedId(message.id))
                            .catch(error => setActionError(`Could not copy message: ${error instanceof Error ? error.message : String(error)}`))}>
                          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="7" y="6" width="10" height="11" rx="1.5" />
                            <path d="M13 6V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" /></svg>
                        </button>
                        <div className="message-markdown"><SafeMarkdown content={message.content} /></div>
                        </div>
                        {copiedId === message.id && <span className="sr-only" role="status">Message copied</span>}
                      </div>)}
                    {!selectedAgent.accessRequest && !selectedAgent.review &&
                      ["thinking", "working"].includes(selectedAgent.phase) &&
                      !displayedMessages.some(message => message.pending && message.role === "assistant") &&
                      <div className="conversation-thinking" role="status" aria-live="polite">
                        <span className="thinking-mark" aria-hidden="true"><i /><i /><i /></span>
                        <span>{agentName(sdkRoom, selectedAgent)} is thinking</span>
                      </div>}
                    {selectedAgent.accessRequest && <div className="conversation-message assistant access-message">
                      <img className="message-avatar" src={agentPortrait(agentArt(sdkRoom, selectedAgent))}
                        alt="" width="28" height="28" />
                      <span>{selectedActor?.name}</span>
                      <div className="message-bubble">
                        <section className="access-card" role="group"
                          aria-label={`Repository access request from ${selectedActor?.name ?? "agent"}`}>
                          <p className="access-question">Can I {selectedAgent.accessRequest.scope === "edit" ? "edit" : "read"}{" "}
                            <strong>{chosenRepository?.fullName || selectedAgent.accessRequest.repoHint || "a GitHub repository"}</strong>?</p>
                          <p className="access-purpose">{selectedAgent.accessRequest.purpose}</p>
                          {chosenRepository && <p className="access-source">
                            GitHub · {chosenRepository.privacy} · {chosenRepository.defaultBranch}
                          </p>}
                          {candidates.length > 1 && <div className="access-picker">
                            <SelectField id="access-candidate" label="Which repository?"
                              value={selectedRepository} onValueChange={setSelectedRepository}
                              options={[{ value: "", label: "Select owner/repo…" },
                                ...candidates.map(item => ({
                                  value: item.fullName, label: `${item.fullName} · ${item.privacy}`,
                                }))]} />
                          </div>}
                          {(editingRepoHint || selectedAgent.accessRequest.status === "error") && <form
                            className="access-lookup" onSubmit={event => {
                              event.preventDefault();
                              void act("access-lookup", { agentId: selectedAgent.id,
                                id: selectedAgent.accessRequest!.id, hint: repoHint.trim() }).then(ok => {
                                  if (ok) setEditingRepoHint(false);
                                });
                            }}>
                            <label className="sr-only" htmlFor="repo-hint">GitHub repository name or owner/repo</label>
                            <input id="repo-hint" type="text" value={repoHint} onChange={event => setRepoHint(event.target.value)}
                              placeholder="owner/repo" maxLength={150} disabled={selectedAgent.accessRequest.status === "cloning"} />
                            <button type="submit" disabled={!repoHint.trim() ||
                              ["resolving", "cloning"].includes(selectedAgent.accessRequest.status ?? "")}>Look up</button>
                          </form>}
                          {chosenRepository && !selectedAgent.accessRequest.configuredProject && !editingRepoHint && selectedAgent.accessRequest.status !== "cloning" &&
                            <button type="button" className="access-change"
                              onClick={() => setEditingRepoHint(true)}>Wrong repo?</button>}
                          {["resolving", "cloning"].includes(selectedAgent.accessRequest.status ?? "") &&
                            <small role="status">{selectedAgent.accessRequest.progress}</small>}
                          {selectedAgent.accessRequest.error && <small className="access-error" role="alert">
                            {selectedAgent.accessRequest.error}</small>}
                          <div className="access-actions">
                            <button type="button" disabled={selectedAgent.accessRequest.status === "cloning"}
                              onClick={() => void act("access-decision", {
                                agentId: selectedAgent.id, id: selectedAgent.accessRequest!.id, choice: "deny" })}>Deny</button>
                            {([...(selectedAgent.accessRequest.scope === "read" ?
                              [["persona", "Read for persona (default)", "Grant read access to this persona"]] : []),
                              ...(!selectedAgent.accessRequest.configuredProject ?
                                [["task", "Read this task", "Read for this task"],
                                  ["session", "Read this session", "Read for this agent session"]] : []),
                              ...(selectedAgent.accessRequest.scope === "read" ?
                                [["office", "Read for office", "Add verified repository to office catalog and share read access"]] : []),
                              ...(selectedAgent.accessRequest.scope === "edit" ?
                                [["edit", "Edit worktree", "Edit in isolated worktree"]] : [])] as const)
                              .map(([choice, label, accessible]) => <button key={choice} type="button"
                                aria-label={accessible}
                                disabled={!chosenRepository || editingRepoHint || selectedAgent.accessRequest?.status !== "review" ||
                                  chosenRepository.sizeKiB > 100_000}
                                onClick={() => void act("access-decision", { agentId: selectedAgent.id,
                                  id: selectedAgent.accessRequest!.id, choice, repository: chosenRepository!.fullName,
                                  fresh: freshSnapshot })}>{label}</button>)}
                          </div>
                          {chosenRepository && chosenRepository.sizeKiB > 100_000 &&
                            <small className="access-error">Repository too large to clone (100 MB limit).</small>}
                          {chosenRepository && <Disclosure.Root className="access-details">
                            <Disclosure.Trigger>Access details</Disclosure.Trigger>
                            <Disclosure.Panel className="ui-disclosure-panel">
                            <span>{chosenRepository.url} · {chosenRepository.sizeKiB.toLocaleString()} KiB</span>
                            <span>{cachedSnapshot ? `Cached ${new Date(cachedSnapshot.fetchedAt).toLocaleString()}; reused for up to 6 hours.` :
                              "A shallow clone starts only after approval."} Remote snapshots exclude local unpushed changes.</span>
                            {cachedSnapshot && <div className="ui-toggle-row">
                              <Toggle label="Fetch fresh snapshot" checked={freshSnapshot}
                                disabled={selectedAgent.accessRequest.status === "cloning"}
                                onCheckedChange={setFreshSnapshot} /><span>Fetch fresh snapshot</span>
                            </div>}
                            <span>Task and session grants apply only to this agent. Persona read survives assignments;
                              office read is shared with all personas except those excluded in their inspector.
                              A request expires after 90 seconds; grants do not.
                              Reads are guarded; shell/writes need separate approval by default. Worktrees are not sandboxes.</span>
                            </Disclosure.Panel>
                          </Disclosure.Root>}
                        </section>
                      </div>
                    </div>}
                  </div>
              </section>
            )}
          </div>
          {selectedAgent?.review && !selectedAgent.archived && <div className="permission-card" role="alertdialog"
            aria-label={`Tool permission request for ${selectedActor?.name ?? "agent"}`}>
            <strong>{selectedActor?.name} · permission needed · {selectedAgent.review.kind}</strong>
            <span>Review the complete request before allowing this tool once.</span>
            <pre>{selectedAgent.review.detail}</pre>
            <div className="permission-buttons">
              <button type="button" onClick={() => void act("decision", { agentId: selectedAgent.id, id: selectedAgent.review!.id, allow: false })}>Deny</button>
              <button type="button" onClick={() => void act("decision", { agentId: selectedAgent.id, id: selectedAgent.review!.id, allow: true })}>Allow once</button>
            </div>
            <small>Expires in 90 seconds. Worktrees are not OS sandboxes; inspect paths and commands before allowing once.</small>
          </div>}
          {selectedAgent && !selectedAgent.archived && !setupOpen &&
            selectedAgent.repository?.worktree && selectedAgent.repository.configuredProject && currentAssignment &&
            <section className="trusted-local-card panel-section" aria-label="Task tool approval mode">
              <strong>{selectedAgent.trustedLocal ? "Trusted-local autonomy active" : "Manual tool approval (default)"}</strong>
              <p>This agent can run commands as your account; it may read/change files or credentials outside this repo. Not sandboxed.</p>
              <p>{selectedAgent.trustedLocal ? "Routine built-in tools run without individual prompts for this agent and assignment until you turn this off, change assignments or worktrees, or restart the server. Managed requests and other tools follow existing review policy." :
                "Manual mode asks before built-in tools. Worktree eligibility does not confine commands."}</p>
              <button type="button" disabled={!connected || !selectedAgent.trustedLocal &&
                (selectedAgent.phase !== "idle" || !!selectedAgent.review || !!selectedAgent.accessRequest)}
                onClick={() => void act("trusted-local", { agentId: selectedAgent.id,
                  assignmentId: currentAssignment.id, enabled: !selectedAgent.trustedLocal })}>
                {selectedAgent.trustedLocal ? "Turn off autonomous local work" : "Allow autonomous local work for this task"}
              </button>
            </section>}
          {selectedAgent?.archived && <p className="archived-chat-notice">Archived · open Agents to restore this agent before sending a message.</p>}
          {selectedAgent?.phase === "error" && !selectedAgent.archived && <button type="button" className="focus-button" onClick={() => void act("retry", {})}>Retry agent connection</button>}
          {selectedAgent && !setupOpen && !settingsOpen && !selectedAgent.archived && <form className="conversation-composer" onSubmit={event => {
            event.preventDefault();
            if (!draft.trim()) return;
            const prompt = draft;
            setDraft("");
            void act("send", { agentId: selectedAgent.id, prompt }).then(ok => { if (!ok) setDraft(prompt); });
          }}>
            <label htmlFor="chat-prompt">MESSAGE {selectedActor?.name.toUpperCase() ?? "YOUR AGENT"}</label>
            <div><textarea id="chat-prompt" value={draft} onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }} rows={2} maxLength={12000} placeholder="Ask something, or start a task…"
              disabled={!connected || ["thinking", "working", "permission", "error"].includes(selectedAgent.phase)} />
              {["thinking", "working", "permission"].includes(selectedAgent.phase) && <button type="button" className="stop-turn"
                aria-label="Stop agent response" onClick={() => void act("stop", { agentId: selectedAgent.id })}>Stop</button>}
              <button type="submit" disabled={!connected || !draft.trim() || ["thinking", "working", "permission", "error"].includes(selectedAgent.phase)} aria-label="Send message">↗</button>
            </div>
            <small>Enter to send · Shift+Enter for a new line</small>
          </form>}
        </aside>
      </div>
      {outcomeTarget && <div className="send-home-backdrop">
        <form className="send-home-dialog outcome-dialog" role="dialog" aria-modal="true"
          aria-labelledby="outcome-heading" onSubmit={event => {
            event.preventDefault();
            const isPr = outcomeTarget.source === "merged-pr";
            void act(isPr ? "pr-confirm" : "outcome-confirm", { ...(isPr ?
              { assignmentId: outcomeTarget.sourceId, personaId: outcomeTarget.personaId, number: Number(prNumber) } :
              outcomeTarget), evidence: outcomeEvidence,
              specialty: outcomeSpecialty, confirmed: outcomeConfirmed }).then(ok => {
              if (ok) setOutcomeTarget(null);
            });
          }}>
          <h3 id="outcome-heading">Confirm completed {outcomeTarget.source} outcome</h3>
          <p>Source: <code>{outcomeTarget.sourceId}</code>. Check the preserved transcript/review first.
            This awards {outcomeTarget.source === "review" ? "10 XP and 4" :
              outcomeTarget.source === "merged-pr" ? "30 XP and 12" : "20 XP and 8"} office credits once.</p>
          {outcomeTarget.source === "merged-pr" && <label>Pull request number in the assignment repository
            <input type="number" min="1" step="1" required value={prNumber}
              onChange={event => setPrNumber(event.target.value)} /></label>}
          <label>Outcome evidence in your words (10–500 characters)
            <textarea required minLength={10} maxLength={500} value={outcomeEvidence}
              onChange={event => setOutcomeEvidence(event.target.value)} rows={3} /></label>
          <SelectField label="Specialty" value={outcomeSpecialty} onValueChange={setOutcomeSpecialty}
            options={SPECIALTIES.map(item => ({ value: item, label: item }))} />
          <label><input type="checkbox" checked={outcomeConfirmed}
            onChange={event => setOutcomeConfirmed(event.target.checked)} />
            I reviewed the recorded work and confirm this outcome belongs to this persona and assignment.</label>
          <div className="persona-actions">
            <button type="button" onClick={() => setOutcomeTarget(null)}>Cancel</button>
            <button type="submit" disabled={!outcomeConfirmed || outcomeEvidence.trim().length < 10 ||
              outcomeTarget.source === "merged-pr" && (!Number.isSafeInteger(Number(prNumber)) || Number(prNumber) < 1)}>
              {outcomeTarget.source === "merged-pr" ? "Verify on GitHub and record" : "Record once"}</button>
          </div>
        </form>
      </div>}
      {assignmentAgent && <div className="send-home-backdrop">
        <div className="send-home-dialog" role="dialog" aria-modal="true"
          aria-labelledby="assignment-heading" aria-describedby="assignment-description"
          onKeyDown={event => {
            if (event.key !== "Tab") return;
            const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)"));
            if (event.shiftKey && document.activeElement === focusable[0]) {
              event.preventDefault();
              focusable.at(-1)?.focus();
            } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
              event.preventDefault();
              focusable[0]?.focus();
            }
          }}>
          <h2 id="assignment-heading">New assignment for {agentName(sdkRoom, assignmentAgent)}</h2>
          <p id="assignment-description">This starts a fresh SDK session. The previous assignment, its messages,
            and working files remain preserved. Repository permissions do not carry over; grant access again if needed.</p>
          <label className="assignment-outcome">Outcome of previous assignment (optional)
            <input autoFocus maxLength={240} value={assignmentOutcome}
              onChange={event => setAssignmentOutcome(event.target.value)} placeholder="What did the previous assignment accomplish?" />
          </label>
          <SelectField label="Model profile for new SDK session"
            value={assignmentModelProfileId || sdkRoom?.assignments?.find(item => item.id === assignmentAgent.assignmentId)?.modelProfileId || "copilot"}
            onValueChange={setAssignmentModelProfileId}
            options={(sdkRoom?.modelProfiles ?? []).map(profile => ({
              value: profile.id, label: `${profile.id} · ${profile.kind} / ${profile.model}`,
            }))} />
          <div className="send-home-buttons">
            <button type="button" disabled={assignmentSubmitting} onClick={() => setAssignmentAgentId(null)}>Cancel</button>
            <button type="button" disabled={!canStartAssignment(assignmentAgent) || assignmentSubmitting}
              onClick={() => void newAssignment()}>{assignmentSubmitting ? "Starting…" : "Start new assignment"}</button>
          </div>
        </div>
      </div>}
      {confirmAgent && <div className="send-home-backdrop">
        <div className="send-home-dialog" role="alertdialog" aria-modal="true"
          aria-labelledby="send-home-heading" aria-describedby="send-home-description"
          onKeyDown={event => {
            if (event.key !== "Tab") return;
            const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)"));
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }}>
          <h2 id="send-home-heading">Fire {confirmName}?</h2>
          <p id="send-home-description">Remove this agent from the office and its active assignment.
            Choose what happens to the SDK session. Your working files and Git worktrees are never deleted.</p>
          <p>Working files remain at <code>{confirmAgent.workspace}</code>.</p>
          {(sdkRoom?.worktrees ?? []).filter(tree => tree.agentId === confirmAgent.id).map(tree =>
            <p key={tree.path}>The Git worktree and branch <code>{tree.branch}</code> stay at <code>{tree.path}</code>.</p>)}
          <fieldset className="retention-choices"><legend>SDK history retention</legend>
            <label><input type="radio" name="retention" value="keep" checked={retention === "keep"}
              disabled={confirmSubmitting} onChange={() => setRetention("keep")} />
              Keep SDK session and all history (default)</label>
            <label><input type="radio" name="retention" value="delete-sdk" checked={retention === "delete-sdk"}
              disabled={confirmSubmitting} onChange={() => setRetention("delete-sdk")} />
              Delete SDK session only; working files remain untouched</label>
          </fieldset>
          <label className="assignment-outcome">Type <strong>{confirmName}</strong> or agent ID <code>{confirmAgent.id}</code> to confirm
            <input ref={confirmCheckboxRef} type="text" autoComplete="off" value={confirmIdentity}
              disabled={confirmSubmitting} onChange={event => setConfirmIdentity(event.target.value)} />
          </label>
          {confirmError && <p className="send-home-error" role="alert">{confirmError}</p>}
          <div className="send-home-buttons">
            <button type="button" disabled={confirmSubmitting} onClick={closeConfirmation}>Cancel</button>
            <button type="button" className="send-home-confirm"
              disabled={confirmSubmitting || (confirmIdentity.trim() !== confirmName && confirmIdentity.trim() !== confirmAgent.id)}
              onClick={() => void confirmSendHome()}>{confirmSubmitting ? "Firing…" : "Fire agent"}</button>
          </div>
        </div>
      </div>}
      {deskChoice && <div className="send-home-backdrop">
        <div ref={deskDialogRef} className="send-home-dialog desk-choice-dialog" role="dialog" aria-modal="true"
          aria-labelledby="desk-choice-heading" aria-describedby="desk-choice-description"
          onKeyDown={event => {
            if (event.key !== "Tab") return;
            const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }}>
          <h2 id="desk-choice-heading">{deskChoice.kind === "create" ? "Choose a desk for the new agent" :
            deskChoice.kind === "restore" ? `Restore ${agentName(sdkRoom, sdkRoom?.agents.find(item => item.id === deskChoice.agentId))}` :
              `Move ${agentName(sdkRoom, sdkRoom?.agents.find(item => item.id === deskChoice.agentId))}`}</h2>
          <p id="desk-choice-description">{deskChoice.kind === "move"
            ? "Choose an empty desk to move, or an occupied desk to swap home desks. Conversations and work keep running."
            : deskChoice.kind === "restore"
              ? "Choose an empty desk. The former desk is marked when available; occupied desks cannot be restored into."
              : "Pick an empty desk. Nearby desks make a handy visual group; there are no team permissions."}</p>
          <div className="desk-choice-grid" aria-label="Office desks">
            {Array.from({ length: MAX_AGENTS }, (_, index) => {
              const occupant = activeAgents.find(item => item.deskIndex === index);
              const self = deskChoice.kind !== "create" && occupant?.id === deskChoice.agentId;
              const former = deskChoice.kind === "restore" &&
                sdkRoom?.agents.find(item => item.id === deskChoice.agentId)?.lastDeskIndex === index;
              return <button type="button" key={index}
                disabled={deskBusy || !!self || (deskChoice.kind !== "move" && !!occupant)}
                aria-label={`Desk ${index + 1}: ${self ? "current desk" : occupant ?
                  `occupied by ${agentName(sdkRoom, occupant)}` : "empty"}${former ? ", former desk" : ""}`}
                onClick={() => {
                  setDeskTarget(null);
                  if (deskChoice.kind === "move" && occupant) setDeskTarget({ index, occupantId: occupant.id });
                  else void chooseDesk(index, null);
                }}>
                <strong>{index + 1}</strong>
                <span>{self ? "Current" : occupant ? agentName(sdkRoom, occupant) : former ? "Former · empty" : "Empty"}</span>
              </button>;
            })}
          </div>
          {deskTarget && deskChoice.kind === "move" && <div className="desk-swap-preview" role="status">
            <p>Swap {agentName(sdkRoom, sdkRoom?.agents.find(item => item.id === deskChoice.agentId))}
              {" "}at desk {deskChoice.deskIndex + 1}
              {" "}with {agentName(sdkRoom, activeAgents.find(item => item.id === deskTarget.occupantId))}
              {" "}at desk {deskTarget.index + 1}?</p>
            <button type="button" disabled={deskBusy} onClick={() => setDeskTarget(null)}>Cancel swap</button>
            <button type="button" disabled={deskBusy || activeAgents.find(item => item.deskIndex === deskTarget.index)?.id !== deskTarget.occupantId}
              onClick={() => void chooseDesk(deskTarget.index, deskTarget.occupantId)}>Confirm swap</button>
          </div>}
          {actionError && <p className="send-home-error" role="alert">{actionError}</p>}
          <div className="send-home-buttons">
            <button type="button" disabled={deskBusy} onClick={() => closeDeskChoice()}>Cancel</button>
          </div>
        </div>
      </div>}
      {actionError && (
        <div className="storage-error" role="status">
          <span>{actionError}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setActionError("")}>×</button>
        </div>
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("HappyMachines office root is missing");
createRoot(root).render(<LiveOffice />);
