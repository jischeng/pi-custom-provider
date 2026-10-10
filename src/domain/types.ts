// Types for pi-custom-provider — imports from pi, only extension-specific types here
import type { Api, KnownApi, KnownProvider, Model } from "@earendil-works/pi-ai";

// ─── API-type predicates ─────────────────────────────────────────

/** APIs using Authorization: Bearer header (= OpenAI-compatible subset) */
export function usesAuthHeader(api: KnownApi): boolean {
  return api.startsWith("openai") || api === "mistral-conversations";
}

// ─── models.json config types ────────────────────────────────────

export interface ModelConfig
  extends Partial<
    Pick<
      Model<Api>,
      "baseUrl" | "reasoning" | "thinkingLevelMap" | "input" | "contextWindow" | "maxTokens" | "cost" | "headers"
    >
  > {
  id: string;
  name?: string;
  api?: KnownApi;
  compat?: Record<string, unknown>;
  /** Pi passes these to the provider request; it is an extensible object, so it is preserved as-is. */
  samplingParams?: Record<string, unknown>;
}

/**
 * A patch Pi applies on top of a built-in model (`modelOverrides` in models.json). It is the
 * topmost user layer, so it changes only what it names and keeps Pi's own metadata otherwise.
 */
export interface ModelOverride
  extends Partial<
    Pick<
      Model<Api>,
      "name" | "reasoning" | "thinkingLevelMap" | "input" | "contextWindow" | "maxTokens" | "cost" | "headers"
    >
  > {
  compat?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
}

export interface ProviderConfig {
  name?: string;
  baseUrl: string;
  api: KnownApi;
  apiKey?: string;
  authMode?: "none" | "api_key" | "oauth";
  /** Stable storage binding; never expose this as a credential value. */
  credentialId?: string;
  /** Plugin-owned OAuth flow. Do not use models.json's built-in `oauth` field; Pi only accepts it for Radius. */
  oauthProvider?: KnownProvider;
  /** Optional OAuth credential JSON path. Empty means use the provider ID's stored Pi OAuth credential. */
  oauthJsonPath?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  /** Per-model patches for a provider Pi already ships. Only this field is written for them. */
  modelOverrides?: Record<string, ModelOverride>;
  models: ModelConfig[];
}

export interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
}

/**
 * A record Pi accepts for a provider it already ships may contain only patches. Its endpoint,
 * API and model list come from Pi, so the extension must neither register nor rewrite them.
 */
export const isOverrideRecord = (provider: Partial<ProviderConfig> | undefined): boolean =>
  !!provider && !provider.models?.length && !provider.baseUrl && !provider.api;

// ─── Extension-specific ──────────────────────────────────────────

/** A discovered model: same as ModelConfig but with name guaranteed */
export interface DiscoveredModel extends ModelConfig {
  name: string;
  /** How this candidate was found. Discovery-only; never written to models.json. */
  suggestedBy?: "api" | "model-id" | "base-url";
}
