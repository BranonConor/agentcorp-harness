import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { resolve, join, extname, dirname, parse } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { FileStore } from "./storage.js";
import { SdkAdapter } from "./sdk.js";
import { RoomController } from "./room.js";

const args = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
};
if (!value("--workspace") || args.some(arg => arg.startsWith("--") && !["--workspace", "--port", "--state"].includes(arg))) {
  throw new Error("Pass a dedicated directory: npm run dev -- --workspace ./sandbox [--port 4173] [--state .local/state.json]");
}
const selected = resolve(value("--workspace")!);
const workspace = await (async () => {
  await mkdir(selected, { recursive: true });
  const path = await realpath(selected);
  if (path === homedir() || path === parse(path).root || path === process.cwd()) throw new Error("Choose a dedicated directory, not home, root, or this repository.");
  const entries = await readdir(path);
  if (entries.length && !entries.includes(".deskbound-workspace")) throw new Error("Workspace must be empty or already marked as a Deskbound workspace.");
  if (!entries.length) await writeFile(join(path, ".deskbound-workspace"), "Deskbound dedicated working directory\n", { flag: "wx" });
  return path;
})();
const port = Number(value("--port") ?? "4173");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be 1–65535.");
const root = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(root, "../dist");
const room = await RoomController.open(new SdkAdapter(workspace), new FileStore(resolve(value("--state") ?? resolve(root, "../.local/state.json"))), workspace);
const token = randomBytes(32).toString("hex");
const origin = `http://127.0.0.1:${port}`;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}
async function payload(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"] !== "application/json") throw new Error("Expected application/json.");
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 50_000) throw new Error("Request too large.");
  }
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object.");
  return parsed as Record<string, unknown>;
}
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon"
};
const server = createServer(async (request, response) => {
  try {
    if (request.headers.host !== `127.0.0.1:${port}`) return json(response, 403, { error: "Use the printed loopback URL." });
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/" && request.method === "GET") {
      response.setHeader("Set-Cookie", `deskbound=${token}; HttpOnly; SameSite=Strict; Path=/`);
    }
    if (url.pathname.startsWith("/api/")) {
      const cookies = request.headers.cookie?.split(";").map(item => item.trim()) ?? [];
      if (!cookies.includes(`deskbound=${token}`)) return json(response, 403, { error: "Open the app at the printed URL first." });
      if (request.method === "POST" && request.headers.origin !== origin) return json(response, 403, { error: "Invalid request origin." });
      if (url.pathname === "/api/events" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive", "X-Accel-Buffering": "no"
        });
        const unsubscribe = room.subscribe(state => response.write(`data: ${JSON.stringify(state)}\n\n`));
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20_000);
        request.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
        return;
      }
      if (url.pathname === "/api/state" && request.method === "GET") return json(response, 200, room.state);
      if (url.pathname === "/api/create" && request.method === "POST") {
        const body = await payload(request);
        if (!Number.isInteger(body.deskIndex)) throw new Error("Choose an empty desk.");
        await room.create(body.deskIndex as number);
        return json(response, 200, room.state);
      }
      if (url.pathname === "/api/send" && request.method === "POST") {
        const body = await payload(request);
        if (typeof body.prompt !== "string" || typeof body.agentId !== "string") throw new Error("Choose an agent and a text prompt.");
        await room.send(body.agentId, body.prompt);
        return json(response, 200, room.state);
      }
      if (url.pathname === "/api/decision" && request.method === "POST") {
        const body = await payload(request);
        if (typeof body.id !== "string" || typeof body.agentId !== "string" || typeof body.allow !== "boolean") throw new Error("Invalid permission decision.");
        room.decide(body.agentId, body.id, body.allow);
        return json(response, 200, room.state);
      }
      if (url.pathname === "/api/retry" && request.method === "POST") {
        await payload(request);
        await room.connect();
        return json(response, 200, room.state);
      }
      if (url.pathname === "/api/archive" && request.method === "POST") {
        const body = await payload(request);
        if (typeof body.agentId !== "string") throw new Error("Choose an agent to archive.");
        await room.archive(body.agentId);
        return json(response, 200, room.state);
      }
      if (url.pathname === "/api/restore" && request.method === "POST") {
        const body = await payload(request);
        if (typeof body.agentId !== "string") throw new Error("Choose an agent to restore.");
        await room.restore(body.agentId);
        return json(response, 200, room.state);
      }
      if (url.pathname === "/api/send-home" && request.method === "POST") {
        const body = await payload(request);
        if (typeof body.agentId !== "string" || body.confirmedAgentId !== body.agentId) {
          throw new Error("Explicit confirmation for this agent is required.");
        }
        await room.sendHome(body.agentId);
        return json(response, 200, room.state);
      }
      if (url.pathname === "/api/repository" && request.method === "POST") {
        const body = await payload(request);
        if (typeof body.agentId !== "string" || !(body.path === null || typeof body.path === "string")) throw new Error("Choose an agent and an absolute repository path, or null to revoke.");
        await room.setRepository(body.agentId, body.path);
        return json(response, 200, room.state);
      }
      if (url.pathname === "/api/stop" && request.method === "POST") {
        const body = await payload(request);
        if (typeof body.agentId !== "string") throw new Error("Choose an agent to stop.");
        await room.stop(body.agentId);
        return json(response, 200, room.state);
      }
      return json(response, 404, { error: "Unknown API route." });
    }
    if (request.method !== "GET" || url.pathname.includes("..")) return json(response, 404, { error: "Not found." });
    const file = resolve(staticDir, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!file.startsWith(staticDir + "/")) return json(response, 404, { error: "Not found." });
    try {
      const data = await readFile(file);
      response.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff" });
      response.end(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return json(response, 404, { error: "Not found." });
      throw error;
    }
  } catch (error) {
    console.error("Request failed:", error);
    json(response, error instanceof SyntaxError ? 400 : 422, { error: error instanceof Error ? error.message : String(error) });
  }
});
server.listen(port, "127.0.0.1", () => console.log(`AgentCorp SDK office: ${origin}\nTool workspace: ${workspace}`));
void room.connect().catch(error => console.error("SDK connection:", error));
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  try { await room.close(); } catch (error) { console.error("Shutdown:", error); process.exitCode = 1; }
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
