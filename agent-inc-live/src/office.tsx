import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../agent-inc/app/styles.css";
import "../live.css";
import "../sdk-chat.css";
import { MAX_AGENTS, type Agent as SdkAgent, type Room as SdkRoom } from "../../server/types";
import {
  COFFEE_SPOTS, DESKS, initialProgress, Simulation,
} from "../../agent-inc/game/simulation";
import type { Agent, Request } from "../../agent-inc/game/simulation";
import { sampleDaylight } from "../../agent-inc/game/lighting";
import {
  EXTRA_DESKS, LIVE_COFFEE_Z, MAX_LIVE_DESKS, MIN_LIVE_DESKS,
  assignLoungeSpots, routeAroundDividers,
} from "../../agent-inc/game/live-layout";
import { AGENTCORP_LETTERS, AGENTCORP_MARK, AGENTCORP_WORDMARK, agentPortrait } from "../../agent-inc/game/sprite-art";
import { createWorld } from "../../agent-inc/game/world";
import { noticeActivityForActor, roomActors } from "./room";
import type { Actor, Room as OfficeRoom, Status } from "./room";
import { SafeMarkdown } from "./markdown";

const LIVE_DESKS = [...DESKS, ...EXTRA_DESKS];
const LIVE_COFFEE_SPOTS = COFFEE_SPOTS.map(({ x }) => ({ x, z: LIVE_COFFEE_Z + 0.75 }));
const STEP = 1 / 30;
const connectedStatus = "Live local Copilot SDK office";
const themeKey = "agentcorp-harness-theme";
function isActive(agent: SdkAgent): agent is SdkAgent & { deskIndex: number } {
  return !agent.archived && agent.deskIndex !== null;
}
const wordmarkPaths = [...AGENTCORP_WORDMARK].map((letter, index) =>
  AGENTCORP_LETTERS[letter].flatMap((row, y) =>
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

function deskActors(room: SdkRoom): (Actor | null)[] {
  const names = new Map(room.agents.map(agent => [agent.sessionId, agent.name]));
  const bySession = new Map(roomActors(officeRoom(room)).map(actor => [actor.key, {
    ...actor, name: names.get(actor.key) ?? actor.name
  }]));
  const active = room.agents.filter(isActive);
  const slots: (Actor | null)[] = Array.from({ length: Math.max(0, ...active.map(agent => agent.deskIndex + 1)) }, () => null);
  for (const agent of active) slots[agent.deskIndex] = bySession.get(agent.sessionId) ?? null;
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

function applyRoom(scene: Simulation, actors: (Actor | null)[], occupied: boolean[]) {
  const shown = actors.slice(0, MAX_LIVE_DESKS);
  while (scene.agents.length < shown.length) scene.agents.push(makeAgent(scene.agents.length));
  scene.agents.length = Math.max(MIN_LIVE_DESKS, shown.length);
  scene.progress.capacity = shown.length;
  scene.requests = [];
  const loungeSpots = assignLoungeSpots(shown.slice(MIN_LIVE_DESKS).map((actor) =>
    actor?.status === "idle" || actor?.status === "offline"));
  shown.forEach((actor, id) => {
    const agent = scene.agents[id];
    if (!actor) {
      occupied[id] = false;
      agent.x = agent.z = 100;
      agent.target = { x: 100, z: 100 };
      agent.route = [];
      agent.taskId = undefined;
      agent.state = "idle";
      return;
    }
    const busy = actor.status !== "idle" && actor.status !== "offline";
    const destination = busy ? LIVE_DESKS[id] :
      id < MIN_LIVE_DESKS ? LIVE_COFFEE_SPOTS[id] : loungeSpots[id - MIN_LIVE_DESKS];
    if (!destination) throw new Error(`Missing idle destination for worker ${id}`);
    if (!occupied[id]) {
      agent.x = destination.x;
      agent.z = destination.z;
    }
    occupied[id] = true;
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
  }
  occupied.length = scene.agents.length;
}

function updatePersonas(world: ReturnType<typeof createWorld> | undefined, room: SdkRoom): void {
  if (!world) return;
  for (const agent of room.agents) {
    if (isActive(agent) && agent.persona !== undefined) world.setAgentPersona(agent.deskIndex, agent.persona);
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
  const [tab, setTab] = useState<"office" | "agents">("office");
  const [previewOffset, setPreviewOffset] = useState(0);
  const [selected, setSelected] = useState("");
  const [hover, setHover] = useState<{ name: string; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [repoHint, setRepoHint] = useState("");
  const [selectedRepository, setSelectedRepository] = useState("");
  const [freshSnapshot, setFreshSnapshot] = useState(false);
  const [copiedId, setCopiedId] = useState("");
  const [actionError, setActionError] = useState("");
  const [menuAgentId, setMenuAgentId] = useState<string | null>(null);
  const [confirmAgentId, setConfirmAgentId] = useState<string | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);
  const [themePreference, setThemePreference] = useState<"system" | "light" | "dark">(() => {
    const saved = localStorage.getItem(themeKey);
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const host = useRef<HTMLDivElement>(null);
  const activityToggle = useRef<HTMLButtonElement>(null);
  const activityClose = useRef<HTMLButtonElement>(null);
  const sceneRef = useRef<Simulation | null>(null);
  const worldRef = useRef<ReturnType<typeof createWorld> | null>(null);
  const actorsRef = useRef<(Actor | null)[]>([]);
  const hoverDeskRef = useRef<number | null>(null);
  const hoverLabelRef = useRef<HTMLDivElement>(null);
  const confirmCheckboxRef = useRef<HTMLInputElement>(null);
  const confirmTriggerRef = useRef<HTMLButtonElement>(null);
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

  useLayoutEffect(() => { document.documentElement.dataset.officeTheme = darkTheme ? "dark" : "light"; }, [darkTheme]);
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
    setSdkRoom(next);
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

  const clearSelection = () => {
    selectedRef.current = "";
    focusedKey.current = ":-1";
    setSelected("");
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
  const closeActivity = () => {
    unfocusActor();
    returnFocus.current = true;
    setPanelOpen(false);
    setMenuAgentId(null);
  };
  const closeConfirmation = () => {
    setConfirmAgentId(null);
    setConfirmChecked(false);
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
    setPanelOpen(true);
    setTab("agents");
    setMenuAgentId(null);
  };

  useEffect(() => {
    const focusTimer = window.setTimeout(() => {
      if (panelOpen) {
        activityClose.current?.focus();
      } else if (returnFocus.current) {
        returnFocus.current = false;
        activityToggle.current?.focus();
      }
    }, 50);
    if (!panelOpen) return () => window.clearTimeout(focusTimer);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (confirmAgentId) {
          if (!confirmSubmitting) closeConfirmation();
        } else if (menuAgentId) setMenuAgentId(null);
        else if (selectedRef.current) backToActivity();
        else closeActivity();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [panelOpen, selected, menuAgentId, confirmAgentId, confirmSubmitting]);

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

  useLayoutEffect(() => {
    if (!panelOpen || !selected) return;
    followTail.current = true;
    const scroll = chatScroll.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [selected, panelOpen]);

  useLayoutEffect(() => {
    const scroll = chatScroll.current;
    if (scroll && selected && followTail.current) scroll.scrollTop = scroll.scrollHeight;
  }, [sdkRoom?.revision, selected]);

  useEffect(() => {
    if (!host.current) return;
    const scene = makeScene();
    sceneRef.current = scene;
    const occupied = Array(MIN_LIVE_DESKS).fill(false) as boolean[];
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
        const nextActors = deskActors(update);
        actorsRef.current = nextActors;
        world?.capturePositions();
        applyRoom(scene, nextActors, occupied);
        updatePersonas(world, update);
        updateRoom(update);
        setConnection(update.connected ? connectedStatus : update.error || "SDK connection unavailable");
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
        actorsRef.current = deskActors(initial);
        world?.capturePositions();
        applyRoom(scene, actorsRef.current, occupied);
        updatePersonas(world, initial);
        updateRoom(initial);
        setConnection(initial.connected ? connectedStatus : initial.error || "SDK connection unavailable");
      }
    }).catch(error => setConnection(`Cannot reach local SDK office: ${error instanceof Error ? error.message : String(error)}`));
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

  const names = new Map(sdkRoom?.agents.map(agent => [agent.sessionId, agent.name]) ?? []);
  const actors = roomActors(room).map(actor => ({ ...actor, name: names.get(actor.key) ?? actor.name }));
  const activeAgents = sdkRoom?.agents.filter(isActive) ?? [];
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
  useEffect(() => {
    setCopiedId("");
  }, [selected]);
  useEffect(() => {
    setRepoHint(selectedAgent?.accessRequest?.repoHint ?? "");
    setSelectedRepository("");
    setFreshSnapshot(false);
  }, [selectedAgent?.accessRequest?.id]);
  const candidates = selectedAgent?.accessRequest?.candidates ?? [];
  const chosenRepository = candidates.find(item => item.fullName === selectedRepository) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  const cachedSnapshot = sdkRoom?.snapshots?.find(item => item.fullName === chosenRepository?.fullName &&
    item.ref === chosenRepository.defaultBranch);
  const selectedActor = actors.find(actor => actor.key === selected);
  const confirmAgent = sdkRoom?.agents.find(agent => agent.id === confirmAgentId);
  const confirmName = actors.find(actor => actor.key === confirmAgent?.sessionId)?.name ?? "this agent";
  const lifecycleBusy = (agent: SdkAgent) =>
    !!agent.review || !!agent.accessRequest || ["thinking", "working", "permission"].includes(agent.phase);
  const archiveAgent = async (agent: SdkAgent) => {
    setMenuAgentId(null);
    if (await act("archive", { agentId: agent.id })) {
      closeActivity();
      setTab("agents");
    }
  };
  const restoreAgent = async (agent: SdkAgent) => {
    setMenuAgentId(null);
    await act("restore", { agentId: agent.id });
  };
  const confirmSendHome = async () => {
    if (!confirmAgent || !confirmChecked || confirmSubmitting) return;
    setConfirmSubmitting(true);
    try {
      setConfirmError("");
      setActionError("");
      updateRoom(await post("send-home", { agentId: confirmAgent.id, confirmedAgentId: confirmAgent.id }));
      setConfirmAgentId(null);
      setConfirmChecked(false);
      closeActivity();
      setTab("agents");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConfirmError(`SDK deletion failed; this agent and its conversation remain recorded. ${message}`);
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
      <header className="topbar">
        <div className="identity">
          <span className="brand-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" shapeRendering="crispEdges" focusable="false">
              {AGENTCORP_MARK.flatMap(({ color, rects }, layer) =>
                rects.map(([x, y, width, height], index) =>
                  <rect key={`${layer}-${index}`} x={x} y={y} width={width} height={height} fill={color} />))}
            </svg>
          </span>
          <svg className="brand-wordmark" viewBox={`0 0 ${AGENTCORP_WORDMARK.length * 6 - 1} 7`}
            role="img" aria-label="agentcorp"
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
            aria-label={officeFull ? `Office full (${MAX_AGENTS} desks)` : "Add agent"}
            title={officeFull ? `All ${MAX_AGENTS} office desks are occupied` : "Create an independent SDK agent"}
            onClick={() => firstEmptyDesk !== undefined && void act("create", { deskIndex: firstEmptyDesk })}>
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
                  onClick={() => void act("create", { deskIndex })}>+</button>)}
            {activeAgents.map(agent => {
              const actor = actors.find(item => item.key === agent.sessionId);
              return <button key={agent.id} type="button" className="keyboard-agent-target"
                data-agent-desk={agent.deskIndex}
                aria-label={`Chat with ${actor?.name ?? "agent"} at desk ${agent.deskIndex + 1}`}
                onFocus={() => {
                  const point = worldRef.current?.projectAgent(agent.deskIndex);
                  hoverDeskRef.current = agent.deskIndex;
                  if (point && actor) setHover({ name: actor.name, ...point });
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
            </div>
          </div>
        </section>
        <aside id="system-panel" className={`sidebar activity-panel ${panelOpen ? "sidebar-open" : ""} ${selectedAgent ? "chat-open" : ""}`}
          aria-label={selectedAgent ? `${selectedActor?.name ?? "Agent"} conversation` : "Activity"}
          aria-hidden={!panelOpen} inert={!panelOpen}>
          <div className="activity-header">
            <div className="activity-title-row">
              {selectedAgent && <button type="button" className="chat-back" onClick={backToActivity}
                aria-label="Back to agents">←</button>}
              <h2>{selectedAgent ? selectedActor?.name : "Activity"}</h2>
              {selectedAgent && <span className={`activity-tag chat-status status-${selectedActor?.status}`}>
                {selectedAgent.archived ? "Archived" : selectedAgent.phase}</span>}
              <button ref={activityClose} type="button" className="sidebar-close" onClick={closeActivity}
                aria-label={selectedAgent ? "Close conversation" : "Close activity"}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
              </button>
            </div>
          </div>
          {!selectedAgent && <nav className="activity-tabs" aria-label="Activity views">
            {([["office", "Overview"], ["agents", "Agents"]] as const).map(([item, label]) => (
              <button key={item} type="button" aria-pressed={tab === item}
                onClick={() => setTab(item)}>{label}</button>
            ))}
          </nav>}
          <div ref={chatScroll} className={`activity-scroll ${selectedAgent ? "conversation-scroll" : "activity-list-scroll"}`}
            onScroll={event => {
              if (!selectedAgent) return;
              const scroll = event.currentTarget;
              followTail.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 70;
            }}>
            {!selectedAgent && tab === "office" && (
              <section className="activity-view overview-list" aria-label="Office overview">
                <div className="activity-row activity-row-first">
                  <div className="activity-row-heading"><strong>Connection</strong>
                    <span className={`activity-tag ${connected ? "activity-tag-live" : "activity-tag-warning"}`}>
                      {connected ? "Connected" : "Needs attention"}</span></div>
                  {!connected && <p>{sdkRoom?.error || connection}</p>}
                  <div className="activity-chips"><span>{working} active</span><span>{idle} idle</span>
                    <span className={blocked ? "attention" : ""}>{blocked} need attention</span></div>
                </div>
                <div className="activity-row">
                  <div className="activity-row-heading"><strong>The office</strong><span className="activity-tag">{deskCount} desks</span></div>
                  <p>Click + above an empty desk (or Add agent) to create a separate SDK session. Click its pixel sprite to open its chat. A prompt to an existing agent does not create another office agent.</p>
                  {officeFull && <p>Office full: all {MAX_AGENTS} desks have independent agents. Existing conversations remain available.</p>}
                </div>
                <div className="activity-row">
                  <div className="activity-row-heading"><strong>Scratch workspace root</strong><span className="activity-tag">Local only</span></div>
                  <p className="workspace-path">{sdkRoom?.workspace || "Loading…"}</p>
                  <p>{sdkRoom?.agents.some(agent => agent.workspaceKind === "root") ?
                    "The existing agent retains this root; new agents use separate disposable subfolders here." :
                    "Each agent uses a separate disposable subfolder here."} Agents request repository access in their own chat. Worktrees do not provide OS isolation; review every shell or write permission.</p>
                </div>
                <div className="activity-row">
                  <div className="activity-row-heading"><strong>SDK usage · all recorded agents</strong>
                    <span className="activity-tag">On demand</span></div>
                  {sdkRoom?.usage ? <p>{sdkRoom.usage.status === "unavailable" ? "Usage unavailable from the SDK." :
                    `${sdkRoom.usage.tokens.toLocaleString()} tokens · ${sdkRoom.usage.calls.toLocaleString()} model calls · ${sdkRoom.usage.filesChanged.toLocaleString()} session-file counts${sdkRoom.usage.status === "partial" ? " (partial)" : ""}.`}
                    {" "}Measured {sdkRoom.usage.measured}/{sdkRoom.usage.total} sessions, active and archived, accumulated since {sdkRoom.usage.startedAt ?? "unknown start"}; refreshed {new Date(sdkRoom.usage.updatedAt).toLocaleString()}{sdkRoom.usage.stale ? " (outdated; refresh for recent work)" : ""}. File counts may overlap across sessions.</p> :
                    <p>Not loaded. Query per-session SDK metrics to see available accumulated usage.</p>}
                  <button type="button" className="focus-button" disabled={!connected} onClick={() => void act("usage", {})}>Refresh SDK usage</button>
                </div>
                {!!sdkRoom?.worktrees?.length && <div className="activity-row">
                  <div className="activity-row-heading"><strong>Preserved worktrees</strong>
                    <span className="activity-tag">{sdkRoom.worktrees.length} created</span></div>
                  <p>Never deleted on revoke, archive or Send home. Inspect or clean up manually with Git after reviewing changes.</p>
                  {sdkRoom.worktrees.map(tree => <p className="workspace-path" key={tree.path}>
                    {tree.branch} · {tree.path}</p>)}
                </div>}
                {!connected && <button type="button" className="focus-button" onClick={() => void act("retry", {})}>Retry SDK connection</button>}
              </section>
            )}
            {!selectedAgent && tab === "agents" && (
              <section className="activity-view conversations-list" aria-label="Agents and conversations">
                {!(sdkRoom?.agents.length) && <p className="activity-empty">No agents yet. Click + above an empty desk to start a conversation.</p>}
                {[...(sdkRoom?.agents ?? [])].sort((a, b) =>
                  Number(a.archived) - Number(b.archived) || b.updatedAt - a.updatedAt ||
                  (a.deskIndex ?? a.lastDeskIndex ?? 0) - (b.deskIndex ?? b.lastDeskIndex ?? 0)).map(agent => {
                  const actor = actors.find(item => item.key === agent.sessionId);
                  const last = agent.messages.at(-1);
                  const name = actor?.name ?? `Desk ${(agent.deskIndex ?? agent.lastDeskIndex ?? 0) + 1}`;
                  return <div className={`conversation-row ${agent.archived ? "agent-archived" : ""}`} key={agent.id}>
                    <button type="button" className="agent-row-main" onClick={() => selectActor(agent.sessionId)}
                      aria-label={`Open ${name}${agent.archived ? " archived" : ""} conversation`}>
                      <span className="worker-avatar" aria-hidden="true">{agent.persona !== undefined &&
                        <img src={agentPortrait(agent.persona)} alt="" width="42" height="42" />}</span>
                      <span className="conversation-row-text">
                        <strong>{name}</strong>
                        <small>{last ? `${last.role === "user" ? "You: " : ""}${last.content.slice(0, 110)}` :
                          "New conversation · say hello"}</small>
                        <small>{agent.archived ? `Archived · former desk ${(agent.lastDeskIndex ?? 0) + 1}` :
                          `Desk ${agent.deskIndex! + 1} · ${agent.activity}`}</small>
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
                        {agent.archived ?
                          <button role="menuitem" type="button" disabled={officeFull}
                            title={officeFull ? "Office full: archive another agent to free a desk" : "Return this agent to an empty desk"}
                            onClick={() => void restoreAgent(agent)}>Restore to office</button> :
                          <button role="menuitem" type="button" disabled={lifecycleBusy(agent)}
                            title={lifecycleBusy(agent) ? "Finish the turn or decide the permission first" : "Free the desk but keep the conversation"}
                            onClick={() => void archiveAgent(agent)}>Archive · keep conversation</button>}
                        <button role="menuitem" type="button" className="agent-menu-danger" disabled={lifecycleBusy(agent)}
                          title={lifecycleBusy(agent) ? "Finish the turn or decide the permission first" : "Delete SDK session and conversation; keep scratch files"}
                          onClick={event => {
                            confirmTriggerRef.current = event.currentTarget.closest("[data-agent-menu]")
                              ?.querySelector<HTMLButtonElement>(".agent-menu-toggle") ?? null;
                            setConfirmAgentId(agent.id);
                            setConfirmChecked(false);
                            setConfirmError("");
                            setMenuAgentId(null);
                          }}>
                          Send home permanently…</button>
                        {lifecycleBusy(agent) && <small>Wait for the turn or decide its permission first.</small>}
                        {agent.archived && officeFull && <small>Office full: archive another agent before restoring.</small>}
                        <div className="agent-menu-workspace">
                          <span>Tool working directory · {agent.repository?.worktree ? "isolated worktree" :
                            agent.workspaceKind === "root" ? "original root" : "scratch"}</span>
                          <code>{agent.repository?.worktree?.path ?? agent.workspace}</code>
                          {agent.repository?.worktree && <small>Branch: {agent.repository.worktree.branch} · preserved on archive/send home</small>}
                          <small>Not an OS sandbox. Review each tool permission.</small>
                        </div>
                      </div>}
                    </div>
                  </div>;
                })}
              </section>
            )}
            {selectedAgent && (
              <section className="activity-view conversation-view" aria-label="SDK conversation">
                  <div className="conversation-messages">
                    {selectedAgent.messages.length === 0 && <p className="activity-empty">
                      {selectedAgent.archived ? "This archived agent has no messages yet." : "Say hello to your new office mate."}</p>}
                    {selectedAgent.messages.map(message =>
                      <div className={`conversation-message ${message.role}`} key={message.id}>
                        <span>{message.role === "user" ? "YOU" : message.role === "system" ? "OFFICE" : selectedActor?.name}{message.pending ? " · STREAMING" : ""}</span>
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
                    {selectedAgent.accessRequest && <section className="permission-card access-card" role="group"
                      aria-label={`Repository access request from ${selectedActor?.name ?? "agent"}`}>
                      <strong>{selectedActor?.name} requests {selectedAgent.accessRequest.scope} access</strong>
                      <span>{selectedAgent.accessRequest.purpose}</span>
                      <small>For this agent only. GitHub metadata is checked to display identity; no clone/fetch occurs before approval.</small>
                      <form onSubmit={event => {
                        event.preventDefault();
                        void act("access-lookup", { agentId: selectedAgent.id, id: selectedAgent.accessRequest!.id, hint: repoHint.trim() });
                      }}>
                        <label htmlFor="repo-hint">GitHub repository name or owner/repo</label>
                        <div className="access-lookup">
                          <input id="repo-hint" type="text" value={repoHint} onChange={event => setRepoHint(event.target.value)}
                            placeholder="owner/repo" maxLength={150} disabled={selectedAgent.accessRequest.status === "cloning"} />
                          <button type="submit" disabled={!repoHint.trim() || ["resolving", "cloning"].includes(selectedAgent.accessRequest.status ?? "")}>Look up</button>
                        </div>
                      </form>
                      {selectedAgent.accessRequest.progress && <small role="status">{selectedAgent.accessRequest.progress}</small>}
                      {selectedAgent.accessRequest.error && <small className="access-error" role="alert">{selectedAgent.accessRequest.error}</small>}
                      {candidates.length > 1 && <label htmlFor="access-candidate">Choose exact repository
                        <select id="access-candidate" value={selectedRepository} onChange={event => setSelectedRepository(event.target.value)}>
                          <option value="">Select owner/repo…</option>
                          {candidates.map(item => <option key={item.fullName} value={item.fullName}>{item.fullName} · {item.privacy}</option>)}
                        </select>
                      </label>}
                      {chosenRepository && <div className="access-identity">
                        <strong>{chosenRepository.fullName}</strong>
                        <span>Source: github.com · {chosenRepository.privacy} · default branch: {chosenRepository.defaultBranch}</span>
                        <span>Clone: {chosenRepository.url} · reported size: {chosenRepository.sizeKiB.toLocaleString()} KiB</span>
                        <span>{cachedSnapshot ?
                          `Cached ${new Date(cachedSnapshot.fetchedAt).toLocaleString()} at ${cachedSnapshot.commit.slice(0, 12)}. Reused for up to 6 hours; older snapshots are freshly cloned.` :
                          "Approval starts a new shallow clone of the remote default branch."}
                          {" "}Local unpushed commits or working changes in another checkout are not included.</span>
                        {cachedSnapshot && <label><input type="checkbox" checked={freshSnapshot}
                          disabled={selectedAgent.accessRequest.status === "cloning"}
                          onChange={event => setFreshSnapshot(event.target.checked)} /> Fetch fresh snapshot on approval</label>}
                      </div>}
                      <div className="permission-buttons access-actions">
                        <button type="button" disabled={selectedAgent.accessRequest.status === "cloning"}
                          onClick={() => void act("access-decision", {
                            agentId: selectedAgent.id, id: selectedAgent.accessRequest!.id, choice: "deny" })}>Deny</button>
                        {([["task", "Read for this task"], ["session", "Read for this agent session"],
                          ...(selectedAgent.accessRequest.scope === "edit" ? [["edit", "Edit in isolated worktree"]] : [])] as const)
                          .map(([choice, label]) => <button key={choice} type="button"
                            disabled={!chosenRepository || selectedAgent.accessRequest?.status !== "review" ||
                              chosenRepository.sizeKiB > 100_000}
                            onClick={() => void act("access-decision", { agentId: selectedAgent.id,
                              id: selectedAgent.accessRequest!.id, choice, repository: chosenRepository!.fullName,
                              fresh: freshSnapshot })}>{label}</button>)}
                      </div>
                      {chosenRepository && chosenRepository.sizeKiB > 100_000 &&
                        <small className="access-error">Repository exceeds the 100 MB clone limit; no clone will be attempted.</small>}
                      <small>90 seconds is the pending decision timeout, not a grant lifetime. Read uses bounded tracked text only; worktrees are not OS sandboxes. Every shell/write still requires separate approval.</small>
                    </section>}
                    {!selectedAgent.repository && !selectedAgent.accessRequest && !selectedAgent.archived &&
                      <div className="guided-repo">
                        <span>Need a repository? Ask this agent to request it here. If it only reports one unavailable,</span>
                        <button type="button" disabled={lifecycleBusy(selectedAgent)}
                          onClick={() => void act("access-request", { agentId: selectedAgent.id })}>
                          find a GitHub repository…</button>
                      </div>}
                  </div>
              </section>
            )}
          </div>
          {selectedAgent?.repository && <section className="repo-attachment" aria-label={`Repository access for ${selectedActor?.name ?? "agent"}`}>
            <div className="repo-grant">
              <strong>{selectedAgent.repository.name} · {selectedAgent.repository.worktree ? "isolated worktree edit" :
                selectedAgent.repository.scope === "task" ? "read this task" : "read this session"}</strong>
              <code>{selectedAgent.repository.path}</code>
              {selectedAgent.repository.remote && <code>GitHub snapshot: {selectedAgent.repository.remote.ref} @ {selectedAgent.repository.remote.commit.slice(0, 12)}
                {" · "}{new Date(selectedAgent.repository.remote.fetchedAt).toLocaleString()}</code>}
              {selectedAgent.repository.worktree && <code>Worktree: {selectedAgent.repository.worktree.path} · {selectedAgent.repository.worktree.branch}</code>}
              <button type="button" disabled={lifecycleBusy(selectedAgent)}
                onClick={() => void act("access-revoke", { agentId: selectedAgent.id })}>Revoke access</button>
            </div>
          </section>}
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
          {selectedAgent?.archived && <p className="archived-chat-notice">Archived · open Agents to restore this agent before sending a message.</p>}
          {selectedAgent?.phase === "error" && !selectedAgent.archived && <button type="button" className="focus-button" onClick={() => void act("retry", {})}>Retry agent connection</button>}
          {selectedAgent && !selectedAgent.archived && <form className="conversation-composer" onSubmit={event => {
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
          <h2 id="send-home-heading">Send {confirmName} home permanently?</h2>
          <p id="send-home-description">This deletes this agent’s SDK session and its local conversation record,
            then removes its sprite. It cannot be undone. Other agents are not affected.</p>
          <p>The working files stay untouched at <code>{confirmAgent.workspace}</code>.</p>
          {(sdkRoom?.worktrees ?? []).filter(tree => tree.agentId === confirmAgent.id).map(tree =>
            <p key={tree.path}>The Git worktree and branch <code>{tree.branch}</code> stay at <code>{tree.path}</code>.</p>)}
          <label className="send-home-acknowledge">
            <input ref={confirmCheckboxRef} type="checkbox" checked={confirmChecked}
              disabled={confirmSubmitting} onChange={event => setConfirmChecked(event.target.checked)} />
            I understand the SDK session and chat will be deleted, but files will be kept.
          </label>
          {confirmError && <p className="send-home-error" role="alert">{confirmError}</p>}
          <div className="send-home-buttons">
            <button type="button" disabled={confirmSubmitting} onClick={closeConfirmation}>Cancel</button>
            <button type="button" className="send-home-confirm" disabled={!confirmChecked || confirmSubmitting}
              onClick={() => void confirmSendHome()}>{confirmSubmitting ? "Deleting SDK session…" : "Permanently send home"}</button>
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
if (!root) throw new Error("agentcorp office root is missing");
createRoot(root).render(<LiveOffice />);
