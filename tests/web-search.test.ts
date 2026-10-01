import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSearch } from "../server/web-search.js";

const fixture = { web: { results: [
  { title: "Example", url: "https://example.com/article", description: "Useful result", page_age: "2026-09-30T12:00:00Z" },
  { title: "Other", url: "https://example.org/", description: "Another result" }
] } };

test("disabled or misconfigured search does not advertise a callable tool", () => {
  const off = new WebSearch({});
  assert.equal(off.tool(), undefined);
  assert.equal(off.capability.provider, "none");
  const missing = new WebSearch({ provider: "brave" });
  assert.equal(missing.tool(), undefined);
  assert.match(missing.capability.reason, /AGENTCORP_BRAVE_API_KEY/);
  assert.throws(() => new WebSearch({ provider: "unknown", key: "secret" }), /AGENTCORP_SEARCH_PROVIDER/);
});

test("search tool returns bounded sources with a real date or null and no credential", async () => {
  let calls = 0;
  const search = new WebSearch({ provider: "brave", key: "private-key" }, async (url, options) => {
    calls++;
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.origin, "https://api.search.brave.com");
    assert.equal(requestUrl.searchParams.get("q"), "release notes");
    assert.equal(requestUrl.searchParams.get("count"), "5");
    assert.equal(new Headers(options?.headers).get("X-Subscription-Token"), "private-key");
    assert.ok(options?.signal);
    return Response.json(fixture);
  }, () => 10_000);
  const tool = search.tool()!;
  assert.equal(tool.name, "search_web");
  assert.equal(tool.defer, "never");
  assert.equal(tool.skipPermission, true);
  const output = await tool.handler!({ query: "release notes" }, {} as never);
  assert.deepEqual(JSON.parse(String(output)), { provider: "brave", results: [
    { title: "Example", url: "https://example.com/article", snippet: "Useful result", date: "2026-09-30T12:00:00Z" },
    { title: "Other", url: "https://example.org/", snippet: "Another result", date: null }
  ] });
  assert.equal(String(output).includes("private-key"), false);
  await assert.rejects(search.search("another"), /throttled/);
  assert.equal(calls, 1);
});

test("rate and request caps apply across calls without network retries", async () => {
  let time = 5_000;
  let calls = 0;
  const search = new WebSearch({ provider: "brave", key: "key" }, async () => {
    calls++;
    return Response.json({ web: { results: [] } });
  }, () => time);
  for (let i = 0; i < 50; i++) {
    time += 2_000;
    await search.search("valid");
  }
  await assert.rejects(search.search("valid"), /50 requests/);
  assert.equal(calls, 50);
  await assert.rejects(search.search("bad\nquery"), /control characters/);
});

test("provider failure, malformed data, and unsafe URLs are errors, never empty success", async () => {
  for (const [response, message] of [
    [new Response("private provider details", { status: 429 }), /HTTP 429/],
    [new Response("not json"), /invalid JSON/],
    [Response.json({ web: {} }), /unexpected result format/],
    [Response.json({ web: { results: [{ title: "Bad", url: "javascript:alert(1)", description: "No" }] } }), /unsafe source URL/]
  ] as const) {
    const search = new WebSearch({ provider: "brave", key: "key" }, async () => response, () => 5_000);
    await assert.rejects(search.search("query"), message);
  }
  const offline = new WebSearch({ provider: "brave", key: "key" }, async () => {
    throw new Error("private-key");
  }, () => 5_000);
  await assert.rejects(offline.search("query"), error => {
    assert.equal((error as Error).message.includes("private-key"), false);
    return true;
  });
});

test("search rejects an oversized provider response rather than exposing partial results", async () => {
  const search = new WebSearch({ provider: "brave", key: "key" },
    async () => new Response("x".repeat(256 * 1024 + 1)), () => 5_000);
  await assert.rejects(search.search("query"), /exceeds 256 KiB/);
});
