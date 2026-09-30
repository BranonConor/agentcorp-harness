import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshot } from "./observations.mjs";

const viewer = resolve(dirname(fileURLToPath(import.meta.url)), "viewer");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

export async function startServer(root) {
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
      const target = resolve(viewer, `.${path === "/" ? "/observe.html" : path}`);
      if (!target.startsWith(viewer + sep)) { response.writeHead(404); response.end(); return; }
      const body = await readFile(target);
      response.writeHead(200, { "Content-Type": mime[extname(target)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff" });
      response.end(body);
    } catch (error) {
      if (error?.code === "ENOENT") { response.writeHead(404); response.end("Build the viewer with npm run package:observer."); return; }
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
