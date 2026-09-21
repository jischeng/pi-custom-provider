import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import * as fs from "node:fs";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Authentication } from "../oauth";
import { discover, recommend, listModelPresets, type DiscoveryOptions } from "../discovery";
import {
  API_CHOICES,
  OAUTH_PROVIDER_CHOICES,
  apiLabel,
  oauthProviderLabel,
  oauthProviderChoicesForApi,
  apiSupportsApiKey,
} from "../pi-catalog";
import { ConfigStore } from "./store";
import {
  object,
  text,
  id,
  revision,
  providerSchema,
  patchSchema,
  modelSchema,
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
import type { RuntimeAdapter } from "../provider-registry";
import type { ModelConfig, ProviderConfig, ModelsConfig } from "../types";

type Draft = {
  draftId: string;
  revision: number;
  baseConfigRevision: string;
  originalId?: string;
  id: string;
  provider: ProviderConfig;
  candidates: ModelConfig[];
  updated: number;
};
export interface ServiceOptions {
  directory: string;
  runtime: RuntimeAdapter;
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
    if (!p) throw new OperationError("NOT_FOUND", "供应商不存在。");
    return { ...s, provider: this.normalized(id, p) };
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
      throw new OperationError(error.code, `${error.message} 位置：${locations}`, fields, error.retryable);
    }
    return {
      ...values,
      revision: configRevision,
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
    if (!API_CHOICES.includes(values.api)) throw new OperationError("VALIDATION_ERROR", "API 不受支持。");
    if (["constructor", "prototype", "__proto__"].includes(values.id))
      throw new OperationError("VALIDATION_ERROR", "供应商 ID 无效。");
    if (values.auth.mode !== "oauth" && !apiSupportsApiKey(values.api))
      throw new OperationError("VALIDATION_ERROR", "此 API 需要选择兼容的 OAuth 方式。", [
        { path: "/auth/mode", code: "INCOMPATIBLE_AUTH", message: "该 API 不支持此认证方式。" },
      ]);
    if (values.auth.mode === "oauth" && !oauthProviderChoicesForApi(values.api).includes(values.auth.methodId))
      throw new OperationError("VALIDATION_ERROR", "认证方式不支持此 API。", [
        { path: "/auth/methodId", code: "INCOMPATIBLE_AUTH", message: "请选择兼容的 OAuth 提供方。" },
      ]);
    if (new Set(values.models.map((m: any) => m.id)).size !== values.models.length)
      throw new OperationError("VALIDATION_ERROR", "模型 ID 重复。");
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
      throw new OperationError("CONFLICT", "此供应商 ID 已被使用。");
  }
  private requireIdle(original?: string, next?: ProviderConfig, nextId?: string, caller = "user_client") {
    if (
      this.options.runtime.busy() &&
      (caller !== "model_tool" || this.options.runtime.active()?.provider === original)
    )
      throw new OperationError("BUSY", "Pi 正在执行模型请求，请稍后修改。", undefined, true);
    const active = this.options.runtime.active();
    if (
      active &&
      active.provider === original &&
      (!next || nextId !== original || !next.models.some((m) => m.id === active.id))
    )
      throw new OperationError("ACTIVE_MODEL_IN_USE", "请先切换当前对话模型，再删除或改名。");
  }
  private pruneDrafts() {
    for (const [key, draft] of this.drafts) if (this.now() - draft.updated > 30 * 60_000) this.drafts.delete(key);
  }
  private draft(id: string, expected?: number) {
    this.pruneDrafts();
    const d = this.drafts.get(id);
    if (!d) throw new OperationError("NOT_FOUND", "草稿不存在或已过期。");
    if (expected !== undefined && d.revision !== expected)
      throw new OperationError("STALE_REVISION", "草稿已更新，请重新读取。");
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
    if (this.drafts.size >= 100) throw new OperationError("BUSY", "草稿过多，请先关闭旧草稿。");
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
        throw new OperationError("RUNTIME_SYNC_FAILED", "Pi 注册失败，请重试同步。", undefined, true);
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
          throw new OperationError("STALE_REVISION", "保存期间草稿已修改或丢弃，请重新读取。");
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
        throw new OperationError("STALE_REVISION", "分页位置已过期。");
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
      cancellable: true,
      execute,
    });
    const target = object({ providerId: id });
    const draftTarget = { draftId: text({ minLength: 1 }), revision: Type.Integer({ minimum: 1 }) };
    const select = { modelIds: Type.Array(text({ minLength: 1 }), { uniqueItems: true, maxItems: 5000 }) };
    const resolveTarget = (a: any) => {
      if (a.draftId) {
        const d = this.draft(a.draftId, a.revision);
        return { id: d.id, provider: d.provider, draft: d };
      }
      const s = this.stored(a.providerId);
      return { id: a.providerId as string, provider: s.provider, draft: undefined };
    };
    const eitherTarget = Type.Union([target, object(draftTarget)]);
    return [
      def("provider.list", "供应商列表", object(pageSchema), ["read"], async (a) => {
        const s = this.store.read();
        return {
          ...this.page(
            Object.entries(s.config.providers).map(([id, p]) => this.view(id, p, s.revision)),
            a,
            s.revision,
          ),
          revision: s.revision,
        };
      }),
      def("provider.get", "供应商详情", target, ["read"], async (a) => {
        const s = this.stored(a.providerId);
        return this.view(a.providerId, s.provider, s.revision);
      }),
      def("provider.create", "新增供应商", providerSchema, ["config_write"], async (a, c) => {
        this.conflictId(a.id);
        const s = this.store.read();
        return this.save({ id: a.id, provider: this.build(a), baseConfigRevision: s.revision }, c);
      }),
      def(
        "provider.update",
        "修改供应商",
        object({
          providerId: id,
          expectedRevision: revision,
          set: patchSchema,
          unset: Type.Optional(Type.Array(enumOf(["name", "compat"]), { uniqueItems: true })),
        }),
        ["config_write"],
        async (a, c) => {
          const s = this.stored(a.providerId);
          if (s.revision !== a.expectedRevision) throw new OperationError("CONFLICT", "配置已修改，请重新读取。");
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
        "删除供应商",
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
      def("runtime.sync", "重新同步 Pi 模型", object({}), ["read"], async (_a, c) => {
        this.requireIdle();
        await this.sync(c);
        return { ready: true };
      }),
      def("catalog.list", "API 与认证选项", object({ api: Type.Optional(apiSchema) }), ["read"], async (a) => ({
        apis: API_CHOICES.map((id) => ({ id, label: apiLabel(id) })),
        authMethods: [
          ...(!a.api || apiSupportsApiKey(a.api)
            ? [
                { id: "none", label: "无认证", value: { mode: "none" } },
                { id: "api_key", label: "API Key", value: { mode: "api_key" } },
              ]
            : []),
          ...(a.api ? oauthProviderChoicesForApi(a.api) : OAUTH_PROVIDER_CHOICES).map((id) => ({
            id: `oauth/${id}`,
            label: oauthProviderLabel(id),
            value: { mode: "oauth", methodId: id },
          })),
        ],
      })),
      def(
        "catalog.presets",
        "模型预设",
        object({ api: apiSchema, modelId: text(), ...pageSchema }),
        ["read"],
        async (a) =>
          this.page(
            listModelPresets(a.api, a.modelId).map((p) => ({
              id: p.key,
              label: p.label,
              model: this.candidate(p.model).model,
            })),
            a,
            `0.82.0:${a.api}:${a.modelId}`,
          ),
      ),
      def(
        "draft.create",
        "新建配置草稿",
        providerSchema,
        ["read"],
        async (a) => {
          this.conflictId(a.id);
          return this.draftView(this.newDraft(a.id, this.build(a), this.store.read().revision));
        },
        true,
      ),
      def(
        "draft.open",
        "编辑已有配置",
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
        "查询草稿",
        object({ draftId: text() }),
        ["read"],
        async (a) => this.draftView(this.draft(a.draftId)),
        true,
      ),
      def(
        "draft.patch",
        "修改草稿",
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
        "校验草稿",
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
        "保存草稿",
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
        "丢弃草稿",
        object(draftTarget),
        ["read"],
        async (a) => {
          const d = this.draft(a.draftId, a.revision);
          this.drafts.delete(d.draftId);
          return { discarded: true };
        },
        true,
      ),
      def(
        "draft.selectModels",
        "选择模型",
        object({ ...draftTarget, ...select }),
        ["read"],
        async (a) => {
          const d = this.draft(a.draftId, a.revision);
          const candidates = new Map([...d.candidates, ...d.provider.models].map((m) => [m.id, m]));
          if (a.modelIds.some((id: string) => !candidates.has(id)))
            throw new OperationError("VALIDATION_ERROR", "模型不属于当前候选集合。");
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
        "添加或修改模型",
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
        "删除草稿模型",
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
        "应用完整模型预设",
        object({ ...draftTarget, modelId: text(), presetId: text() }),
        ["read"],
        async (a) => {
          const d = this.draft(a.draftId, a.revision);
          const model = d.provider.models.find((m) => m.id === a.modelId);
          if (!model) throw new OperationError("NOT_FOUND", "模型不存在。");
          const preset = listModelPresets(d.provider.api, a.modelId).find((p) => p.key === a.presetId);
          if (!preset) throw new OperationError("NOT_FOUND", "预设不存在。");
          const { suggestedBy, ...fields } = preset.model;
          const models = d.provider.models.map((m) => (m.id === a.modelId ? { ...m, ...fields, id: a.modelId } : m));
          return this.updateDraft(d, this.publicConfig(d.id, { ...d.provider, models }));
        },
        true,
      ),
      def("model.discover", "发现供应商模型", eitherTarget, ["network"], async (a, c) => {
        if (c.caller === "model_tool" && a.draftId)
          throw new OperationError("USER_ACTION_REQUIRED", "模型工具不能修改用户草稿。");
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
        "补充模型元数据",
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
        "保存所选模型",
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
      def("auth.status", "认证状态", target, ["read"], async (a) =>
        this.auth.status(a.providerId, this.stored(a.providerId).provider),
      ),
      ...(["configure", "import", "begin", "clear"] as const).map((action) =>
        def(
          `auth.${action}`,
          { configure: "设置 API Key", import: "导入 OAuth JSON", begin: "开始 OAuth 登录", clear: "清除认证" }[action],
          object({
            providerId: id,
            expectedRevision: revision,
            ...(["configure", "import"].includes(action) ? { value: secret } : {}),
          }),
          ["credential_write", "config_write", ...(action === "begin" ? ["network" as const] : [])],
          async (a, c) => {
            const s = this.stored(a.providerId);
            if (s.revision !== a.expectedRevision)
              throw new OperationError("CONFLICT", "配置已变化，请重新读取后认证。");
            this.requireIdle();
            if (action === "configure" && this.auth.mode(s.provider) !== "api_key")
              throw new OperationError("VALIDATION_ERROR", "当前认证方式不是 API Key。");
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
                delete config.providers[a.providerId].oauthJsonPath;
                delete config.providers[a.providerId].apiKey;
              },
              c.signal,
            );
            c.effects.config = "committed";
            await this.sync(c);
            return this.auth.status(a.providerId, this.stored(a.providerId).provider);
          },
          true,
        ),
      ),
      def(
        "auth.file",
        "设置服务端 OAuth 文件",
        object({ providerId: id, expectedRevision: revision, path: secret }),
        ["config_write"],
        async (a, c) => {
          const s = this.stored(a.providerId);
          this.requireIdle();
          if (!s.provider.oauthProvider) throw new OperationError("VALIDATION_ERROR", "请选择 OAuth 方式。");
          if (!fs.existsSync(a.path)) throw new OperationError("NOT_FOUND", "服务端文件不存在。");
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
        "headers.set",
        "设置请求 Header",
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
            throw new OperationError("VALIDATION_ERROR", "Header 值不能包含换行。");
          await this.store.commit(
            a.expectedRevision,
            (config) => {
              const p = config.providers[a.providerId];
              if (!p) throw new OperationError("NOT_FOUND", "供应商不存在。");
              const holder = a.modelId ? p.models.find((m) => m.id === a.modelId) : p;
              if (!holder) throw new OperationError("NOT_FOUND", "模型不存在。");
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
