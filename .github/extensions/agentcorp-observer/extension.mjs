import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { clearHeartbeat, enroll, heartbeat, snapshot, validId } from "./observations.mjs";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist");
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

async function startServer(root) {
  const server = createServer(async (request, response) => {
    try {
      const address = server.address();
      if (!address || typeof address === "string" || request.headers.host !== `127.0.0.1:${address.port}`) {
        response.writeHead(403); response.end(); return;
      }
      if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
      const path = new URL(request.url ?? "/", `http://127.0.0.1:${address.port}`).pathname;
      if (path === "/api/observations") {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify(await snapshot(root)));
        return;
      }
      const target = resolve(dist, `.${path === "/" ? "/observe.html" : path}`);
      if (!target.startsWith(dist + sep)) { response.writeHead(404); response.end(); return; }
      const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
      const body = await readFile(target);
      response.writeHead(200, { "Content-Type": mime[extname(target)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff" });
      response.end(body);
    } catch (error) {
      if (error?.code === "ENOENT") { response.writeHead(404); response.end("Build the viewer with npm run build."); return; }
      console.error("AgentCorp viewer request failed:", error);
      response.writeHead(500); response.end("Office update unavailable.");
    }
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

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
