import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../agent-inc/app/styles.css";
import "../live.css";
import "../sdk-chat.css";
import type { Room as SdkRoom } from "../../server/types";
import {
  COFFEE_SPOTS, DESKS, initialProgress, Simulation,
} from "../../agent-inc/game/simulation";
import type { Agent, Request } from "../../agent-inc/game/simulation";
import { sampleDaylight } from "../../agent-inc/game/lighting";
import {
  EXTRA_DESKS, LIVE_COFFEE_Z, MAX_LIVE_DESKS, MIN_LIVE_DESKS,
  assignLoungeSpots, liveDeskCount, routeAroundDividers,
} from "../../agent-inc/game/live-layout";
import { AGENTCORP_LETTERS, AGENTCORP_MARK, AGENTCORP_WORDMARK } from "../../agent-inc/game/sprite-art";
import { createWorld } from "../../agent-inc/game/world";
import { noticeActivityForActor, roomActors } from "./room";
import type { Actor, Room as OfficeRoom, Status } from "./room";

const LIVE_DESKS = [...DESKS, ...EXTRA_DESKS];
const LIVE_COFFEE_SPOTS = COFFEE_SPOTS.map(({ x }) => ({ x, z: LIVE_COFFEE_Z + 0.75 }));
const STEP = 1 / 30;
const connectedStatus = "Live local Copilot SDK office";
const wordmarkPaths = [...AGENTCORP_WORDMARK].map((letter, index) =>
  AGENTCORP_LETTERS[letter].flatMap((row, y) =>
    [...row].flatMap((bit, x) => bit === "1" ? [`M${index * 6 + x} ${y}h1v1h-1z`] : []),
  ).join(""));

function officeRoom(room: SdkRoom | null): OfficeRoom {
  const agent = room?.agent;
  if (!agent) return { currentSessionId: "", sessions: [] };
  const status: Status = agent.phase === "working" ? "tool" :
    agent.phase === "permission" ? "blocked" :
    agent.phase === "thinking" ? "thinking" :
    agent.phase === "idle" ? "idle" : "offline";
  return {
    currentSessionId: agent.sessionId,
    sessions: [{
      sessionId: agent.sessionId, title: "Your SDK session",
      status, activity: agent.activity, tools: [],
      subagents: [], messages: agent.messages.length,
      ...(status === "tool" ? { recentTool: { kind: "Working" as const, at: Date.now() } } : {}),
      events: agent.messages.slice(-6).map((message, index) => ({
        kind: "message" as const,
        label: message.role === "user" ? "Message sent" : message.pending ? "Response streaming" : "Assistant replied",
        at: index
      })),
      updatedAt: Date.now(), seenAt: Date.now()
    }]
  };
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

function applyRoom(scene: Simulation, actors: Actor[], occupied: boolean[]) {
  const shown = actors.slice(0, MAX_LIVE_DESKS);
  while (scene.agents.length < shown.length) scene.agents.push(makeAgent(scene.agents.length));
  scene.agents.length = Math.max(MIN_LIVE_DESKS, shown.length);
  scene.progress.capacity = shown.length;
  scene.requests = [];
  const loungeSpots = assignLoungeSpots(shown.slice(MIN_LIVE_DESKS).map((actor) =>
    actor.status === "idle" || actor.status === "offline"));
  shown.forEach((actor, id) => {
    const agent = scene.agents[id];
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
  const [tab, setTab] = useState<"office" | "chat">("office");
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
  const actorsRef = useRef<Actor[]>([]);
  const selectedCard = useRef<HTMLDivElement>(null);
  const focusedKey = useRef("");
  const selectedRef = useRef("");
  const returnFocus = useRef(false);
  const previewRef = useRef(0);
  const roomRef = useRef<SdkRoom | null>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const room = officeRoom(sdkRoom);

  const updateRoom = (next: SdkRoom) => {
    if (roomRef.current && next.revision < roomRef.current.revision) return;
    roomRef.current = next;
    setSdkRoom(next);
    if (next.agent?.review) {
      setPanelOpen(true);
      setTab("chat");
    }
  };
  const act = async (path: string, body: Record<string, unknown>) => {
    try {
      setActionError("");
      updateRoom(await post(path, body));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
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
  const closeActivity = () => {
    unfocusActor();
    returnFocus.current = true;
    setPanelOpen(false);
  };

  const selectActor = (key: string) => {
    if (selectedRef.current === key) {
      unfocusActor();
      return;
    }
    const index = actorsRef.current.findIndex((actor) => actor.key === key);
    if (index < 0 || index >= MAX_LIVE_DESKS) throw new Error(`Worker has no desk: ${key}`);
    selectedRef.current = key;
    worldRef.current?.focusAgent(index);
    focusedKey.current = `${key}:${index}`;
    setSelected(key);
    setPanelOpen(true);
    setTab("chat");
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
        closeActivity();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [panelOpen]);

  useEffect(() => {
    if (panelOpen && tab === "chat") {
      selectedCard.current?.scrollIntoView({
        block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    }
  }, [selected, panelOpen, tab]);

  useEffect(() => {
    if (panelOpen && tab === "chat") messagesEnd.current?.scrollIntoView({ block: "end" });
  }, [sdkRoom?.revision, panelOpen, tab]);

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
        onEmptySelect(clientX, clientY) {
          if (roomRef.current?.agent || !roomRef.current?.connected) return;
          const rect = host.current?.getBoundingClientRect();
          if (!rect) return;
          void act("create", {
            x: Math.min(100, Math.max(0, (clientX - rect.left) / rect.width * 100)),
            y: Math.min(100, Math.max(0, (clientY - rect.top) / rect.height * 100))
          });
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
        const nextActors = roomActors(officeRoom(update));
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
        actorsRef.current = roomActors(officeRoom(initial));
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
  const deskCount = liveDeskCount(actors.length);
  const working = actors.filter((actor) => actor.status === "thinking" || actor.status === "tool").length;
  const idle = actors.filter((actor) => actor.status === "idle").length;
  const blocked = actors.filter((actor) => actor.status === "blocked").length;
  const messages = sdkRoom?.agent?.messages.length ?? 0;
  const connected = sdkRoom?.connected === true && connection === connectedStatus;
  const signals = room.sessions.flatMap((session) => (session.events ?? []).map((event, index) => ({
    ...event, owner: actors[0]?.name || "Agent",
    key: `${session.sessionId}:${event.at}:${index}`,
  }))).reverse().slice(0, 8);
  if (sdkRoom?.agent && sdkRoom.agent.phase !== "idle") {
    signals.unshift({
      kind: sdkRoom.agent.phase === "error" ? "error" : "tool",
      label: sdkRoom.agent.activity,
      at: Date.now(), owner: actors[0]?.name || "Agent",
      key: `activity:${sdkRoom.agent.phase}:${sdkRoom.revision}`
    });
  }
  useEffect(() => {
    const index = actors.findIndex((actor) => actor.key === selected);
    if (selected && index < 0) {
      unfocusActor();
      return;
    }
    const key = `${selected}:${index}`;
    if (focusedKey.current !== key) {
      worldRef.current?.focusAgent(index >= 0 && index < MAX_LIVE_DESKS ? index : null);
      focusedKey.current = key;
    }
  }, [room, selected]);
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
          <button ref={activityToggle} type="button" className="system-toggle" aria-expanded={panelOpen} aria-controls="system-panel"
            onClick={() => setPanelOpen(true)}>Activity <span className="toggle-chevron" aria-hidden="true" /></button>
        </div>
      </header>
      <div className="layout">
        <section className="world-panel" aria-label="Live Copilot office">
          <div ref={host} className="world-host">
            {hover && <div className="agent-hover" style={{ left: hover.x, top: hover.y }}>{hover.name}</div>}
            {!sdkRoom?.agent && connected && (
              <div className="world-callout live-callout"><span className="callout-star">✦</span>
                <span>Click an empty desk to invite your first SDK agent.</span>
              </div>
            )}
            {(blocked > 0 || working > 0) && sdkRoom?.agent && (
              <div className="world-callout live-callout"><span className="callout-star">✦</span>
                <span>{blocked ? `${blocked} worker${blocked === 1 ? "" : "s"} need attention.` :
                  `${working} worker${working === 1 ? " is" : "s are"} active.`}</span>
              </div>
            )}
          </div>
        </section>
        <aside id="system-panel" className={`sidebar activity-panel ${panelOpen ? "sidebar-open" : ""}`}
          aria-label="Activity" aria-hidden={!panelOpen} inert={!panelOpen}>
          <div className="activity-header">
            <div className="activity-title-row">
              <h2>{selected && actors[0] ? actors[0].name : "Activity"}</h2>
              <button ref={activityClose} type="button" className="sidebar-close" onClick={closeActivity}
                aria-label="Close activity">
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
              </button>
            </div>
            <div className="activity-summary" aria-label="Live office summary">
              <span><strong>{room.sessions.length}</strong> {room.sessions.length === 1 ? "session" : "sessions"}</span>
              <span><strong>{working}</strong> working</span>
              <span><strong>{messages}</strong> {messages === 1 ? "message" : "messages"}</span>
            </div>
          </div>
          <nav className="activity-tabs" aria-label="Activity views">
            {([["office", "Overview"], ["chat", "Conversation"]] as const).map(([item, label]) => (
              <button key={item} type="button" aria-pressed={tab === item}
                onClick={() => setTab(item)}>{label}</button>
            ))}
          </nav>
          <div className={`activity-scroll ${tab === "chat" ? "conversation-scroll" : ""}`}>
            {tab === "office" && (
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
                  <p>{sdkRoom?.agent ? "Click the pixel agent to focus the camera and open its persistent chat." :
                    "Click an empty spot in the office to create a new SDK session and agent."}</p>
                </div>
                <div className="activity-row">
                  <div className="activity-row-heading"><strong>Tool working directory</strong><span className="activity-tag">Local only</span></div>
                  <p className="workspace-path">{sdkRoom?.workspace || "Loading…"}</p>
                  <p>This is not an OS sandbox. Every SDK tool request waits for one explicit permission decision.</p>
                </div>
                {sdkRoom?.error && <button type="button" className="focus-button" onClick={() => void act("retry", {})}>Retry SDK connection</button>}
              </section>
            )}
            {tab === "chat" && (
              <section className="activity-view conversation-view" aria-label="SDK conversation" ref={selectedCard}>
                {sdkRoom?.agent ? <>
                  <div className="conversation-person">
                    <span className="worker-avatar" aria-hidden="true">{actors[0]?.name.split(" ").map(part => part[0]).join("")}</span>
                    <span><strong>{actors[0]?.name}</strong><small>{sdkRoom.agent.activity}</small></span>
                    <span className={`activity-tag status-${actors[0]?.status}`}>{sdkRoom.agent.phase}</span>
                  </div>
                  <div className="conversation-messages">
                    {sdkRoom.agent.messages.length === 0 && <p className="activity-empty">Say hello to your new office mate.</p>}
                    {sdkRoom.agent.messages.map(message =>
                      <div className={`conversation-message ${message.role}`} key={message.id}>
                        <span>{message.role === "user" ? "YOU" : actors[0]?.name}{message.pending ? " · STREAMING" : ""}</span>
                        <p>{message.content}</p>
                      </div>)}
                    <div ref={messagesEnd} />
                  </div>
                </> : <p className="activity-empty">Click an empty desk to create your first agent.</p>}
              </section>
            )}
          </div>
          {sdkRoom?.agent?.review && <div className="permission-card" role="alertdialog" aria-label="Tool permission request">
            <strong>Permission needed · {sdkRoom.agent.review.kind}</strong>
            <span>Review the complete request before allowing this tool once.</span>
            <pre>{sdkRoom.agent.review.detail}</pre>
            <div className="permission-buttons">
              <button type="button" onClick={() => void act("decision", { id: sdkRoom.agent!.review!.id, allow: false })}>Deny</button>
              <button type="button" onClick={() => void act("decision", { id: sdkRoom.agent!.review!.id, allow: true })}>Allow once</button>
            </div>
            <small>Expires in 90 seconds. Your workspace is not an OS sandbox.</small>
          </div>}
          {tab === "chat" && sdkRoom?.agent && <form className="conversation-composer" onSubmit={event => {
            event.preventDefault();
            if (!draft.trim()) return;
            const prompt = draft;
            setDraft("");
            void act("send", { prompt });
          }}>
            <label htmlFor="chat-prompt">MESSAGE YOUR AGENT</label>
            <div><textarea id="chat-prompt" value={draft} onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }} rows={2} maxLength={12000} placeholder="Ask something, or start a task…"
              disabled={!connected || ["thinking", "working", "permission"].includes(sdkRoom.agent.phase)} />
              <button type="submit" disabled={!connected || !draft.trim() || ["thinking", "working", "permission"].includes(sdkRoom.agent.phase)} aria-label="Send message">↗</button>
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
        Tools start in <strong>{sdkRoom.workspace.split("/").at(-1)}</strong> · not an OS sandbox · approval required
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
