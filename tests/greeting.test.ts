import assert from "node:assert/strict";
import { test } from "node:test";
import { greetingForPersona } from "../agent-inc-live/src/greeting.js";
import { MAX_AGENTS } from "../server/types.js";

test("each office persona has a stable, distinct local greeting", () => {
  const greetings = Array.from({ length: MAX_AGENTS }, (_, persona) => greetingForPersona(persona));
  assert.equal(new Set(greetings).size, MAX_AGENTS);
  for (let persona = 0; persona < MAX_AGENTS; persona++) {
    assert.equal(greetingForPersona(persona), greetings[persona]);
  }
});
