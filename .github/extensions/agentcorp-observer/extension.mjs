import { randomUUID } from "node:crypto";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { clearHeartbeat, enroll, heartbeat, snapshot, validId } from "./observations.mjs";
import { startServer } from "./viewer-server.mjs";

const owner = randomUUID();
const servers = new Map();
let phase = "idle";
let writing = Promise.resolve();
let enrolling = Promise.resolve();
let stopped = false;

const session = await joinSession({
  canvases: [createCanvas({
    id: "agentcorp-observer",
    displayName: "AgentCorp · Live sessions",
    description: "Read-only 3D office for this Copilot CLI session and explicitly enrolled descendants.",
    actions: [{
      name: "add_descendant",
      description: "Enroll a known App-created child session under this canvas root or an already enrolled parent; never infer kinship from repository or branch.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["sessionId"],
        properties: { sessionId: { type: "string" }, parentSessionId: { type: "string" } },
      },
      handler: async ({ sessionId, input }) => {
        try {
          const child = validId(input.sessionId);
          const parent = input.parentSessionId === undefined ? sessionId : validId(input.parentSessionId);
          const next = enrolling.then(() => enroll(sessionId, parent, child));
          enrolling = next.catch(() => {});
          await next;
          return await snapshot(sessionId);
        } catch (error) {
          throw new CanvasError("enrollment_failed", error instanceof Error ? error.message : String(error));
        }
      },
    }],
    open: async ({ instanceId, sessionId }) => {
      let entry = servers.get(instanceId);
      if (!entry) {
        entry = await startServer(sessionId);
        servers.set(instanceId, entry);
      }
      return { title: "AgentCorp · Live sessions", url: entry.url };
    },
    onClose: async ({ instanceId }) => {
      const entry = servers.get(instanceId);
      if (entry) {
        servers.delete(instanceId);
        await new Promise((done, reject) => entry.server.close(error => error ? reject(error) : done()));
      }
    },
  })],
});

const id = validId(session.sessionId);
function publish(next) {
  phase = next;
  writing = writing.then(() => heartbeat(id, phase, owner)).catch(error => {
    console.error("AgentCorp heartbeat failed:", error);
  });
}
publish("idle");
const timer = setInterval(() => publish(phase), 10_000);
timer.unref();
for (const [event, next] of [
  ["user.message", "thinking"],
  ["assistant.turn_start", "thinking"],
  ["tool.execution_start", "tool"],
  ["tool.execution_complete", "thinking"],
  ["permission.requested", "blocked"],
  ["permission.completed", "thinking"],
  ["assistant.turn_end", "idle"],
  ["session.idle", "idle"],
  ["session.error", "offline"],
]) session.on(event, () => publish(next));

async function shutdown() {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  await writing;
  await clearHeartbeat(id, owner);
  await Promise.all([...servers.values()].map(entry => new Promise(done => entry.server.close(done))));
}
process.on("SIGTERM", () => { void shutdown().catch(error => console.error("AgentCorp shutdown failed:", error)); });
process.on("SIGINT", () => { void shutdown().catch(error => console.error("AgentCorp shutdown failed:", error)); });
