// Real provider bindings (Anthropic, OpenAI, Google). Off unless explicitly enabled.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createGuardedFetch, type ExchangeRecord, type FetchLike } from "./guarded-fetch.ts";

export type RealProviderId = "anthropic" | "openai" | "google";

export interface ProviderBinding {
  id: RealProviderId;

  pkg: string;
  baseUrl: string;
  allowedHosts: string[];
  allowedHeaderNames: string[];

  secretName: string;
}

export const PROVIDER_BINDINGS: Readonly<Record<RealProviderId, ProviderBinding>> = {
  anthropic: {
    id: "anthropic",
    pkg: "@ai-sdk/anthropic@4.0.82",
    baseUrl: "https://api.anthropic.com/v1",
    allowedHosts: ["api.anthropic.com"],
    allowedHeaderNames: ["x-api-key", "anthropic-version", "anthropic-beta", "content-type", "accept"],
    secretName: "ANTHROPIC_API_KEY",
  },
  openai: {
    id: "openai",
    pkg: "@ai-sdk/openai@4.0.96",
    baseUrl: "https://api.openai.com/v1",
    allowedHosts: ["api.openai.com"],
    allowedHeaderNames: ["authorization", "content-type", "accept"],
    secretName: "OPENAI_API_KEY",
  },
  google: {
    id: "google",
    pkg: "@ai-sdk/google@4.0.99",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    allowedHosts: ["generativelanguage.googleapis.com"],
    allowedHeaderNames: ["x-goog-api-key", "content-type", "accept"],
    secretName: "GOOGLE_GENERATIVE_AI_API_KEY",
  },
};

export interface SecretSource {
  get(name: string): Promise<string | null>;
}

export interface RealProviderOptions {
  enabled: boolean;
  secrets: SecretSource;
  userAgent?: string;
  onExchange?: (e: ExchangeRecord) => void;

  fetchImpl?: FetchLike;
}

export type RealModelResult =
  | { ok: true; model: LanguageModelV4 }
  | { ok: false; code: "real_calls_disabled" | "unknown_provider" | "secret_missing" };

export function isRealProvider(id: string): id is RealProviderId {
  return id === "anthropic" || id === "openai" || id === "google";
}

export async function createRealLanguageModel(provider: string, modelId: string, opts: RealProviderOptions): Promise<RealModelResult> {
  if (!opts.enabled) return { ok: false, code: "real_calls_disabled" };
  if (!isRealProvider(provider)) return { ok: false, code: "unknown_provider" };
  const b = PROVIDER_BINDINGS[provider];
  const apiKey = await opts.secrets.get(b.secretName);
  if (apiKey === null || apiKey === "") return { ok: false, code: "secret_missing" };
  const fetch = createGuardedFetch({
    name: b.id,
    allowedHosts: b.allowedHosts,
    allowedHeaderNames: b.allowedHeaderNames,
    ...(opts.userAgent !== undefined ? { userAgent: opts.userAgent } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.onExchange !== undefined ? { onExchange: opts.onExchange } : {}),
  });
  switch (provider) {
    case "anthropic":
      return { ok: true, model: createAnthropic({ apiKey, baseURL: b.baseUrl, fetch }).languageModel(modelId) };
    case "openai":
      return { ok: true, model: createOpenAI({ apiKey, baseURL: b.baseUrl, fetch }).languageModel(modelId) };
    case "google":
      return { ok: true, model: createGoogle({ apiKey, baseURL: b.baseUrl, fetch }).languageModel(modelId) };
  }
}

export const NO_SECRETS: SecretSource = { get: async () => null };
