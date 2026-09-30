import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../agent-inc/app/styles.css";
import "../observe.css";
import { Simulation, initialProgress, DESKS, COFFEE_SPOTS, type Agent, type Request } from "../../agent-inc/game/simulation";
import { EXTRA_DESKS, LIVE_COFFEE_Z, MAX_LIVE_DESKS, MIN_LIVE_DESKS, assignLoungeSpots, routeAroundDividers } from "../../agent-inc/game/live-layout";
import { createWorld } from "../../agent-inc/game/world";
import { agentName } from "./room";

type Phase = "idle" | "thinking" | "tool" | "blocked" | "offline";
type Member = { id: string; phase: Phase; present: boolean };
type Observation = { root: string; sessions: Member[] };
const desks = [...DESKS, ...EXTRA_DESKS];
const coffee = COFFEE_SPOTS.map(({ x }) => ({ x, z: LIVE_COFFEE_Z + 0.75 }));
const STEP = 1 / 30;

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
  const [selected, setSelected] = useState("");
  const selectedRef = useRef("");
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
        onAgentHover() {},
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
          }
        },
        onFocusCleared() { selectedRef.current = ""; setSelected(""); },
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
        world.current?.render(now / 1000, 0, remainder / STEP, advanced);
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
  const focused = state?.sessions.find(member => member.id === selected);
  return <main className="observer">
    <header><strong>agentcorp <span>· Live sessions</span></strong><span>Read-only · This session + enrolled descendants</span></header>
    <div className="observer-layout">
      <section className="world-host" ref={host} aria-label="AgentCorp 3D office">
        <div className="world-callout" role="status">{sceneError || error || (state
          ? `${state.sessions.filter(member => member.present).length} live · ${state.sessions.length} enrolled · up to 16 desks`
          : "Connecting to this session…")}</div>
      </section>
      <aside aria-label="Enrolled sessions">
        <h2>Office roster</h2>
        <p>Only sessions explicitly linked to this root appear here. An offline session has no current heartbeat; it is not shown as working.</p>
        {state?.sessions.map((member, index) => <button key={member.id} type="button"
          className={selected === member.id ? "selected" : ""}
          onClick={() => {
            if (!member.present) return;
            selectedRef.current = member.id; setSelected(member.id);
            world.current?.focusAgent(index);
          }} disabled={!member.present}>
          <span>{agentName(member.id)} {index === 0 ? "· root" : `· desk ${index + 1}`}</span>
          <small>{member.phase}</small>
        </button>)}
        {focused && <div className="observer-focus">{agentName(focused.id)} · {focused.phase}<br />
          <small>Observation only. Manage this session in its Copilot conversation.</small></div>}
        <p>App-created children need explicit enrollment via the <code>add_descendant</code> canvas action. No repository-wide discovery.</p>
      </aside>
    </div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Office />);
