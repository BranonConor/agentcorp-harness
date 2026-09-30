import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../agent-inc/app/styles.css";
import "../live.css";
import "../sdk-chat.css";
import { MAX_AGENTS, type Room as SdkRoom } from "../../server/types";
import {
  COFFEE_SPOTS, DESKS, initialProgress, Simulation,
} from "../../agent-inc/game/simulation";
import type { Agent, Request } from "../../agent-inc/game/simulation";
import { sampleDaylight } from "../../agent-inc/game/lighting";
import {
  EXTRA_DESKS, LIVE_COFFEE_Z, MAX_LIVE_DESKS, MIN_LIVE_DESKS,
  assignLoungeSpots, routeAroundDividers,
} from "../../agent-inc/game/live-layout";
import { AGENTCORP_LETTERS, AGENTCORP_MARK, AGENTCORP_WORDMARK } from "../../agent-inc/game/sprite-art";
import { createWorld } from "../../agent-inc/game/world";
import { noticeActivityForActor, roomActors } from "./room";
import type { Actor, Room as OfficeRoom, Status } from "./room";
import { SafeMarkdown } from "./markdown";

const LIVE_DESKS = [...DESKS, ...EXTRA_DESKS];
const LIVE_COFFEE_SPOTS = COFFEE_SPOTS.map(({ x }) => ({ x, z: LIVE_COFFEE_Z + 0.75 }));
const STEP = 1 / 30;
const connectedStatus = "Live local Copilot SDK office";
const wordmarkPaths = [...AGENTCORP_WORDMARK].map((letter, index) =>
  AGENTCORP_LETTERS[letter].flatMap((row, y) =>
    [...row].flatMap((bit, x) => bit === "1" ? [`M${index * 6 + x} ${y}h1v1h-1z`] : []),
  ).join(""));

function officeRoom(room: SdkRoom | null): OfficeRoom {
  if (!room) return { currentSessionId: "", sessions: [] };
  return {
    currentSessionId: "",
    sessions: room.agents.map(agent => {
      const status: Status = agent.phase === "working" ? "tool" :
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
  const bySession = new Map(roomActors(officeRoom(room)).map(actor => [actor.key, actor]));
  const slots: (Actor | null)[] = Array.from({ length: Math.max(0, ...room.agents.map(agent => agent.deskIndex + 1)) }, () => null);
  for (const agent of room.agents) slots[agent.deskIndex] = bySession.get(agent.sessionId) ?? null;
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
  const [tab, setTab] = useState<"office" | "conversations">("office");
  const [feedOpen, setFeedOpen] = useState(false);
  const [previewOffset, setPreviewOffset] = useState(0);
  const [selected, setSelected] = useState("");
  const [hover, setHover] = useState<{ name: string; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [actionError, setActionError] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const activityToggle = useRef<HTMLButtonElement>(null);
  const activityClose = useRef<HTMLButtonElement>(null);
  const sceneRef = useRef<Simulation | null>(null);
  const worldRef = useRef<ReturnType<typeof createWorld> | null>(null);
  const actorsRef = useRef<(Actor | null)[]>([]);
  const chatScroll = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const seenReviews = useRef(new Set<string>());
  const focusedKey = useRef("");
  const selectedRef = useRef("");
  const returnFocus = useRef(false);
  const previewRef = useRef(0);
  const roomRef = useRef<SdkRoom | null>(null);
  const room = officeRoom(sdkRoom);

  const updateRoom = (next: SdkRoom) => {
    if (roomRef.current && next.revision < roomRef.current.revision) return;
    roomRef.current = next;
    setSdkRoom(next);
    for (const agent of next.agents) {
      if (agent.review && !seenReviews.current.has(agent.review.id)) {
        seenReviews.current.add(agent.review.id);
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
  };
  const unfocusActor = () => {
    worldRef.current?.focusAgent(null);
    clearSelection();
  };
  const backToActivity = () => {
    unfocusActor();
    setTab("conversations");
  };
  const closeActivity = () => {
    unfocusActor();
    returnFocus.current = true;
    setPanelOpen(false);
  };

  const selectActor = (key: string) => {
    const index = actorsRef.current.findIndex((actor) => actor?.key === key);
    if (index < 0 || index >= MAX_LIVE_DESKS) throw new Error(`Worker has no desk: ${key}`);
    selectedRef.current = key;
    worldRef.current?.focusAgent(index);
    focusedKey.current = `${key}:${index}`;
    setSelected(key);
    setPanelOpen(true);
    setTab("conversations");
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
        if (selectedRef.current) backToActivity();
        else closeActivity();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [panelOpen, selected]);

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
        onAgentHover(index, clientX, clientY) {
          const actor = index === null ? undefined : actorsRef.current[index];
          const rect = host.current?.getBoundingClientRect();
          setHover(actor && rect ? { name: actor.name, x: clientX - rect.left, y: clientY - rect.top } : null);
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

  const actors = roomActors(room);
  const deskCount = MAX_LIVE_DESKS;
  const firstEmptyDesk = Array.from({ length: MAX_AGENTS }, (_, index) => index)
    .find(index => !sdkRoom?.agents.some(agent => agent.deskIndex === index));
  const officeFull = sdkRoom?.agents.length === MAX_AGENTS;
  const working = actors.filter((actor) => actor.status === "thinking" || actor.status === "tool").length;
  const idle = actors.filter((actor) => actor.status === "idle").length;
  const blocked = actors.filter((actor) => actor.status === "blocked").length;
  const messages = sdkRoom?.agents.reduce((sum, agent) => sum + agent.messages.length, 0) ?? 0;
  const connected = sdkRoom?.connected === true && connection === connectedStatus;
  const signals = room.sessions.flatMap((session) => (session.events ?? []).map((event, index) => ({
    ...event, owner: actors.find(actor => actor.key === session.sessionId)?.name || "Agent",
    key: `${session.sessionId}:${event.at}:${index}`,
  }))).reverse().slice(0, 8);
  for (const agent of sdkRoom?.agents ?? []) if (agent.phase !== "idle") {
    signals.unshift({
      kind: agent.phase === "error" ? "error" : "tool",
      label: agent.activity,
      at: agent.updatedAt, owner: actors.find(actor => actor.key === agent.sessionId)?.name || "Agent",
      key: `activity:${agent.id}:${agent.phase}:${sdkRoom?.revision}`
    });
  }
  const selectedAgent = sdkRoom?.agents.find(agent => agent.sessionId === selected);
  const selectedActor = actors.find(actor => actor.key === selected);
  useEffect(() => {
    const index = actorsRef.current.findIndex((actor) => actor?.key === selected);
    if (selected && index < 0) {
      unfocusActor();
      return;
    }
    const key = `${selected}:${index}`;
    if (focusedKey.current !== key) {
      worldRef.current?.focusAgent(index >= 0 && index < MAX_LIVE_DESKS ? index : null);
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
            <span className="office-presence" role="status" aria-label={connected ? "Live office connected" : connection}>
              <span className={`online-dot ${connected ? "" : "online-dot-offline"}`} aria-hidden="true" />
              <span className="office-presence-label" aria-hidden="true">{connected ? "Live SDK office" : "Connecting"}</span>
            </span>
          </div>
        </div>
        <div className="top-stats" aria-hidden={panelOpen} inert={panelOpen}>
          <div className="stat"><span className="stat-label">Sessions</span><strong>{room.sessions.length}</strong></div>
          <div className="stat"><span className="stat-label">Working</span><strong>{working}</strong></div>
          <div className="stat desktop-stat"><span className="stat-label">Messages</span><strong>{messages}</strong></div>
          <button type="button" className="add-agent-button" disabled={!connected || firstEmptyDesk === undefined}
            aria-label={officeFull ? `Office full (${MAX_AGENTS} desks)` : "Add agent"}
            title={officeFull ? `All ${MAX_AGENTS} office desks are occupied` : "Create an independent SDK agent"}
            onClick={() => firstEmptyDesk !== undefined && void act("create", { deskIndex: firstEmptyDesk })}>
            {officeFull ? <>Office full <span className="desk-capacity">({MAX_AGENTS} desks)</span></> : "+ Add agent"}
          </button>
          <button ref={activityToggle} type="button" className="system-toggle" aria-expanded={panelOpen} aria-controls="system-panel"
            onClick={() => setPanelOpen(true)}>Activity <span className="toggle-chevron" aria-hidden="true" /></button>
        </div>
      </header>
      <div className="layout">
        <section className="world-panel" aria-label="Live Copilot office">
          <div ref={host} className="world-host">
            {hover && <div className="agent-hover" style={{ left: hover.x, top: hover.y }}>{hover.name}</div>}
            {connected && Array.from({ length: deskCount }, (_, deskIndex) =>
              sdkRoom?.agents.some(agent => agent.deskIndex === deskIndex) ? null :
                <button key={deskIndex} type="button" className="desk-add" data-desk-index={deskIndex}
                  aria-label={`Add independent SDK agent at empty desk ${deskIndex + 1}`}
                  title={`Add agent at desk ${deskIndex + 1}`}
                  onClick={() => void act("create", { deskIndex })}>+</button>)}
            {(sdkRoom?.agents ?? []).map(agent => {
              const actor = actors.find(item => item.key === agent.sessionId);
              return <button key={agent.id} type="button" className="keyboard-agent-target"
                data-agent-desk={agent.deskIndex}
                aria-label={`Chat with ${actor?.name ?? "agent"} at desk ${agent.deskIndex + 1}`}
                onFocus={() => {
                  const point = worldRef.current?.projectAgent(agent.deskIndex);
                  if (point && actor) setHover({ name: actor.name, ...point });
                }}
                onBlur={() => setHover(null)}
                onClick={() => selectActor(agent.sessionId)} />;
            })}
            {!sdkRoom?.agents.length && connected && (
              <div className="world-callout live-callout"><span className="callout-star">✦</span>
                <span>Click + above an empty desk to create a separate SDK agent.</span>
              </div>
            )}
            {(blocked > 0 || working > 0) && !!sdkRoom?.agents.length && (
              <div className="world-callout live-callout"><span className="callout-star">✦</span>
                <span>{blocked ? `${blocked} worker${blocked === 1 ? "" : "s"} need attention.` :
                  `${working} worker${working === 1 ? " is" : "s are"} active.`}</span>
              </div>
            )}
          </div>
        </section>
        <aside id="system-panel" className={`sidebar activity-panel ${panelOpen ? "sidebar-open" : ""} ${selectedAgent ? "chat-open" : ""}`}
          aria-label={selectedAgent ? `${selectedActor?.name ?? "Agent"} conversation` : "Activity"}
          aria-hidden={!panelOpen} inert={!panelOpen}>
          <div className="activity-header">
            <div className="activity-title-row">
              {selectedAgent && <button type="button" className="chat-back" onClick={backToActivity}
                aria-label="Back to conversations">←</button>}
              <h2>{selectedAgent ? selectedActor?.name : "Activity"}</h2>
              <button ref={activityClose} type="button" className="sidebar-close" onClick={closeActivity}
                aria-label={selectedAgent ? "Close conversation" : "Close activity"}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
              </button>
            </div>
            {!selectedAgent && <div className="activity-summary" aria-label="Live office summary">
              <span><strong>{room.sessions.length}</strong> {room.sessions.length === 1 ? "session" : "sessions"}</span>
              <span><strong>{working}</strong> working</span>
              <span><strong>{messages}</strong> {messages === 1 ? "message" : "messages"}</span>
            </div>}
            {selectedAgent && <p className="chat-workspace" title={selectedAgent.workspace}>
              Desk {selectedAgent.deskIndex + 1} · {selectedAgent.workspaceKind === "root" ? "original root" : "disposable scratch folder"} · tools start in <span>{selectedAgent.workspace}</span>
            </p>}
          </div>
          {!selectedAgent && <nav className="activity-tabs" aria-label="Activity views">
            {([["office", "Overview"], ["conversations", "Conversations"]] as const).map(([item, label]) => (
              <button key={item} type="button" aria-pressed={tab === item}
                onClick={() => setTab(item)}>{label}</button>
            ))}
          </nav>}
          <div ref={chatScroll} className={`activity-scroll ${selectedAgent ? "conversation-scroll" : ""}`}
            onScroll={event => {
              if (!selectedAgent) return;
              const scroll = event.currentTarget;
              followTail.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 70;
            }}>
            {!selectedAgent && tab === "office" && (
              <section className="activity-view" aria-label="Office overview">
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
                    "Each agent uses a separate disposable subfolder here."} No project is selected. Paths are not OS sandboxes; every SDK tool request waits for your decision.</p>
                </div>
                {sdkRoom?.error && <button type="button" className="focus-button" onClick={() => void act("retry", {})}>Retry SDK connection</button>}
              </section>
            )}
            {!selectedAgent && tab === "conversations" && (
              <section className="activity-view conversations-list" aria-label="Recent agent conversations">
                {!(sdkRoom?.agents.length) && <p className="activity-empty">No agents yet. Click + above an empty desk to start a conversation.</p>}
                {[...(sdkRoom?.agents ?? [])].sort((a, b) => b.updatedAt - a.updatedAt || a.deskIndex - b.deskIndex).map(agent => {
                  const actor = actors.find(item => item.key === agent.sessionId);
                  const last = agent.messages.at(-1);
                  return <button type="button" className="conversation-row" key={agent.id}
                    onClick={() => selectActor(agent.sessionId)}>
                    <span className="worker-avatar" aria-hidden="true">{actor?.name.split(" ").map(part => part[0]).join("")}</span>
                    <span className="conversation-row-text">
                      <strong>{actor?.name ?? `Desk ${agent.deskIndex + 1}`}</strong>
                      <small>{last ? `${last.role === "user" ? "You: " : ""}${last.content.slice(0, 110)}` :
                        "New conversation · say hello"}</small>
                      <small>Desk {agent.deskIndex + 1} · {agent.activity}</small>
                    </span>
                    {agent.review && <span className="activity-tag activity-tag-warning">Review</span>}
                  </button>;
                })}
              </section>
            )}
            {selectedAgent && (
              <section className="activity-view conversation-view" aria-label="SDK conversation">
                  <div className="conversation-person">
                    <span className="worker-avatar" aria-hidden="true">{selectedActor?.name.split(" ").map(part => part[0]).join("")}</span>
                    <span><strong>{selectedActor?.name}</strong><small>{selectedAgent.activity}</small></span>
                    <span className={`activity-tag status-${selectedActor?.status}`}>{selectedAgent.phase}</span>
                  </div>
                  <div className="conversation-messages">
                    {selectedAgent.messages.length === 0 && <p className="activity-empty">Say hello to your new office mate.</p>}
                    {selectedAgent.messages.map(message =>
                      <div className={`conversation-message ${message.role}`} key={message.id}>
                        <span>{message.role === "user" ? "YOU" : selectedActor?.name}{message.pending ? " · STREAMING" : ""}</span>
                        <div className="message-markdown"><SafeMarkdown content={message.content} /></div>
                      </div>)}
                  </div>
              </section>
            )}
          </div>
          {selectedAgent?.review && <div className="permission-card" role="alertdialog"
            aria-label={`Tool permission request for ${selectedActor?.name ?? "agent"}`}>
            <strong>{selectedActor?.name} · permission needed · {selectedAgent.review.kind}</strong>
            <span>Review the complete request before allowing this tool once.</span>
            <pre>{selectedAgent.review.detail}</pre>
            <div className="permission-buttons">
              <button type="button" onClick={() => void act("decision", { agentId: selectedAgent.id, id: selectedAgent.review!.id, allow: false })}>Deny</button>
              <button type="button" onClick={() => void act("decision", { agentId: selectedAgent.id, id: selectedAgent.review!.id, allow: true })}>Allow once</button>
            </div>
            <small>Expires in 90 seconds. Your workspace is not an OS sandbox.</small>
          </div>}
          {selectedAgent?.phase === "error" && <button type="button" className="focus-button" onClick={() => void act("retry", {})}>Retry agent connection</button>}
          {selectedAgent && <form className="conversation-composer" onSubmit={event => {
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
              <button type="submit" disabled={!connected || !draft.trim() || ["thinking", "working", "permission", "error"].includes(selectedAgent.phase)} aria-label="Send message">↗</button>
            </div>
            <small>Enter to send · Shift+Enter for a new line</small>
          </form>}
        </aside>
      </div>
      <section className={`feed-panel ${feedOpen ? "feed-open" : ""}`} aria-label="Live activity feed">
        <button type="button" className="feed-top" onClick={() => setFeedOpen((open) => !open)}
          aria-expanded={feedOpen} aria-controls="signal-list">
          <span><span className="feed-glyph" aria-hidden="true">●</span> Signals <span className="feed-count">{working} active</span></span>
          <span className="feed-chevron" aria-hidden="true">{feedOpen ? "⌄" : "⌃"}</span>
        </button>
        <div id="signal-list" className="feed-list" aria-live="off">
          {!signals.length && <div className="feed-empty"><span>◌</span> Listening for the first activity…</div>}
          {signals.map((signal) => (
            <div className={`feed-item feed-${signal.kind === "error" ? "failed" : signal.kind === "message" ? "complete" : "working"}`} key={signal.key}>
              <span className="feed-icon">{signal.kind === "error" ? "!" : signal.kind === "message" ? "✓" : "◉"}</span>
              <span className="feed-task">{signal.owner} · {signal.label}</span>
              <span className="feed-status">{signal.kind.toUpperCase()}</span>
            </div>
          ))}
        </div>
      </section>
      {sdkRoom && <div className="workspace-chip" title={sdkRoom.workspace}>
        Scratch root <strong>{sdkRoom.workspace.split("/").at(-1)}</strong> · per-agent folders · not an OS sandbox
      </div>}
      {(connection !== connectedStatus || actionError || sdkRoom?.error) && (
        <div className="storage-error" role="status">
          <span>{actionError || sdkRoom?.error || connection}</span>
          {sdkRoom?.error && <button type="button" onClick={() => void act("retry", {})}>Retry connection</button>}
        </div>
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("agentcorp office root is missing");
createRoot(root).render(<LiveOffice />);
