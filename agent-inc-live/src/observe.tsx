import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../agent-inc/app/styles.css";
import "../live.css";
import "../observe.css";
import { Simulation, initialProgress, DESKS, COFFEE_SPOTS, type Agent, type Request } from "../../agent-inc/game/simulation";
import { EXTRA_DESKS, LIVE_COFFEE_Z, MAX_LIVE_DESKS, MIN_LIVE_DESKS, assignLoungeSpots, routeAroundDividers } from "../../agent-inc/game/live-layout";
import { sampleDaylight } from "../../agent-inc/game/lighting";
import { AGENTCORP_LETTERS, AGENTCORP_MARK, AGENTCORP_WORDMARK } from "../../agent-inc/game/sprite-art";
import { createWorld } from "../../agent-inc/game/world";
import { agentName } from "./room";

type Phase = "idle" | "thinking" | "tool" | "blocked" | "offline";
type Member = { id: string; phase: Phase; present: boolean };
type Observation = { root: string; sessions: Member[] };
const desks = [...DESKS, ...EXTRA_DESKS];
const coffee = COFFEE_SPOTS.map(({ x }) => ({ x, z: LIVE_COFFEE_Z + 0.75 }));
const STEP = 1 / 30;
const themeKey = "agentcorp-harness-theme";
const wordmarkPaths = [...AGENTCORP_WORDMARK].map((letter, index) =>
  AGENTCORP_LETTERS[letter].flatMap((row, y) =>
    [...row].flatMap((bit, x) => bit === "1" ? [`M${index * 6 + x} ${y}h1v1h-1z`] : []),
  ).join(""));

function newAgent(id: number): Agent {
  return { id, state: "idle", x: 100, z: 100, target: { x: 100, z: 100 },
    route: [], workLeft: 0, workTotal: 0, visitedContext: false };
}

function updateScene(scene: Simulation, members: Member[], occupied: boolean[]) {
  const count = Math.min(members.length, MAX_LIVE_DESKS);
  while (scene.agents.length < count) scene.agents.push(newAgent(scene.agents.length));
  scene.progress.capacity = count;
  scene.requests = [];
  const lounge = assignLoungeSpots(members.slice(MIN_LIVE_DESKS, count).map(member => member.phase === "idle"));
  for (let index = 0; index < count; index++) {
    const member = members[index];
    const sprite = scene.agents[index];
    if (!member.present) {
      occupied[index] = false;
      sprite.x = sprite.z = 100;
      sprite.target = { x: 100, z: 100 };
      sprite.route = [];
      sprite.taskId = undefined;
      sprite.state = "idle";
      continue;
    }
    const busy = member.phase !== "idle" && member.phase !== "offline";
    const destination = busy ? desks[index] : index < MIN_LIVE_DESKS ? coffee[index] : lounge[index - MIN_LIVE_DESKS];
    if (!destination) throw new Error(`Missing office destination for desk ${index + 1}`);
    if (!occupied[index]) { sprite.x = destination.x; sprite.z = destination.z; }
    occupied[index] = true;
    if (sprite.target.x !== destination.x || sprite.target.z !== destination.z) {
      sprite.route = routeAroundDividers(sprite, destination);
    }
    sprite.target = { ...destination };
    sprite.taskId = busy ? index + 1 : undefined;
    if (busy) {
      const status: Request["status"] = member.phase === "blocked" ? "failed" :
        member.phase === "thinking" ? "assigned" : "working";
      scene.requests.push({ id: index + 1, stationId: index, title: member.phase,
        kind: "chat", status, progress: 0, reward: 0,
        ...(status === "failed" ? { resolvedAt: scene.time } : {}) });
    }
  }
}

function move(scene: Simulation) {
  for (let index = 0; index < scene.progress.capacity; index++) {
    const sprite = scene.agents[index];
    if (sprite.x === 100) continue;
    const point = sprite.route[0] ?? sprite.target;
    const distance = Math.hypot(point.x - sprite.x, point.z - sprite.z);
    const busy = sprite.taskId !== undefined;
    if (distance > 0.02) {
      const step = Math.min(distance, 2.05 * STEP);
      sprite.x += (point.x - sprite.x) / distance * step;
      sprite.z += (point.z - sprite.z) / distance * step;
      sprite.state = busy ? "walking" : "returning";
    } else {
      sprite.x = point.x; sprite.z = point.z;
      if (sprite.route.length) sprite.route.shift();
      sprite.state = sprite.route.length ? "returning" : busy ? "working" : "idle";
    }
  }
}

function Office() {
  const host = useRef<HTMLDivElement>(null);
  const world = useRef<ReturnType<typeof createWorld> | null>(null);
  const members = useRef<Member[]>([]);
  const [state, setState] = useState<Observation | null>(null);
  const [error, setError] = useState("");
  const [sceneError, setSceneError] = useState("");
  const [themeError, setThemeError] = useState("");
  const [selected, setSelected] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [hover, setHover] = useState<{ name: string; x: number; y: number } | null>(null);
  const hoverIndex = useRef<number | null>(null);
  const hoverLabel = useRef<HTMLDivElement>(null);
  const [previewOffset, setPreviewOffset] = useState(0);
  const previewRef = useRef(0);
  const [themePreference, setThemePreference] = useState<"system" | "light" | "dark">(() => {
    const saved = localStorage.getItem(themeKey);
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const selectedRef = useRef("");
  const darkTheme = themePreference === "system" ? systemDark : themePreference === "dark";
  useLayoutEffect(() => { document.documentElement.dataset.officeTheme = darkTheme ? "dark" : "light"; }, [darkTheme]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!panelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPanelOpen(false);
        selectedRef.current = "";
        setSelected("");
        world.current?.focusAgent(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panelOpen]);
  const closePanel = () => {
    setPanelOpen(false);
    selectedRef.current = "";
    setSelected("");
    setHover(null);
    world.current?.focusAgent(null);
  };
  const toggleTheme = () => {
    const next = darkTheme ? "light" : "dark";
    try {
      localStorage.setItem(themeKey, next);
      setThemePreference(next);
      setThemeError("");
    } catch (cause) {
      setThemeError(`Theme preference could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  const previewLight = () => {
    previewRef.current = (previewRef.current + 0.25) % 1;
    setPreviewOffset(previewRef.current);
  };
  useEffect(() => {
    if (!host.current) return;
    const scene = new Simulation(initialProgress());
    scene.agents = Array.from({ length: MIN_LIVE_DESKS }, (_, i) => newAgent(i));
    scene.progress.capacity = 0;
    scene.progress.context = false;
    scene.progress.workflow = 1;
    const occupied = Array<boolean>(MAX_LIVE_DESKS).fill(false);
    try {
      world.current = createWorld(host.current, scene, "live", {
        onAgentHover(index) {
          if (selectedRef.current) {
            const focused = members.current.findIndex(member => member.id === selectedRef.current && member.present);
            index = focused < 0 ? null : focused;
          }
          if (hoverIndex.current === index) return;
          hoverIndex.current = index;
          const member = index === null ? undefined : members.current[index];
          const point = index === null ? null : world.current?.projectAgent(index);
          setHover(member?.present && point ? { name: agentName(member.id), ...point } : null);
        },
        noticeActivityForStation(index) {
          const member = members.current[index];
          return member?.phase === "thinking" ? "thinking" :
            member?.phase === "tool" ? "working" :
            member?.phase === "blocked" ? "blocked" : null;
        },
        onAgentSelect(index) {
          const member = members.current[index];
          if (member?.present) {
            selectedRef.current = member.id;
            setSelected(member.id);
            setPanelOpen(true);
          }
        },
        onFocusCleared() { selectedRef.current = ""; setSelected(""); setHover(null); },
      });
    } catch (cause) {
      host.current.classList.add("static-fallback");
      setSceneError(`3D office unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/api/observations", { cache: "no-store" });
        if (!response.ok) throw new Error(`Office returned ${response.status}`);
        const next = await response.json() as Observation;
        if (!Array.isArray(next.sessions)) throw new Error("Invalid office snapshot");
        if (!active) return;
        members.current = next.sessions;
        world.current?.capturePositions();
        updateScene(scene, next.sessions, occupied);
        next.sessions.forEach((_, index) => world.current?.setAgentPersona(index, index % 4));
        setState(next);
        setError("");
        const index = next.sessions.findIndex(member => member.id === selectedRef.current && member.present);
        world.current?.focusAgent(index >= 0 ? index : null);
        if (index < 0) { selectedRef.current = ""; setSelected(""); }
      } catch (cause) {
        if (active) setError(`Office update failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    };
    void refresh();
    const poll = window.setInterval(() => void refresh(), 3_000);
    let frameId = 0;
    let last = performance.now();
    let remainder = 0;
    const frame = (now: number) => {
      remainder += Math.min((now - last) / 1000, 0.2);
      last = now;
      let advanced = false;
      if (!document.hidden) {
        while (remainder >= STEP) {
          world.current?.capturePositions();
          move(scene); scene.time += STEP;
          remainder -= STEP; advanced = true;
        }
        world.current?.render(now / 1000, previewRef.current, remainder / STEP, advanced);
        if (hoverIndex.current !== null && hoverLabel.current) {
          const point = world.current?.projectAgent(hoverIndex.current);
          hoverLabel.current.hidden = !point;
          if (point) {
            hoverLabel.current.style.left = `${point.x}px`;
            hoverLabel.current.style.top = `${point.y}px`;
          }
        }
      } else remainder = 0;
      frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);
    return () => {
      active = false;
      window.clearInterval(poll);
      cancelAnimationFrame(frameId);
      world.current?.dispose();
      world.current = null;
    };
  }, []);
  const sessions = state?.sessions ?? [];
  const live = sessions.filter(member => member.present).length;
  const working = sessions.filter(member => member.present && (member.phase === "thinking" || member.phase === "tool")).length;
  const idle = sessions.filter(member => member.present && member.phase === "idle").length;
  const blocked = sessions.filter(member => member.present && member.phase === "blocked").length;
  const offline = sessions.length - live;
  const visualError = error || sceneError || themeError;
  const connected = !error && state !== null && sessions[0]?.present === true;
  const statusKind = visualError ? "error" : !state ? "connecting" : connected ? "online" : "offline";
  const statusLabel = visualError ? "Error" : !state ? "Connecting" : connected ? "Live" : "Offline";
  const daylight = sampleDaylight(0, previewOffset);
  return <main className={`shell live-shell observer-shell ${panelOpen ? "activity-visible" : ""}`}>
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
          role="img" aria-label="agentcorp" shapeRendering="crispEdges">
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
        <span className="observer-count">{live} observed</span>
        <button type="button" className="system-toggle" aria-expanded={panelOpen} aria-controls="system-panel"
          aria-label={`Manage agents${blocked ? `: ${blocked} need attention` : ""}`}
          onClick={() => setPanelOpen(true)}>Manage agents
          {blocked > 0 && <span className="activity-attention" aria-hidden="true">{blocked}</span>}
          <span className="toggle-chevron" aria-hidden="true" /></button>
      </div>
    </header>
    <div className="layout">
      <section className="world-panel" aria-label="Live Copilot office">
        <div className="world-host" ref={host}>
          {hover && <div ref={hoverLabel} className="agent-hover" style={{ left: hover.x, top: hover.y }}>{hover.name}</div>}
          <div className="world-callout live-callout" role="status" aria-live="polite">
            <button type="button" className={`office-status-link sdk-${statusKind}`}
              aria-label={`Observation status: ${statusLabel}. Open office overview`}
              title={visualError || "Read-only session activity"}
              onClick={() => setPanelOpen(true)}>
              <span className="sdk-status-dot" aria-hidden="true" /> {statusLabel}
            </button>
            <span className="callout-separator" aria-hidden="true" />
            <span>{visualError || (!state ? "Connecting to this session…" :
              `${working} working · ${idle} idle${blocked ? ` · ${blocked} need attention` : ""}${offline ? ` · ${offline} offline` : ""}`)}</span>
          </div>
        </div>
      </section>
      <aside id="system-panel" className={`sidebar activity-panel ${panelOpen ? "sidebar-open" : ""}`}
        aria-label="Office overview" aria-hidden={!panelOpen} inert={!panelOpen}>
        <div className="activity-header">
          <div className="activity-title-row">
            <h2>Activity</h2>
            <button type="button" className="sidebar-close" onClick={closePanel} aria-label="Close activity">
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
            </button>
          </div>
        </div>
        <nav className="activity-tabs" aria-label="Activity views">
          <button type="button" aria-pressed="true">Overview</button>
        </nav>
        <div className="activity-scroll activity-list-scroll">
          <section className="activity-view overview-list" aria-label="Office overview status">
            <div className="activity-row activity-row-first">
              <div className="activity-row-heading"><strong>Connection</strong>
                <span className={`activity-tag ${connected ? "activity-tag-live" : "activity-tag-warning"}`}>
                  {connected ? "Connected" : "Needs attention"}</span></div>
              {error && <p role="alert">{error}</p>}
              <div className="activity-chips"><span>{working} active</span><span>{idle} idle</span>
                <span className={blocked ? "attention" : ""}>{blocked} need attention</span>
                {offline > 0 && <span>{offline} offline</span>}</div>
            </div>
            {sceneError && <div className="activity-row">
              <div className="activity-row-heading"><strong>3D scene</strong>
                <span className="activity-tag activity-tag-warning">Unavailable</span></div>
              <p>{sceneError} Session observations remain available below.</p>
            </div>}
            {themeError && <div className="activity-row">
              <div className="activity-row-heading"><strong>HUD preference</strong>
                <span className="activity-tag activity-tag-warning">Not saved</span></div>
              <p>{themeError}</p>
            </div>}
            <div className="activity-row">
              <div className="activity-row-heading"><strong>The office</strong>
                <span className="activity-tag">{MAX_LIVE_DESKS} desks</span></div>
              <p>Read-only view of this Copilot CLI session and explicitly enrolled descendants. Click a sprite to focus it; manage conversations and permissions in their own sessions.</p>
            </div>
            <div className="activity-row">
              <div className="activity-row-heading"><strong>Observed agents</strong>
                <span className="activity-tag">{sessions.length} enrolled</span></div>
              {sessions.length ? <div className="activity-list">
                {sessions.map((member, index) => <div key={member.id}
                  className={`activity-worker-row ${selected === member.id ? "worker-selected" : ""}`}>
                  <span className="worker-avatar" aria-hidden="true">{agentName(member.id).split(" ").map(part => part[0]).join("")}</span>
                  <div className="activity-worker-info">
                    <div className="activity-worker-title"><strong>{agentName(member.id)}</strong>
                      <span className={`activity-tag status-${member.phase}`}>{member.phase}</span></div>
                    <p className="activity-worker-meta">{index === 0 ? "This session · root" : `Enrolled descendant · desk ${index + 1}`}</p>
                    {!member.present && <p className="activity-current">No recent heartbeat from this session.</p>}
                  </div>
                  {member.present && <button type="button" className="focus-button"
                    aria-label={`Focus ${agentName(member.id)}`}
                    aria-pressed={selected === member.id}
                    onClick={() => {
                      selectedRef.current = member.id;
                      setSelected(member.id);
                      world.current?.focusAgent(index);
                    }}>Focus</button>}
                </div>)}
              </div> : <p className="activity-empty">Waiting for this session's activity.</p>}
            </div>
            <div className="activity-row">
              <div className="activity-row-heading"><strong>Local observation</strong>
                <span className="activity-tag">Read only</span></div>
              <p>Sessions are linked explicitly, not discovered from repository or branch. App-created children require the root's add_descendant canvas action. Missing or expired heartbeats show offline, not guessed activity.</p>
            </div>
          </section>
        </div>
      </aside>
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Office />);
