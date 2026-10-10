import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import * as fs from "node:fs";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Authentication } from "../extension/adapters/authentication";
import {
  discover,
  knownProviders,
  type KnownProvider,
  recommend,
  listModelPresets,
  type DiscoveryOptions,
} from "../extension/adapters/discovery";
import {
  API_CHOICES,
  OAUTH_PROVIDER_CHOICES,
  apiLabel,
  oauthProviderLabel,
  oauthProviderChoicesForApi,
  apiSupportsApiKey,
} from "./catalog";
import { ConfigStore } from "./store";
import {
  object,
  text,
  id,
  revision,
  providerSchema,
  patchSchema,
  modelSchema,
  modelOverrideSchema,
  apiSchema,
  secret,
  pageSchema,
  enumOf,
  validate,
  validUrl,
  safeKeys,
} from "./schema";
import { dataSchema } from "./results";
import { OperationError, checkAbort } from "../operations/errors";
import type { OperationContext, OperationDefinition } from "../operations/types";
import type { RuntimePort } from "./ports";
import { modelConfigFromPi } from "./model";
import { isOverrideRecord, type ModelConfig, type ModelsConfig, type ProviderConfig } from "./types";

type Draft = {
  draftId: string;
  revision: number;
  baseConfigRevision: string;
  originalId?: string;
  id: string;
  provider: ProviderConfig;
  candidates: ModelConfig[];
  updated: number;
  /** True when draft.create stored a new credential that draft.discard must remove. */
  ownsCredential?: boolean;
};
export interface ServiceOptions {
  directory: string;
  runtime: RuntimePort;
  authentication?: Authentication;
  discovery?: DiscoveryOptions;
  now?: () => number;
}
export class ProviderService {
  readonly store: ConfigStore;
  readonly auth: Authentication;
  private drafts = new Map<string, Draft>();
  private operationDefinitions?: OperationDefinition[];
  private runtimeFailed = false;
  private syncTail: Promise<void> = Promise.resolve();
  private get now() {
    return this.options.now || Date.now;
  }
  constructor(readonly options: ServiceOptions) {
    this.store = new ConfigStore(options.directory);
    this.auth = options.authentication || new Authentication(options.directory);
  }
  private normalized(id: string, p: ProviderConfig): ProviderConfig {
    return { ...p, credentialId: p.credentialId || id };
  }
  private stored(id: string) {
    const s = this.store.read();
    const p = s.config.providers[id];
    if (!p) throw new OperationError("NOT_FOUND", "Provider not found.");
    return { ...s, provider: this.normalized(id, p) };
  }
  /** A provider Pi already ships, if this id names one. */
  private builtin(id: string) {
    return builtinProviders().find((provider) => provider.id === id);
  }
  /**
   * A record Pi accepts for a built-in provider may contain only `modelOverrides`. Its endpoint,
   * API and models come from Pi itself, so nothing here is written back.
   */
  private overrideRecord(provider: any): boolean {
    return isOverrideRecord(provider);
  }
  /**
   * What a credential write targets. A provider Pi ships has no record, so its config is
   * synthesized: the key stays the provider id (where Pi's own `/login` put it) and its OAuth
   * flow is Pi's.
   */
  private authTarget(id: string): { provider: ProviderConfig; revision: string; stored: boolean } {
    const state = this.store.read();
    const record = state.config.providers[id];
    if (record && !this.overrideRecord(record))
      return { provider: this.normalized(id, record), revision: state.revision, stored: true };
    const builtin = this.builtin(id);
    if (!builtin) throw new OperationError("NOT_FOUND", "Provider not found.");
    const status = this.auth.builtinStatus(id);
    const oauth = !!builtin.auth?.oauth;
    return {
      provider: {
        baseUrl: builtin.baseUrl ?? "",
        api: builtin.getModels()[0]?.api as ProviderConfig["api"],
        models: [],
        authMode: status.hasCredential ? (status.mode === "oauth" ? "oauth" : "api_key") : oauth ? "oauth" : "api_key",
        oauthProvider: oauth ? (id as any) : undefined,
        modelOverrides: record?.modelOverrides,
      },
      revision: state.revision,
      stored: false,
    };
  }
  /** The record may not exist for a provider Pi ships; only touch what is actually there. */
  private clearStoredCredentialFields(config: ModelsConfig, id: string) {
    const record: any = config.providers[id];
    if (!record) return;
    delete record.oauthJsonPath;
    delete record.apiKey;
    if (!Object.keys(record).length) delete config.providers[id];
  }
  private builtinView(id: string, record: any, configRevision: string) {
    const builtin = this.builtin(id)!;
    const overrides: Record<string, any> = record?.modelOverrides ?? {};
    const builtinApi = builtin.getModels()[0]?.api;
    // The runtime reports the models Pi actually uses, overrides included, so the page and the
    // request path can never disagree about a built-in model.
    // Pi's registry already applied every layer, so this is what the provider actually serves.
    // Without a bound runtime the models are reported as Pi ships them, with the patches alongside.
    const models = this.options.runtime.modelsOf?.(id) ?? builtin.getModels().map(modelConfigFromPi);
    const values = {
      id,
      name: builtin.name,
      api: builtinApi,
      baseUrl: builtin.baseUrl,
      auth: { mode: "none" },
      authHeader: "auto",
      models,
    };
    return {
      ...values,
      revision: configRevision,
      source: "builtin",
      overriddenModelIds: Object.keys(overrides).sort(),
      modelOverrides: overrides,
      auth: this.auth.builtinStatus(id),
      headers: [],
      modelHeaders: [],
      runtimeStatus: this.runtimeFailed ? "failed" : "ready",
      modelCount: models.length,
    };
  }
  private publicConfig(id: string, provider: ProviderConfig): any {
    const p = this.normalized(id, provider);
    return {
      id,
      name: p.name,
      api: p.api,
      baseUrl: p.baseUrl,
      auth: { mode: this.auth.mode(p), ...(p.oauthProvider ? { methodId: p.oauthProvider } : {}) },
      authHeader: p.authHeader === undefined ? "auto" : p.authHeader ? "on" : "off",
      compat: p.compat,
      models: p.models.map(
        ({ id, name, api, baseUrl, reasoning, input, contextWindow, maxTokens, cost, thinkingLevelMap, compat }) => ({
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
        }),
      ),
    };
  }
  view(id: string, provider: ProviderConfig, configRevision: string) {
    if (this.builtin(id) && this.overrideRecord(provider)) return this.builtinView(id, provider, configRevision);
    const values = JSON.parse(JSON.stringify(this.publicConfig(id, provider)));
    try {
      validate(providerSchema, values);
      this.validateUrls(values);
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      const prefix = `/providers/${id.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      const fields = error.fields?.map((field) => ({ ...field, path: prefix + field.path }));
      const locations =
        fields
          ?.slice(0, 3)
          .map((field) => field.path)
          .join("、") || prefix;
      throw new OperationError(error.code, `${error.message} Location: ${locations}`, fields, error.retryable);
    }
    return {
      ...values,
      revision: configRevision,
      source: "configured",
      overriddenModelIds: Object.keys(provider.modelOverrides ?? {}).sort(),
      auth: this.auth.status(id, this.normalized(id, provider)),
      headers: Object.keys(provider.headers || {}).map((name) => ({ name, hasValue: true })),
      modelHeaders: provider.models
        .filter((m) => m.headers)
        .map((m) => ({ modelId: m.id, names: Object.keys(m.headers!) })),
      runtimeStatus: this.runtimeFailed ? "failed" : "ready",
      modelCount: provider.models.length,
    };
  }
  private validateUrls(values: any) {
    validUrl(values.baseUrl);
    for (const m of values.models) if (m.baseUrl) validUrl(m.baseUrl);
  }
  private build(values: any, previous?: ProviderConfig): ProviderConfig {
    validate(providerSchema, values);
    safeKeys(values);
    this.validateUrls(values);
    if (!API_CHOICES.includes(values.api)) throw new OperationError("VALIDATION_ERROR", "Unsupported API.");
    if (["constructor", "prototype", "__proto__"].includes(values.id))
      throw new OperationError("VALIDATION_ERROR", "Invalid provider ID.");
    if (values.auth.mode !== "oauth" && !apiSupportsApiKey(values.api))
      throw new OperationError("VALIDATION_ERROR", "This API requires a compatible OAuth method.", [
        {
          path: "/auth/mode",
          code: "INCOMPATIBLE_AUTH",
          message: "This API does not support the selected authentication method.",
        },
      ]);
    if (values.auth.mode === "oauth" && !oauthProviderChoicesForApi(values.api).includes(values.auth.methodId))
      throw new OperationError("VALIDATION_ERROR", "The authentication method does not support this API.", [
        { path: "/auth/methodId", code: "INCOMPATIBLE_AUTH", message: "Select a compatible OAuth provider." },
      ]);
    if (new Set(values.models.map((m: any) => m.id)).size !== values.models.length)
      throw new OperationError("VALIDATION_ERROR", "Duplicate model IDs.");
    const { id: _id, auth, authHeader, ...config } = values;
    const next: ProviderConfig = {
      ...config,
      apiKey: previous?.apiKey,
      oauthJsonPath: previous?.oauthJsonPath,
      headers: previous?.headers,
      authMode: auth.mode,
      oauthProvider: auth.mode === "oauth" ? auth.methodId : undefined,
      authHeader: authHeader === "on" ? true : authHeader === "off" ? false : undefined,
      credentialId: previous?.credentialId || this.auth.newBinding(),
    };
    // Secret headers are edited through their own write-only operation, not a public configuration round trip.
    next.models = values.models.map((m: ModelConfig) => ({
      ...m,
      headers: previous?.models.find((old) => old.id === m.id)?.headers,
    }));
    const changedDestination =
      previous &&
      (previous.baseUrl !== next.baseUrl ||
        previous.api !== next.api ||
        previous.oauthProvider !== next.oauthProvider ||
        this.auth.mode(previous) !== auth.mode ||
        next.models.some((m) => {
          const old = previous.models.find((o) => o.id === m.id);
          return (
            (m.baseUrl || next.baseUrl) !== (old?.baseUrl || previous.baseUrl) ||
            (old && (m.api || next.api) !== (old.api || previous.api))
          );
        }));
    if (changedDestination) {
      // Never forward existing credentials/headers to a newly selected endpoint implicitly.
      next.credentialId = this.auth.newBinding();
      delete next.apiKey;
      delete next.oauthJsonPath;
      delete next.headers;
      next.models = next.models.map(({ headers, ...m }) => m);
    }
    return next;
  }
  private conflictId(id: string, original?: string) {
    if (id === original) return;
    const state = this.store.read();
    if (
      Object.hasOwn(state.config.providers, id) ||
      builtinProviders().some((p) => p.id === id) ||
      this.options.runtime.exists?.(id)
    )
      throw new OperationError("CONFLICT", "This provider ID is already in use.");
  }
  private requireIdle(original?: string, next?: ProviderConfig, nextId?: string, caller = "user_client") {
    if (
      this.options.runtime.busy() &&
      (caller !== "model_tool" || this.options.runtime.active()?.provider === original)
    )
      throw new OperationError(
        "BUSY",
        "Pi is running a model request. Try editing again when it finishes.",
        undefined,
        true,
      );
    const active = this.options.runtime.active();
    if (
      active &&
      active.provider === original &&
      (!next || nextId !== original || !next.models.some((m) => m.id === active.id))
    )
      throw new OperationError(
        "ACTIVE_MODEL_IN_USE",
        "Switch the current conversation model before deleting or renaming this provider.",
      );
  }
  private pruneDrafts() {
    for (const [key, draft] of this.drafts) if (this.now() - draft.updated > 30 * 60_000) this.drafts.delete(key);
  }
  private draft(id: string, expected?: number) {
    this.pruneDrafts();
    const d = this.drafts.get(id);
    if (!d) throw new OperationError("NOT_FOUND", "Draft not found or expired.");
    if (expected !== undefined && d.revision !== expected)
      throw new OperationError("STALE_REVISION", "The draft has changed. Reload it and try again.");
    d.updated = this.now();
    return d;
  }
  private draftView(d: Draft) {
    return {
      draftId: d.draftId,
      revision: d.revision,
      baseConfigRevision: d.baseConfigRevision,
      originalProviderId: d.originalId,
      values: this.publicConfig(d.id, d.provider),
      schema: providerSchema,
      candidates: d.candidates.map((m) => this.candidate(m)),
      selectedModelIds: d.provider.models.map((m) => m.id),
      dirty: true,
      errors: [],
      availableActions: ["draft.patch", "model.discover", "draft.selectModels", "draft.commit", "draft.discard"].map(
        (name) => ({ operation: `provider-manager/${name}`, arguments: { draftId: d.draftId, revision: d.revision } }),
      ),
    };
  }
  private candidate(m: ModelConfig & { suggestedBy?: string }) {
    const { suggestedBy, headers, ...model } = m;
    validate(modelSchema, model);
    if (model.baseUrl) validUrl(model.baseUrl);
    return {
      model,
      source: suggestedBy === "api" ? "api" : suggestedBy ? "catalog" : "manual",
      availability: suggestedBy === "api" ? "listed" : "suggested",
    };
  }
  private newDraft(id: string, provider: ProviderConfig, baseConfigRevision: string, originalId?: string) {
    this.pruneDrafts();
    if (this.drafts.size >= 100) throw new OperationError("BUSY", "Draft limit reached. Close existing drafts first.");
    const d: Draft = {
      draftId: randomUUID(),
      revision: 1,
      id,
      provider,
      originalId,
      baseConfigRevision,
      candidates: provider.models.map(({ headers, ...model }) => model),
      updated: this.now(),
    };
    this.drafts.set(d.draftId, d);
    return d;
  }
  private updateDraft(d: Draft, values: any, candidates: ModelConfig[] = d.candidates) {
    const provider = this.build(values, d.provider);
    this.conflictId(values.id, d.originalId);
    // Candidates from a previous endpoint are no longer suggestions for the new endpoint.
    if (
      provider.baseUrl !== d.provider.baseUrl ||
      provider.api !== d.provider.api ||
      provider.oauthProvider !== d.provider.oauthProvider
    )
      candidates = [];
    const nextCandidates = [
      ...new Map(
        [...candidates, ...provider.models].map((model) => {
          const { headers, ...safe } = model;
          this.candidate(safe); // Validate before changing any draft state.
          return [safe.id, safe] as const;
        }),
      ).values(),
    ];
    const next: Draft = {
      ...d,
      id: values.id,
      provider,
      candidates: nextCandidates,
      revision: d.revision + 1,
      updated: this.now(),
    };
    this.drafts.set(d.draftId, next);
    return this.draftView(next);
  }
  private async sync(context: OperationContext) {
    const pending = this.syncTail.then(async () => {
      try {
        await this.options.runtime.sync(this.store.read().config);
        this.runtimeFailed = false;
        context.effects.runtime = "synced";
      } catch {
        this.runtimeFailed = true;
        context.effects.runtime = "failed";
        throw new OperationError(
          "RUNTIME_SYNC_FAILED",
          "Pi registration failed. Retry synchronization.",
          undefined,
          true,
        );
      }
    });
    this.syncTail = pending.catch(() => {});
    return pending;
  }
  private async save(
    change: Pick<Draft, "id" | "provider" | "originalId" | "baseConfigRevision">,
    ctx: OperationContext,
    draft?: Draft,
  ) {
    const snapshot = structuredClone(change);
    const committed = await this.store.commit(
      snapshot.baseConfigRevision,
      (config) => {
        if (draft && this.drafts.get(draft.draftId)?.revision !== draft.revision)
          throw new OperationError(
            "STALE_REVISION",
            "The draft was edited or discarded while saving. Reload it and try again.",
          );
        this.requireIdle(snapshot.originalId, snapshot.provider, snapshot.id, ctx.caller);
        this.conflictId(snapshot.id, snapshot.originalId);
        if (snapshot.originalId && snapshot.originalId !== snapshot.id) delete config.providers[snapshot.originalId];
        config.providers[snapshot.id] = snapshot.provider;
      },
      ctx.signal,
    );
    ctx.effects.config = "committed";
    if (draft && this.drafts.get(draft.draftId)?.revision === draft.revision) this.drafts.delete(draft.draftId);
    await this.sync(ctx);
    return this.view(snapshot.id, committed.config.providers[snapshot.id], committed.revision);
  }
  private page(items: any[], args: any, version: string) {
    const limit = args.limit || 50;
    let offset = 0;
    if (args.cursor) {
      try {
        const c = JSON.parse(Buffer.from(args.cursor, "base64url").toString());
        if (
          c.version !== version ||
          c.filter !== (args.filter || "") ||
          !Number.isSafeInteger(c.offset) ||
          c.offset < 0
        )
          throw new Error();
        offset = c.offset;
      } catch {
        throw new OperationError("STALE_REVISION", "The page cursor has expired.");
      }
    }
    const filtered = args.filter
      ? items.filter((i) => JSON.stringify(i).toLowerCase().includes(args.filter.toLowerCase()))
      : items;
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      ...(offset + limit < filtered.length
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ version, offset: offset + limit, filter: args.filter || "" }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
  definitions(): OperationDefinition[] {
    return (this.operationDefinitions ??= this.createDefinitions());
  }
  private createDefinitions(): OperationDefinition[] {
    const all = ["user_client", "model_tool"] as const;
    const def = (
      name: string,
      title: string,
      schema: any,
      effects: OperationDefinition["effects"],
      execute: OperationDefinition["execute"],
      userOnly = false,
    ): OperationDefinition => ({
      name,
      title,
      description: title,
      inputSchema: schema,
      resultSchema: dataSchema(name),
      effects,
      allowedCallers: userOnly ? ["user_client"] : [...all],
      execute,
    });
    const target = object({ providerId: id });
    const draftTarget = { draftId: text({ minLength: 1 }), revision: Type.Integer({ minimum: 1 }) };
    const select = { modelIds: Type.Array(text({ minLength: 1 }), { uniqueItems: true, maxItems: 5000 }) };
    const resolveTarget = (a: any) => {
      if (a.draftId) {
        if (a.providerId)
          throw new OperationError("VALIDATION_ERROR", "Target either a provider or a draft, not both.", [
            { path: "/draftId", code: "CONFLICTING_FIELDS", message: "Remove providerId when targeting a draft." },
          ]);
        if (!a.revision)
          throw new OperationError("VALIDATION_ERROR", "A draft revision is required when targeting a draft.", [
            { path: "/revision", code: "MISSING_FIELD", message: "Provide the draft revision." },
          ]);
        const d = this.draft(a.draftId, a.revision);
        return { id: d.id, provider: d.provider, draft: d };
      }
      if (!a.providerId)
        throw new OperationError("VALIDATION_ERROR", "A provider ID or a draft reference is required.", [
          { path: "/providerId", code: "MISSING_FIELD", message: "Provide a provider ID or a draft reference." },
        ]);
      const s = this.stored(a.providerId);
      return { id: a.providerId as string, provider: s.provider, draft: undefined };
    };
    // Providers require a tool schema whose root is an object, so the provider/draft
    // target is expressed as optional properties and resolved explicitly above.
    const eitherTarget = object({
      providerId: Type.Optional(id),
      draftId: Type.Optional(text({ minLength: 1 })),
      revision: Type.Optional(Type.Integer({ minimum: 1 })),
    });
    return [
      def("provider.list", "List providers", object(pageSchema), ["read"], async (a) => {
        const s = this.store.read();
        const stored = Object.keys(s.config.providers);
        // Providers Pi ships are listed once they are usable (a stored credential) or adjusted,
        // so a logged-in provider is visible here without flooding the list with all of them.
        const loggedIn = builtinProviders()
          .filter((provider) => !stored.includes(provider.id) && this.auth.builtinStatus(provider.id).hasCredential)
          .map((provider) => this.view(provider.id, {} as ProviderConfig, s.revision));
        return {
          ...this.page(
            [...stored.map((id) => this.view(id, s.config.providers[id], s.revision)), ...loggedIn],
            a,
            s.revision,
          ),
          revision: s.revision,
        };
      }),
      def("provider.get", "Provider details", target, ["read"], async (a) => {
        const s = this.store.read();
        const provider = s.config.providers[a.providerId];
        if (provider) return this.view(a.providerId, provider, s.revision);
        if (this.builtin(a.providerId)) return this.view(a.providerId, {} as ProviderConfig, s.revision);
        throw new OperationError("NOT_FOUND", "Provider not found.");
      }),
      def("provider.create", "Create provider", providerSchema, ["config_write"], async (a, c) => {
        this.conflictId(a.id);
        const s = this.store.read();
        return this.save({ id: a.id, provider: this.build(a), baseConfigRevision: s.revision }, c);
      }),
      def(
        "provider.update",
        "Update provider",
        object({
          providerId: id,
          expectedRevision: revision,
          set: patchSchema,
          unset: Type.Optional(Type.Array(enumOf(["name", "compat"]), { uniqueItems: true })),
        }),
        ["config_write"],
        async (a, c) => {
          const s = this.stored(a.providerId);
          if (s.revision !== a.expectedRevision)
            throw new OperationError("CONFLICT", "The configuration has changed. Reload it and try again.");
          const values = { ...this.publicConfig(a.providerId, s.provider), ...a.set };
          for (const key of a.unset || []) delete values[key];
          return this.save(
            {
              id: values.id,
              provider: this.build(values, s.provider),
              baseConfigRevision: s.revision,
              originalId: a.providerId,
            },
            c,
          );
        },
      ),
      def(
        "provider.delete",
        "Delete provider",
        object({ providerId: id, expectedRevision: revision }),
        ["config_write"],
        async (a, c) => {
          this.stored(a.providerId);
          this.requireIdle(a.providerId, undefined, undefined, c.caller);
          await this.store.commit(
            a.expectedRevision,
            (config) => {
              delete config.providers[a.providerId];
            },
            c.signal,
          );
          c.effects.config = "committed";
          await this.sync(c);
          return { deleted: a.providerId, credentialsRetained: true };
        },
      ),
      def("runtime.sync", "Resync Pi models", object({}), ["read"], async (_a, c) => {
        this.requireIdle();
        await this.sync(c);
        return { ready: true };
      }),
      def(
        "catalog.list",
        "API and authentication options",
        object({ api: Type.Optional(apiSchema) }),
        ["read"],
        async (a) => {
          // Known endpoints, so a base URL never has to be recalled from memory.
          const providers = knownProviders();
          return {
            apis: API_CHOICES.map((id) => ({ id, label: apiLabel(id) })),
            providers: (a.api ? providers.filter((provider) => provider.apis.includes(a.api)) : providers).map(
              ({ id, name, baseUrl, apis, auth }: KnownProvider) => ({ id, name, baseUrl, apis, auth }),
            ),
            authMethods: [
              ...(!a.api || apiSupportsApiKey(a.api)
                ? [
                    { id: "none", label: "No authentication", value: { mode: "none" } },
                    { id: "api_key", label: "API Key", value: { mode: "api_key" } },
                  ]
                : []),
              ...(a.api ? oauthProviderChoicesForApi(a.api) : OAUTH_PROVIDER_CHOICES).map((id) => ({
                id: `oauth/${id}`,
                label: oauthProviderLabel(id),
                value: { mode: "oauth", methodId: id },
              })),
            ],
          };
        },
      ),
      def(
        "catalog.presets",
        "Model presets",
        object({
          api: apiSchema,
          modelId: text(),
          providerId: Type.Optional(text()),
          providerName: Type.Optional(text()),
          baseUrl: Type.Optional(text()),
          ...pageSchema,
        }),
        ["read"],
        async (a) =>
          this.page(
            listModelPresets(a.api, a.modelId, {
              id: a.providerId,
              name: a.providerName,
              baseUrl: a.baseUrl,
            }).map((p) => ({
              id: p.key,
              label: p.label,
              model: this.candidate(p.model).model,
            })),
            a,
            `0.82.0:${a.api}:${a.modelId}:${a.providerId || ""}:${a.baseUrl || ""}`,
          ),
      ),
      def(
        "draft.create",
        "Create configuration draft",
        object({
          ...providerSchema.properties,
          apiKey: Type.Optional(secret),
          oauthJson: Type.Optional(secret),
          oauthJsonPath: Type.Optional(secret),
        }),
        ["read", "credential_write"],
        async (a, c) => {
          this.conflictId(a.id);
          const { apiKey, oauthJson, oauthJsonPath, ...values } = a;
          const provider = this.build(values);
          if (typeof oauthJsonPath === "string" && oauthJsonPath) provider.oauthJsonPath = oauthJsonPath;
          const draft = this.newDraft(a.id, provider, this.store.read().revision);
          if (typeof apiKey === "string" && apiKey) {
            await this.auth.saveCredential(draft.id, draft.provider, { type: "api_key", key: apiKey }, c);
            draft.ownsCredential = true;
          } else if (typeof oauthJson === "string" && oauthJson) {
            const credential = this.auth.importedCredential(draft.id, draft.provider, oauthJson);
            await this.auth.saveCredential(draft.id, draft.provider, credential, c);
            draft.ownsCredential = true;
          }
          return this.draftView(draft);
        },
        true,
      ),
      def(
        "draft.login",
        "Sign in to the draft provider",
        object(draftTarget),
        ["network", "credential_write"],
        async (a, c) => {
          const d = this.draft(a.draftId, a.revision);
          if (this.auth.mode(d.provider) !== "oauth")
            throw new OperationError("VALIDATION_ERROR", "The draft does not use OAuth.");
          const credential = await this.auth.login(d.provider, c);
          await this.auth.saveCredential(d.id, d.provider, credential, c);
          d.ownsCredential = true;
          return this.draftView(d);
        },
        true,
      ),
      def(
        "draft.open",
        "Edit existing configuration",
        target,
        ["read"],
        async (a) => {
          const s = this.stored(a.providerId);
          return this.draftView(this.newDraft(a.providerId, s.provider, s.revision, a.providerId));
        },
        true,
      ),
      def(
        "draft.get",
        "Get draft",
        object({ draftId: text() }),
        ["read"],
        async (a) => this.draftView(this.draft(a.draftId)),
        true,
      ),
      def(
        "draft.patch",
        "Update draft",
        object({ ...draftTarget, set: patchSchema, unset: Type.Optional(Type.Array(enumOf(["name", "compat"]))) }),
        ["read"],
        async (a) => {
          const d = this.draft(a.draftId, a.revision);
          const values = { ...this.publicConfig(d.id, d.provider), ...a.set };
          for (const key of a.unset || []) delete values[key];
          return this.updateDraft(d, values);
        },
        true,
      ),
      def(
        "draft.validate",
        "Validate draft",
        object(draftTarget),
        ["read"],
        async (a) => {
          const d = this.draft(a.draftId, a.revision);
          this.build(this.publicConfig(d.id, d.provider), d.provider);
          return { valid: true, errors: [], values: this.publicConfig(d.id, d.provider) };
        },
        true,
      ),
      def(
        "draft.commit",
        "Save draft",
        object(draftTarget),
        ["config_write"],
        async (a, c) => {
          const draft = this.draft(a.draftId, a.revision);
          return this.save(draft, c, draft);
        },
        true,
      ),
      def(
        "draft.discard",
        "Discard draft",
        object(draftTarget),
        ["read", "credential_write"],
        async (a, c) => {
          const d = this.draft(a.draftId, a.revision);
          this.drafts.delete(d.draftId);
          if (d.ownsCredential) await this.auth.saveCredential(d.id, d.provider, undefined, c);
          return { discarded: true };
        },
        true,
      ),
      def(
        "draft.selectModels",
        "Select models",
        object({ ...draftTarget, ...select }),
        ["read"],
        async (a) => {
          const d = this.draft(a.draftId, a.revision);
          const candidates = new Map([...d.candidates, ...d.provider.models].map((m) => [m.id, m]));
          if (a.modelIds.some((id: string) => !candidates.has(id)))
            throw new OperationError("VALIDATION_ERROR", "The model is not in the current candidate list.");
          const models = a.modelIds.map((id: string) => {
            const { suggestedBy, headers, ...model } = candidates.get(id) as ModelConfig & { suggestedBy?: string };
            return model;
          });
          return this.updateDraft(d, { ...this.publicConfig(d.id, d.provider), models });
        },
        true,
      ),
      def(
        "draft.upsertModel",
        "Add or update model",
        object({ ...draftTarget, model: modelSchema }),
        ["read"],
        async (a) => {
          const d = this.draft(a.draftId, a.revision);
          const models = [...d.provider.models.filter((m) => m.id !== a.model.id), a.model];
          return this.updateDraft(d, this.publicConfig(d.id, { ...d.provider, models }));
        },
        true,
      ),
      def(
        "draft.removeModel",
        "Remove draft model",
        object({ ...draftTarget, modelId: text() }),
        ["read"],
        async (a) => {
          const d = this.draft(a.draftId, a.revision);
          const models = d.provider.models.filter((m) => m.id !== a.modelId);
          return this.updateDraft(
            d,
            this.publicConfig(d.id, { ...d.provider, models }),
            d.candidates.filter((m) => m.id !== a.modelId),
          );
        },
        true,
      ),
      def(
        "draft.applyPreset",
        "Apply complete model preset",
        object({ ...draftTarget, modelId: text(), presetId: text() }),
        ["read"],
        async (a) => {
          const d = this.draft(a.draftId, a.revision);
          const model = d.provider.models.find((m) => m.id === a.modelId);
          if (!model) throw new OperationError("NOT_FOUND", "Model not found.");
          const preset = listModelPresets(d.provider.api, a.modelId, {
            id: d.id,
            name: d.provider.name,
            baseUrl: d.provider.baseUrl,
          }).find((p) => p.key === a.presetId);
          if (!preset) throw new OperationError("NOT_FOUND", "Preset not found.");
          const { suggestedBy, ...fields } = preset.model;
          const models = d.provider.models.map((m) => (m.id === a.modelId ? { ...m, ...fields, id: a.modelId } : m));
          return this.updateDraft(d, this.publicConfig(d.id, { ...d.provider, models }));
        },
        true,
      ),
      def("model.discover", "Discover provider models", eitherTarget, ["network"], async (a, c) => {
        if (c.caller === "model_tool" && a.draftId)
          throw new OperationError("USER_ACTION_REQUIRED", "Model tools cannot modify user drafts.");
        const target = resolveTarget(a);
        const atRevision = target.draft?.revision;
        const resolved = await this.auth.resolve(target.id, target.provider, c.signal, c.effects);
        c.progress("fetch_models");
        const result = await discover(
          target.id,
          target.provider,
          {
            apiKey:
              this.auth.mode(target.provider) === "none" || target.provider.authHeader === false
                ? undefined
                : resolved.auth.apiKey,
          },
          {
            ...this.options.discovery,
            headers: Object.fromEntries(
              Object.entries({ ...target.provider.headers, ...resolved.auth.headers }).filter(
                ([, v]) => typeof v === "string",
              ) as [string, string][],
            ),
            signal: c.signal,
          },
        );
        checkAbort(c.signal);
        c.warnings.push(...result.warnings);
        if (target.draft) {
          const d = this.draft(target.draft.draftId, atRevision);
          return this.updateDraft(d, this.publicConfig(d.id, d.provider), [...d.candidates, ...result.models]);
        }
        return { items: result.models.map((m) => this.candidate(m)), total: result.models.length };
      }),
      def(
        "model.recommend",
        "Enrich model metadata",
        object({ providerId: id, modelId: text() }),
        ["network"],
        async (a, c) => {
          const s = this.stored(a.providerId);
          const m = await recommend(a.modelId, a.providerId, s.provider, {
            ...this.options.discovery,
            signal: c.signal,
          });
          return m ? this.candidate(m) : { model: { id: a.modelId }, source: "manual", availability: "unknown" };
        },
      ),
      def(
        "provider.selectModels",
        "Save selected models",
        object({ providerId: id, expectedRevision: revision, models: Type.Array(modelSchema, { maxItems: 5000 }) }),
        ["config_write"],
        async (a, c) => {
          const s = this.stored(a.providerId);
          return this.save(
            {
              id: a.providerId,
              provider: this.build({ ...this.publicConfig(a.providerId, s.provider), models: a.models }, s.provider),
              baseConfigRevision: a.expectedRevision,
              originalId: a.providerId,
            },
            c,
          );
        },
      ),
      def("auth.status", "Authentication status", target, ["read"], async (a) =>
        this.authTarget(a.providerId).stored
          ? this.auth.status(a.providerId, this.authTarget(a.providerId).provider)
          : this.auth.builtinStatus(a.providerId),
      ),
      ...(["configure", "import", "begin", "clear"] as const).map((action) =>
        def(
          `auth.${action}`,
          {
            configure: "Set API key",
            import: "Import OAuth JSON",
            begin: "Start OAuth sign-in",
            clear: "Clear credentials",
          }[action],
          object({
            providerId: id,
            expectedRevision: revision,
            ...(["configure", "import"].includes(action) ? { value: secret } : {}),
          }),
          ["credential_write", "config_write", ...(action === "begin" ? ["network" as const] : [])],
          async (a, c) => {
            const s = this.authTarget(a.providerId);
            if (s.revision !== a.expectedRevision)
              throw new OperationError("CONFLICT", "The configuration has changed. Reload it before authenticating.");
            this.requireIdle();
            if (action === "begin" && !s.provider.oauthProvider)
              throw new OperationError("VALIDATION_ERROR", "This provider has no OAuth sign-in.");
            const credential =
              action === "begin"
                ? await this.auth.login(s.provider, c)
                : action === "import"
                  ? this.auth.importedCredential(a.providerId, s.provider, a.value)
                  : action === "configure"
                    ? { type: "api_key" as const, key: a.value }
                    : undefined;
            // OAuth network/user input happens before the transaction; recheck the revision under the config lock.
            await this.store.commit(
              s.revision,
              async (config) => {
                this.requireIdle();
                await this.auth.saveCredential(a.providerId, s.provider, credential, c);
                this.clearStoredCredentialFields(config, a.providerId);
              },
              c.signal,
            );
            c.effects.config = "committed";
            await this.sync(c);
            return this.authTarget(a.providerId).stored
              ? this.auth.status(a.providerId, this.authTarget(a.providerId).provider)
              : this.auth.builtinStatus(a.providerId);
          },
          true,
        ),
      ),
      def(
        "auth.file",
        "Set server-side OAuth file",
        object({ providerId: id, expectedRevision: revision, path: secret }),
        ["config_write"],
        async (a, c) => {
          const s = this.stored(a.providerId);
          this.requireIdle();
          if (!s.provider.oauthProvider) throw new OperationError("VALIDATION_ERROR", "Select an OAuth method.");
          if (!fs.existsSync(a.path)) throw new OperationError("NOT_FOUND", "The server-side file does not exist.");
          await this.store.commit(
            a.expectedRevision,
            (config) => {
              config.providers[a.providerId].oauthJsonPath = a.path;
            },
            c.signal,
          );
          c.effects.config = "committed";
          await this.sync(c);
          return { configured: true };
        },
        true,
      ),
      def(
        "model.override",
        "Adjust a model Pi ships",
        object({
          providerId: id,
          modelId: text({ minLength: 1, maxLength: 256 }),
          expectedRevision: revision,
          set: Type.Optional(modelOverrideSchema),
          unset: Type.Optional(Type.Array(text({ maxLength: 256 }), { maxItems: 64 })),
        }),
        ["config_write"],
        async (a, c) => {
          const builtin = this.builtin(a.providerId);
          if (!builtin) throw new OperationError("VALIDATION_ERROR", "Only a provider Pi ships can be adjusted here.");
          if (!builtin.getModels().some((model) => model.id === a.modelId))
            throw new OperationError("NOT_FOUND", "Pi does not ship that model for this provider.");
          this.requireIdle();
          if (a.set) validate(modelOverrideSchema, a.set);
          await this.store.commit(
            a.expectedRevision,
            (config) => {
              const record: any = config.providers[a.providerId];
              const overrides: Record<string, any> = { ...(record?.modelOverrides ?? {}) };
              const patch: Record<string, any> = { ...(overrides[a.modelId] ?? {}), ...(a.set ?? {}) };
              for (const key of a.unset ?? []) delete patch[key];
              if (Object.keys(patch).length) overrides[a.modelId] = patch;
              else delete overrides[a.modelId];
              // The record holds nothing but patches, so Pi keeps its own endpoint and models.
              if (Object.keys(overrides).length)
                config.providers[a.providerId] = { modelOverrides: overrides } as ProviderConfig;
              else delete config.providers[a.providerId];
            },
            c.signal,
          );
          c.effects.config = "committed";
          await this.sync(c);
          const s = this.store.read();
          return this.view(a.providerId, s.config.providers[a.providerId] ?? ({} as ProviderConfig), s.revision);
        },
      ),
      def(
        "headers.set",
        "Set request header",
        object({
          providerId: id,
          expectedRevision: revision,
          modelId: Type.Optional(text()),
          name: text({ minLength: 1, pattern: "^[A-Za-z0-9-]+$", maxLength: 128 }),
          value: Type.Optional(secret),
        }),
        ["config_write"],
        async (a, c) => {
          this.requireIdle();
          if (a.value && /[\r\n]/.test(a.value))
            throw new OperationError("VALIDATION_ERROR", "Header values cannot contain line breaks.");
          await this.store.commit(
            a.expectedRevision,
            (config) => {
              const p = config.providers[a.providerId];
              if (!p) throw new OperationError("NOT_FOUND", "Provider not found.");
              const holder = a.modelId ? p.models.find((m) => m.id === a.modelId) : p;
              if (!holder) throw new OperationError("NOT_FOUND", "Model not found.");
              holder.headers = { ...holder.headers };
              if (a.value === undefined) delete holder.headers[a.name];
              else holder.headers[a.name] = a.value;
            },
            c.signal,
          );
          c.effects.config = "committed";
          await this.sync(c);
          return { configured: true };
        },
        true,
      ),
    ];
  }
  dispose() {
    this.drafts.clear();
  }
}
