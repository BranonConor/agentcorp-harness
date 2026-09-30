import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SafeMarkdown } from "../agent-inc-live/src/markdown.js";

const render = (content: string) => renderToStaticMarkup(createElement(SafeMarkdown, { content }));

test("renders streamed and persisted GFM headings, lists, code fences and safe links", () => {
  const content = "# Summary\n\n- one\n- two\n\n```ts\nconst a = 1;\n```\n\n[Docs](https://docs.github.com/copilot)";
  const html = render(content);
  assert.match(html, /<h1>Summary<\/h1>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<pre><code class="language-ts">const a = 1;/);
  assert.match(html, /href="https:\/\/docs.github.com\/copilot"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.equal(render(content), html);
  assert.match(render("```ts\nconst stillStreaming"), /<pre><code class="language-ts">const stillStreaming/);
});

test("does not render raw HTML or clickable dangerous links", () => {
  const html = render('<script>alert("x")</script>\n\n[unsafe](javascript:alert(1)) [also unsafe](//evil.example/x) [safe](https://example.com)');
  assert.doesNotMatch(html, /<script|javascript:|href="\/\/evil/);
  assert.match(html, /<span>unsafe<\/span>/);
  assert.match(html, /href="https:\/\/example.com"/);
});
