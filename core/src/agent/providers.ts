/**
 * Model providers — where the "brain" runs.
 *
 * BEGINNER MAP
 * ------------
 * OpenRouter, Groq and Ollama all offer the same OpenAI-style API, so one
 * class (ChatOpenAI) talks to all of them; only the URL, key and model name
 * change. Settings pick the startup provider (LUNA_PROVIDER); the web UI can
 * switch at runtime by rebuilding the agent with makeModel(...) (see
 * builder.assembleAgent and web/server.ts AgentHost).
 *
 *   openrouter  many hosted models, needs LUNA_OPENROUTER_API_KEY
 *   groq        very fast hosted models, needs LUNA_GROQ_API_KEY
 *   ollama      models on your own machine, no key (run `ollama serve`)
 */

import { ChatOpenAI } from "@langchain/openai";

import type { Settings } from "../config/settings.ts";

/** One OpenAI-compatible model host and where its settings live. */
export interface Provider {
  id: string;
  label: string;
  /** Settings field holding the API key; null = no key needed. */
  keyField: keyof Settings | null;
  /** Settings field holding the default model. */
  modelField: keyof Settings;
  /** For error messages. */
  envKey: string;
}

const HOSTED_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
};

export const PROVIDERS: Record<string, Provider> = {
  openrouter: { id: "openrouter", label: "OpenRouter", keyField: "openrouter_api_key", modelField: "model_name", envKey: "LUNA_OPENROUTER_API_KEY" },
  groq: { id: "groq", label: "Groq", keyField: "groq_api_key", modelField: "groq_model", envKey: "LUNA_GROQ_API_KEY" },
  ollama: { id: "ollama", label: "Ollama", keyField: null, modelField: "ollama_model", envKey: "LUNA_OLLAMA_BASE_URL" },
};

/** The provider's OpenAI-compatible API URL. */
export function baseUrl(p: Provider, settings: Settings): string {
  if (p.id === "ollama") return settings.ollama_base_url.replace(/\/+$/, "");
  return HOSTED_URLS[p.id];
}

/** The API key from settings (a dummy one for Ollama). */
export function apiKey(p: Provider, settings: Settings): string | null {
  if (p.keyField === null) return "ollama"; // the OpenAI client insists on some key; Ollama ignores it
  return (settings[p.keyField] as string | null) ?? null;
}

/** The model to use when none is chosen. */
export function defaultModel(p: Provider, settings: Settings): string {
  return settings[p.modelField] as string;
}

/** True when the provider can be used (it has a key). */
export function configured(p: Provider, settings: Settings): boolean {
  return Boolean(apiKey(p, settings));
}

/** The Provider for `providerId`; throws if unknown. */
export function getProvider(providerId: string): Provider {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error(`Unknown provider '${providerId}'. Use one of: ${Object.keys(PROVIDERS).join(", ")}`);
  return p;
}

/**
 * Chat model for `provider` (default: settings.provider) and `model`
 * (default: that provider's model from settings).
 *
 * `maxRetries` comes from settings (default 1, the OpenAI client's is 2):
 * on a rate-limited free tier each retry is one more request against the limit.
 */
export function makeModel(settings: Settings, provider?: string | null, model?: string | null): ChatOpenAI {
  const p = getProvider(provider || settings.provider);
  if (!configured(p, settings)) throw new Error(`Set ${p.envKey} in your .env file to use ${p.label}.`);
  return new ChatOpenAI({
    model: model || defaultModel(p, settings),
    apiKey: apiKey(p, settings)!,
    maxRetries: settings.model_max_retries,
    configuration: { baseURL: baseUrl(p, settings) },
  });
}

export interface ProviderInfo {
  id: string;
  label: string;
  configured: boolean;
  default_model: string;
}

/** What the UI shows in its model switcher. */
export function describeProviders(settings: Settings): ProviderInfo[] {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    configured: configured(p, settings),
    default_model: defaultModel(p, settings),
  }));
}

/** Model ids the provider offers (GET /models). Throws on network/auth errors. */
export async function listModels(settings: Settings, provider: string, timeoutMs = 6000): Promise<string[]> {
  const p = getProvider(provider);
  if (!configured(p, settings)) throw new Error(`Set ${p.envKey} in your .env file to use ${p.label}.`);
  const response = await fetch(`${baseUrl(p, settings)}/models`, {
    headers: { Authorization: `Bearer ${apiKey(p, settings)}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${p.label}`);
  const body = (await response.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)).sort();
}
