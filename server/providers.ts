import type { ProviderConfig, SessionConfigBase } from "@github/copilot-sdk";

export type ModelProfile = {
  id: string;
  kind: "copilot" | "openai" | "ollama" | "anthropic" | "azure";
  model: string;
  endpoint?: string;
  wireApi?: "completions" | "responses";
  credentialEnv?: string;
  wireModel?: string;
  azureApiVersion?: string;
  maxPromptTokens?: number;
  maxOutputTokens?: number;
  maxContextWindowTokens?: number;
  supportsVision?: boolean;
  supportsReasoningEffort?: boolean;
};

export const COPILOT_PROFILE: ModelProfile = { id: "copilot", kind: "copilot", model: "auto" };
const kinds = ["copilot", "openai", "ollama", "anthropic", "azure"];
const fields = new Set(["id", "kind", "model", "endpoint", "wireApi", "credentialEnv",
  "wireModel", "azureApiVersion", "maxPromptTokens", "maxOutputTokens",
  "maxContextWindowTokens", "supportsVision", "supportsReasoningEffort"]);

export function validateProfile(input: unknown): ModelProfile {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid model profile.");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !fields.has(key)) ||
    typeof value.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value.id) ||
    !kinds.includes(String(value.kind)) || typeof value.model !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value.model)) throw new Error("Invalid model profile fields.");
  const profile = value as ModelProfile;
  if (profile.kind === "copilot") {
    if (Object.keys(value).some(key => !["id", "kind", "model"].includes(key)) ||
      (profile.id === "copilot" && profile.model !== "auto")) {
      throw new Error("Copilot profiles have only an ID and model; the built-in default is immutable.");
    }
    return profile.id === "copilot" ? COPILOT_PROFILE : { ...profile };
  }
  if (profile.id === "copilot" || typeof profile.endpoint !== "string" ||
    typeof profile.credentialEnv !== "string" && profile.credentialEnv !== undefined ||
    (profile.kind !== "ollama" && !profile.credentialEnv) ||
    (profile.credentialEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(profile.credentialEnv)) ||
    (profile.wireApi !== undefined && !["completions", "responses"].includes(profile.wireApi)) ||
    ((profile.kind === "anthropic" || profile.kind === "ollama") && profile.wireApi !== undefined) ||
    (profile.wireModel !== undefined && (typeof profile.wireModel !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(profile.wireModel))) ||
    (profile.azureApiVersion !== undefined && (profile.kind !== "azure" ||
      typeof profile.azureApiVersion !== "string" || !/^\d{4}-\d{2}-\d{2}(-preview)?$/.test(profile.azureApiVersion))) ||
    (profile.maxPromptTokens !== undefined && (!Number.isSafeInteger(profile.maxPromptTokens) || profile.maxPromptTokens < 1024)) ||
    (profile.maxOutputTokens !== undefined && (!Number.isSafeInteger(profile.maxOutputTokens) || profile.maxOutputTokens < 1)) ||
    (profile.maxContextWindowTokens !== undefined && (!Number.isSafeInteger(profile.maxContextWindowTokens) || profile.maxContextWindowTokens < 1024)) ||
    (profile.supportsVision !== undefined && typeof profile.supportsVision !== "boolean") ||
    (profile.supportsReasoningEffort !== undefined && typeof profile.supportsReasoningEffort !== "boolean")) {
    throw new Error("Invalid provider options; credentials must be referenced by environment variable name.");
  }
  let url: URL;
  try { url = new URL(profile.endpoint); } catch { throw new Error("Invalid provider endpoint URL."); }
  const local = profile.kind === "ollama" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if ((local ? url.protocol !== "http:" && url.protocol !== "https:" : url.protocol !== "https:") ||
    (profile.kind === "ollama" && !local) || url.username || url.password || url.search || url.hash) {
    throw new Error("Provider endpoint must use HTTPS (Ollama: local loopback HTTP allowed), without credentials, query or fragment.");
  }
  return { ...profile, endpoint: url.toString().replace(/\/$/, "") };
}

export function sessionModel(profile: ModelProfile, env: NodeJS.ProcessEnv = process.env): Pick<SessionConfigBase, "model" | "provider" | "modelCapabilities"> {
  const verified = validateProfile(profile);
  if (verified.kind === "copilot") return { model: verified.model };
  const key = verified.credentialEnv ? env[verified.credentialEnv] : undefined;
  if (verified.credentialEnv && !key) throw new Error(`Model profile ${verified.id} requires environment variable ${verified.credentialEnv}.`);
  const provider: ProviderConfig = {
    type: verified.kind === "ollama" ? "openai" : verified.kind,
    baseUrl: verified.endpoint!,
    ...(key ? { apiKey: key } : {}),
    ...(verified.kind === "anthropic" || verified.kind === "ollama" ? {} : { wireApi: verified.wireApi ?? "completions" }),
    modelId: verified.model,
    ...(verified.wireModel ? { wireModel: verified.wireModel } : {}),
    ...(verified.azureApiVersion ? { azure: { apiVersion: verified.azureApiVersion } } : {}),
    ...(verified.maxPromptTokens ? { maxPromptTokens: verified.maxPromptTokens } : {}),
    ...(verified.maxOutputTokens ? { maxOutputTokens: verified.maxOutputTokens } : {})
  };
  const modelCapabilities: SessionConfigBase["modelCapabilities"] = {
    ...(verified.supportsVision !== undefined || verified.supportsReasoningEffort !== undefined ?
      { supports: { ...(verified.supportsVision !== undefined ? { vision: verified.supportsVision } : {}),
        ...(verified.supportsReasoningEffort !== undefined ? { reasoningEffort: verified.supportsReasoningEffort } : {}) } } : {}),
    ...(verified.maxContextWindowTokens ? { limits: { max_context_window_tokens: verified.maxContextWindowTokens } } : {})
  };
  return { model: verified.model, provider, ...(Object.keys(modelCapabilities).length ? { modelCapabilities } : {}) };
}

export function safeProviderError(error: unknown, env: NodeJS.ProcessEnv = process.env, credentialNames: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [name, secret] of Object.entries(env)) {
    if (secret && (secret.length >= 12 || credentialNames.includes(name))) {
      message = message.replaceAll(secret, "[redacted]");
    }
  }
  return message;
}
