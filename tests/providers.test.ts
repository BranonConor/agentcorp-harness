import assert from "node:assert/strict";
import { test } from "node:test";
import { COPILOT_PROFILE, safeProviderError, sessionModel, validateProfile } from "../server/providers.js";

test("Copilot account remains auto and supports explicit account models", () => {
  assert.deepEqual(sessionModel(COPILOT_PROFILE), { model: "auto" });
  assert.deepEqual(sessionModel(validateProfile({ id: "account-sonnet", kind: "copilot", model: "claude-sonnet-5" })),
    { model: "claude-sonnet-5" });
});

test("OpenAI-compatible, Anthropic, Azure and local Ollama map to SDK provider config without persisting credentials", () => {
  const fixtures = [
    { id: "openai", kind: "openai", endpoint: "https://api.example.com/v1", credentialEnv: "OPENAI_TEST_KEY",
      model: "gpt-4o", wireApi: "responses", wireModel: "deployment", maxPromptTokens: 8192 },
    { id: "anthropic", kind: "anthropic", endpoint: "https://api.anthropic.example", credentialEnv: "ANTHROPIC_TEST_KEY",
      model: "claude-sonnet-4" },
    { id: "azure", kind: "azure", endpoint: "https://azure.example/openai", credentialEnv: "AZURE_TEST_KEY",
      model: "gpt-4o", azureApiVersion: "2024-10-21" },
    { id: "ollama", kind: "ollama", endpoint: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" }
  ] as const;
  const env = { OPENAI_TEST_KEY: "mock-openai-secret", ANTHROPIC_TEST_KEY: "mock-anthropic-secret",
    AZURE_TEST_KEY: "mock-azure-secret" };
  for (const input of fixtures) {
    const profile = validateProfile(input);
    assert.ok(!JSON.stringify(profile).includes("mock-"));
    const config = sessionModel(profile, env);
    assert.equal(config.model, input.model);
    assert.equal(config.provider?.type, input.kind === "ollama" ? "openai" : input.kind);
    assert.equal(config.provider?.apiKey, "credentialEnv" in input ? env[input.credentialEnv as keyof typeof env] : undefined);
    assert.equal(config.provider?.baseUrl, input.endpoint);
  }
  assert.equal(sessionModel(validateProfile(fixtures[0]), env).provider?.wireApi, "responses");
  assert.equal(sessionModel(validateProfile(fixtures[2]), env).provider?.azure?.apiVersion, "2024-10-21");
  assert.equal(sessionModel(validateProfile(fixtures[3]), env).provider?.apiKey, undefined);
  const capabilities = sessionModel(validateProfile({ ...fixtures[3], maxContextWindowTokens: 32768,
    supportsVision: false, supportsReasoningEffort: true }), env).modelCapabilities;
  assert.deepEqual(capabilities, { supports: { vision: false, reasoningEffort: true },
    limits: { max_context_window_tokens: 32768 } });
});

test("invalid or unavailable providers fail explicitly and never include credential values in errors", () => {
  const profile = validateProfile({ id: "external", kind: "openai", model: "gpt-4o",
    endpoint: "https://api.example.com/v1", credentialEnv: "MISSING_TEST_KEY" });
  assert.throws(() => sessionModel(profile, {}), /requires environment variable MISSING_TEST_KEY/);
  for (const endpoint of ["http://api.example.com/v1", "https://token:secret@api.example.com/v1",
    "https://api.example.com/v1?api_key=secret", "file:///tmp/model"]) {
    assert.throws(() => validateProfile({ ...profile, endpoint }), /endpoint/);
  }
  assert.throws(() => validateProfile({ ...profile, apiKey: "secret" }), /Invalid model profile/);
  assert.throws(() => validateProfile({ ...profile, credentialEnv: "literal-value" }), /environment variable/);
  assert.equal(safeProviderError(new Error("oops mock-provider-secret"), { EXTERNAL_CREDENTIAL: "mock-provider-secret" }),
    "oops [redacted]");
});
