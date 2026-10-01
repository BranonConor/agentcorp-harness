import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import { sessionModel, validateProfile } from "../server/providers.js";

test("unsigned SDK session streams an OpenAI-compatible local model response", { timeout: 45_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agentcorp-unsigned-sdk-"));
  const requests: string[] = [];
  const mock = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1,
      model: "qwen2.5:7b", choices: [{ index: 0, delta: { role: "assistant", content: "Local model ready" } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1,
      model: "qwen2.5:7b", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    response.end();
  });
  const client = new CopilotClient({ workingDirectory: workspace, baseDirectory: join(workspace, "copilot-home"),
    useLoggedInUser: false, mode: "empty", logLevel: "none" });
  try {
    await new Promise<void>(resolve => mock.listen(0, "127.0.0.1", resolve));
    const address = mock.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not bind to a TCP port.");
    const profile = validateProfile({ id: "local", kind: "ollama", model: "qwen2.5:7b",
      endpoint: `http://127.0.0.1:${address.port}/v1`, maxContextWindowTokens: 32768 });
    await client.start();
    assert.equal((await client.getAuthStatus()).isAuthenticated, false);
    const session = await client.createSession({
      ...sessionModel(profile), workingDirectory: workspace, availableTools: [], streaming: true
    });
    try {
      const completed = new Promise<string>((resolve, reject) => {
        let content = "";
        const off = session.on(event => {
          if (event.type === "assistant.message_delta") content += event.data.deltaContent;
          if (event.type === "session.error") { off(); reject(new Error(event.data.message)); }
          if (event.type === "session.idle") { off(); resolve(content); }
        });
      });
      await session.send({ prompt: "Say hello" });
      assert.equal(await completed, "Local model ready");
      assert.equal(requests.length, 1);
      assert.equal(JSON.parse(requests[0]).model, "qwen2.5:7b");
    } finally {
      await session.disconnect();
    }
  } finally {
    await client.stop();
    await new Promise<void>(resolve => mock.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  }
});
