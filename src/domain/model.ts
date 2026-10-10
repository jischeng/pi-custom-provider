import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelConfig, ProviderConfig } from "./types";

/**
 * Pi's model shape, reduced to the fields the configuration stores and the terminal UI edits.
 * Pi models carry a `provider` field the stored form does not have, so the reduction is not optional.
 */
export function modelConfigFromPi(model: Model<Api>): ModelConfig {
  const {
    id,
    name,
    api,
    baseUrl,
    reasoning,
    input,
    contextWindow,
    maxTokens,
    cost,
    thinkingLevelMap,
    compat,
    samplingParams,
    headers,
  } = model as any;
  return {
    id,
    name,
    api,
    baseUrl,
    reasoning,
    input,
    contextWindow,
    maxTokens,
    cost,
    thinkingLevelMap,
    compat,
    samplingParams,
    headers,
  };
}

/**
 * The model Pi actually runs: every unset field resolved to the value the runtime uses.
 * The terminal UI renders these same values, so "unset" can never mean two different things
 * in the runtime and on screen.
 */
export function resolveModel(id: string, provider: ProviderConfig, model: ModelConfig): Model<Api> {
  return {
    id: model.id,
    name: model.name || model.id,
    provider: id,
    api: model.api || provider.api,
    baseUrl: model.baseUrl || provider.baseUrl,
    reasoning: model.reasoning || false,
    input: model.input || ["text"],
    contextWindow: model.contextWindow || 128000,
    maxTokens: model.maxTokens || 16384,
    cost: model.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinkingLevelMap: model.thinkingLevelMap,
    compat: { ...provider.compat, ...model.compat },
  };
}
