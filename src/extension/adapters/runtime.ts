import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProvider, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { getApiProvider, registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";
import { isOverrideRecord, type ModelConfig, type ModelsConfig, type ProviderConfig } from "../../domain/types";
import { modelConfigFromPi, resolveModel } from "../../domain/model";
import type { RuntimePort } from "../../domain/ports";
import type { Authentication } from "./authentication";
import { OperationError } from "../../operations/errors";
export type { RuntimePort } from "../../domain/ports";
export function createRuntimeAdapter(
  pi: ExtensionAPI,
  auth: Authentication,
): RuntimePort & { bind(ctx: ExtensionContext): void; initialize(config: ModelsConfig): void } {
  let context: ExtensionContext | undefined;
  const registered = new Set<string>();
  const apply = (config: ModelsConfig) => {
    for (const id of registered)
      if (!Object.hasOwn(config.providers, id)) {
        pi.unregisterProvider(id);
        registered.delete(id);
      }
    for (const [id, p] of Object.entries(config.providers)) {
      // A patch record belongs to a provider Pi composes itself; registering a synthetic one
      // here would replace that provider's endpoint, auth and models.
      if (isOverrideRecord(p)) continue;
      pi.registerProvider(managedProvider(id, p, auth));
      registered.add(id);
    }
  };
  return {
    bind: (ctx) => {
      context = ctx;
    },
    initialize: apply,
    sync: async (config) => {
      apply(config);
      if (context) {
        await context.modelRegistry.refresh();
        if (context.modelRegistry.getError())
          throw new OperationError(
            "RUNTIME_SYNC_FAILED",
            "Pi could not load the new model configuration.",
            undefined,
            true,
          );
      }
    },
    active: () => context?.model,
    busy: () => (context ? !context.isIdle() : false),
    exists: (id) => !!context?.modelRegistry.getProvider(id),
    modelsOf: (id) => context?.modelRegistry.getProvider(id)?.getModels().map(modelConfigFromPi),
  };
}
export function managedProvider(id: string, config: ProviderConfig, auth: Authentication): Provider<Api> {
  const cfg = { ...config, credentialId: config.credentialId || id };
  registerBuiltInApiProviders();
  const baseOAuth = cfg.oauthProvider ? auth.oauthProvider(cfg) : undefined;
  const streams = Object.fromEntries(
    [...new Set([cfg.api, ...cfg.models.map((m) => m.api || cfg.api)])].map((api) => {
      const implementation = baseOAuth || getApiProvider(api);
      if (!implementation) throw new OperationError("UNSUPPORTED_CAPABILITY", "Pi has no implementation for this API.");
      return [api, implementation];
    }),
  );
  const api = createProvider({
    id,
    name: cfg.name || id,
    baseUrl: cfg.baseUrl,
    models: cfg.models.map((m) => resolveModel(id, cfg, m)),
    api: streams,
    auth: {
      apiKey: {
        name: cfg.name || id,
        check: async () => {
          const status = auth.status(id, cfg);
          return status.status === "missing" ? undefined : { type: status.mode === "oauth" ? "oauth" : "api_key" };
        },
        resolve: async () => auth.resolve(id, cfg),
      },
    },
  });
  const requestModel = (model: Model<Api>) => {
    const source = cfg.models.find((m) => m.id === model.id);
    // Headers remain server-side and are only materialized when making the actual request.
    return { ...model, headers: { ...cfg.headers, ...source?.headers } };
  };
  return {
    ...api,
    stream: (model, context, options) => (baseOAuth || api).stream(requestModel(model), context, options),
    streamSimple: (model, context, options) => (baseOAuth || api).streamSimple(requestModel(model), context, options),
  };
}
