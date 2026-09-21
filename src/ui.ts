import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderService } from "./domain/service";
import { OperationRegistry } from "./operations/registry";
import type { Result } from "./operations/types";
import { modelSchema, providerSchema } from "./domain/schema";

/** UI orchestration only. Every control is implemented by Pi; there is no terminal rendering or input handling here. */
export async function runUiOperation(
  service: ProviderService,
  ctx: ExtensionContext,
  name: string,
  args: unknown,
  outerSignal?: AbortSignal,
): Promise<Result> {
  let finished = false;
  let active: AbortController | undefined;
  let activeInteraction: string | undefined;
  const prompts: any[] = [];
  const ended = new Set<string>();
  const registry = new OperationRegistry((event) => {
    if (event.type === "extension_interaction_request") {
      if (event.requiresResponse) {
        prompts.push(event);
        active?.abort();
      } else if (event.url) ctx.ui.notify(`${event.message}\n${event.url}`);
      else if (event.verificationUri) ctx.ui.notify(`${event.message}\n${event.verificationUri}\n${event.userCode}`);
    } else if (event.type === "extension_interaction_end") {
      ended.add(event.interactionId);
      if (activeInteraction === event.interactionId) active?.abort();
    } else if (event.type === "extension_operation_result") {
      finished = true;
      active?.abort();
    }
  });
  registry.register("provider-manager", service.definitions());
  const definition = registry.definition(`provider-manager/${name}`);
  const task = registry.invoke(definition.name, args, "user_client", undefined, outerSignal);
  ctx.ui.setStatus("provider-setup", definition.title);
  try {
    if (definition.effects.includes("network")) {
      while (!finished) {
        const prompt = prompts.shift();
        if (prompt && ended.has(prompt.interactionId)) continue;
        active = new AbortController();
        activeInteraction = prompt?.interactionId;
        if (prompt) {
          let value: string | undefined;
          if (prompt.options) {
            const labels = prompt.options.map((o: any) => `${o.label} (${o.id})`);
            const selected = await ctx.ui.select(prompt.message, labels, { signal: active.signal });
            value = selected === undefined ? undefined : prompt.options[labels.indexOf(selected)]?.id;
          } else
            value = await ctx.ui.input(
              prompt.message + (prompt.secret ? "（输入内容可见，不会回显已存凭据）" : ""),
              prompt.placeholder,
              { signal: active.signal },
            );
          if (!active.signal.aborted && !ended.has(prompt.interactionId))
            registry.respond(
              task.snapshot.operationId,
              prompt.interactionId,
              prompt.revision,
              value,
              value === undefined,
            );
        } else {
          await ctx.ui.select(`${definition.title}进行中`, ["取消操作"], { signal: active.signal });
          if (!active.signal.aborted) registry.cancel(task.snapshot.operationId);
        }
      }
    }
    return await task.done;
  } finally {
    active?.abort();
    ctx.ui.setStatus("provider-setup", undefined);
    await registry.dispose();
  }
}

export async function runSetup(service: ProviderService, ctx: ExtensionContext, signal?: AbortSignal) {
  const execute = async (name: string, args: unknown): Promise<Result> => {
    const r = await runUiOperation(service, ctx, name, args, signal);
    if (r.status !== "succeeded") {
      ctx.ui.notify(
        `${r.error?.message || "操作已取消。"}${r.effects.config === "committed" ? " 配置已保存。" : ""}`,
        r.status === "failed" ? "error" : "info",
      );
    }
    for (const warning of r.warnings) ctx.ui.notify(warning.message, "warning");
    return r;
  };
  const call = async (name: string, args: unknown): Promise<any> => {
    const result = await execute(name, args);
    return result.status === "succeeded" ? result.data : undefined;
  };
  let listCursor: string | undefined;
  const listHistory: (string | undefined)[] = [];
  while (!signal?.aborted) {
    const list = await call("provider.list", { limit: 12, ...(listCursor ? { cursor: listCursor } : {}) });
    if (!list) return;
    const choices = [
      "新增供应商",
      ...list.items.map((p: any) => `${p.name || p.id} (${p.id})`),
      ...(list.nextCursor ? ["下一页"] : []),
      ...(listHistory.length ? ["上一页"] : []),
      "退出",
    ];
    const choice = await ctx.ui.select("供应商管理", choices, { signal });
    if (!choice || choice === "退出") return;
    if (choice === "下一页") {
      listHistory.push(listCursor);
      listCursor = list.nextCursor;
      continue;
    }
    if (choice === "上一页") {
      listCursor = listHistory.pop();
      continue;
    }
    listCursor = undefined;
    listHistory.length = 0;
    let draft: any;
    if (choice === "新增供应商") {
      const catalog = await call("catalog.list", {});
      if (!catalog) return;
      const api = await ctx.ui.select(
        "API 类型",
        catalog.apis.map((a: any) => a.id),
        { signal },
      );
      if (!api) continue;
      const baseUrl = await ctx.ui.input("Base URL", "https://example.com/v1", { signal });
      if (baseUrl === undefined) continue;
      const id = await ctx.ui.input("供应商 ID", "my-provider", { signal });
      if (!id) continue;
      const auth = await chooseAuth(call, ctx, api, signal);
      if (!auth) continue;
      draft = await call("draft.create", { id, baseUrl, api, auth, models: [] });
    } else {
      const p = list.items[choices.indexOf(choice) - 1];
      if (!p) continue;
      const action = await ctx.ui.select(
        p.name || p.id,
        ["编辑配置与模型", "配置认证", "编辑请求 Header", "删除供应商", "返回"],
        { signal },
      );
      if (action === "删除供应商") {
        if (await ctx.ui.confirm("删除供应商", `删除 ${p.id} 的配置和模型？已有凭据会保留。`, { signal }))
          await call("provider.delete", { providerId: p.id, expectedRevision: p.revision });
        continue;
      }
      if (action === "配置认证") {
        await configureAuth(call, ctx, p, signal);
        continue;
      }
      if (action === "编辑请求 Header") {
        const modelId = await ctx.ui.select("应用范围", ["供应商", ...p.models.map((m: any) => m.id)], { signal });
        if (!modelId) continue;
        const name = await ctx.ui.input("Header 名称", undefined, { signal });
        if (!name) continue;
        const value = await ctx.ui.input("新 Header 值（输入可见；留空删除）", undefined, { signal });
        if (value === undefined) continue;
        await call("headers.set", {
          providerId: p.id,
          expectedRevision: p.revision,
          ...(modelId !== "供应商" ? { modelId } : {}),
          name,
          ...(value ? { value } : {}),
        });
        continue;
      }
      if (action !== "编辑配置与模型") continue;
      draft = await call("draft.open", { providerId: p.id });
    }
    if (!draft) continue;
    try {
      while (!signal?.aborted) {
        const action = await ctx.ui.select(
          `${draft.values.id}：未保存草稿`,
          ["编辑供应商字段", "发现模型", "选择模型", "添加模型", "编辑模型", "保存", "丢弃并返回"],
          { signal },
        );
        if (!action || action === "丢弃并返回") break;
        const ref = { draftId: draft.draftId, revision: draft.revision };
        let next: any;
        if (action === "编辑供应商字段") {
          const fields = Object.keys(providerSchema.properties).filter((k) => k !== "models");
          const labels = fields.map((k) => (providerSchema.properties as any)[k].title || k);
          const label = await ctx.ui.select("选择字段", labels, { signal });
          if (!label) continue;
          const field = fields[labels.indexOf(label)];
          if (["name", "compat"].includes(field) && draft.values[field] !== undefined) {
            const mode = await ctx.ui.select("字段操作", ["修改", "清除"], { signal });
            if (!mode) continue;
            if (mode === "清除") {
              next = await call("draft.patch", { ...ref, set: {}, unset: [field] });
              if (next) draft = next;
              continue;
            }
          }
          const value =
            field === "auth"
              ? await chooseAuth(call, ctx, draft.values.api, signal)
              : await editValue(ctx, field, (providerSchema.properties as any)[field], draft.values[field], signal);
          if (value === undefined) continue;
          next = await call("draft.patch", { ...ref, set: { [field]: value } });
        } else if (action === "发现模型") {
          next = await call("model.discover", ref);
          if (!next && draft.values.auth.mode !== "none")
            ctx.ui.notify("认证不足时，请先保存供应商，再从“配置认证”完成登录。");
        } else if (action === "选择模型") {
          let filter = "",
            offset = 0;
          const selected = new Set<string>(draft.selectedModelIds);
          while (true) {
            const candidates = draft.candidates.filter((c: any) =>
              c.model.id.toLowerCase().includes(filter.toLowerCase()),
            );
            const visible = candidates.slice(offset, offset + 12);
            const labels = visible.map(
              (c: any) =>
                `${selected.has(c.model.id) ? "已选" : "未选"} · ${c.model.id} · ${c.source === "api" ? "接口返回" : c.source === "catalog" ? "目录建议" : "手动"}`,
            );
            const selectedLabel = await ctx.ui.select(
              "选择模型",
              [
                "完成",
                "过滤",
                "全选当前结果",
                "清除当前结果",
                ...labels,
                ...(offset + 12 < candidates.length ? ["下一页"] : []),
                ...(offset ? ["上一页"] : []),
              ],
              { signal },
            );
            if (!selectedLabel) break;
            if (selectedLabel === "完成") {
              next = await call("draft.selectModels", { ...ref, modelIds: [...selected] });
              break;
            }
            if (selectedLabel === "过滤") {
              const v = await ctx.ui.input("过滤模型", filter, { signal });
              if (v !== undefined) {
                filter = v;
                offset = 0;
              }
            } else if (selectedLabel === "全选当前结果") candidates.forEach((c: any) => selected.add(c.model.id));
            else if (selectedLabel === "清除当前结果") candidates.forEach((c: any) => selected.delete(c.model.id));
            else if (selectedLabel === "下一页") offset += 12;
            else if (selectedLabel === "上一页") offset -= 12;
            else {
              const m = visible[labels.indexOf(selectedLabel)]?.model;
              if (m) selected.has(m.id) ? selected.delete(m.id) : selected.add(m.id);
            }
          }
        } else if (action === "添加模型") {
          const id = await ctx.ui.input("模型 ID", undefined, { signal });
          if (!id) continue;
          next = await call("draft.upsertModel", {
            ...ref,
            model: { id, name: id, input: ["text"], contextWindow: 128000, maxTokens: 16384, reasoning: false },
          });
        } else if (action === "编辑模型") {
          const id = await ctx.ui.select(
            "模型",
            draft.values.models.map((m: any) => m.id),
            { signal },
          );
          if (!id) continue;
          const model = draft.values.models.find((m: any) => m.id === id);
          const mode = await ctx.ui.select("模型操作", ["编辑字段", "应用预设", "删除模型"], { signal });
          if (!mode) continue;
          if (mode === "删除模型") next = await call("draft.removeModel", { ...ref, modelId: id });
          else if (mode === "应用预设") {
            const filter = await ctx.ui.input("筛选预设", id, { signal });
            if (filter === undefined) continue;
            let cursor: string | undefined;
            while (true) {
              const presets = await call("catalog.presets", {
                api: draft.values.api,
                modelId: id,
                filter,
                limit: 12,
                ...(cursor ? { cursor } : {}),
              });
              if (!presets) break;
              const labels = [...presets.items.map((p: any) => p.id), ...(presets.nextCursor ? ["下一页"] : [])];
              const selected = await ctx.ui.select("模型预设", labels, { signal });
              if (!selected) break;
              if (selected === "下一页") {
                cursor = presets.nextCursor;
                continue;
              }
              next = await call("draft.applyPreset", { ...ref, modelId: id, presetId: selected });
              break;
            }
          } else {
            const fields = Object.keys(modelSchema.properties).filter((k) => k !== "id");
            const labels = fields.map((k) => (modelSchema.properties as any)[k].title || k);
            const selected = await ctx.ui.select("模型字段", labels, { signal });
            if (!selected) continue;
            const field = fields[labels.indexOf(selected)];
            if (model[field] !== undefined) {
              const mode = await ctx.ui.select("字段操作", ["修改", "清除"], { signal });
              if (!mode) continue;
              if (mode === "清除") {
                const updated = { ...model };
                delete updated[field];
                next = await call("draft.upsertModel", { ...ref, model: updated });
                if (next) draft = next;
                continue;
              }
            }
            const value = await editValue(ctx, field, (modelSchema.properties as any)[field], model[field], signal);
            if (value === undefined) continue;
            next = await call("draft.upsertModel", { ...ref, model: { ...model, [field]: value } });
          }
        } else if (action === "保存") {
          const validation = await call("draft.validate", ref);
          if (!validation) continue;
          if (
            await ctx.ui.confirm(
              "保存配置",
              `${draft.values.id}，${draft.values.models.length} 个模型。保存后立即同步到 Pi。`,
              { signal },
            )
          ) {
            const saved = await execute("draft.commit", ref);
            if (saved.effects.config === "committed") {
              if (saved.status === "succeeded") ctx.ui.notify("配置已保存。");
              draft = undefined;
              break;
            }
          }
        }
        if (next) draft = next;
      }
    } finally {
      if (draft)
        await runUiOperation(service, ctx, "draft.discard", { draftId: draft.draftId, revision: draft.revision });
    }
  }
}
async function chooseAuth(call: any, ctx: ExtensionContext, api: string, signal?: AbortSignal) {
  const list = await call("catalog.list", { api });
  if (!list) return;
  const labels = list.authMethods.map((method: any) => method.label);
  const selected = await ctx.ui.select("认证方式", labels, { signal });
  return selected === undefined ? undefined : list.authMethods[labels.indexOf(selected)]?.value;
}
async function editValue(ctx: ExtensionContext, key: string, schema: any, current: any, signal?: AbortSignal) {
  const options = schema.anyOf?.map((s: any) => s.const);
  if (options?.every((v: any) => typeof v === "string")) return ctx.ui.select(schema.title || key, options, { signal });
  if (schema.type === "boolean") {
    const v = await ctx.ui.select(schema.title || key, ["是", "否"], { signal });
    return v === undefined ? undefined : v === "是";
  }
  if (schema.type === "object" || schema.type === "array") {
    const value = await ctx.ui.editor(
      schema.title || key,
      JSON.stringify(current ?? (schema.type === "array" ? [] : {}), null, 2),
    );
    if (value === undefined) return;
    try {
      return JSON.parse(value);
    } catch {
      ctx.ui.notify("JSON 格式错误，草稿未修改。", "error");
      return;
    }
  }
  const value = await ctx.ui.input(schema.title || key, current === undefined ? undefined : String(current), {
    signal,
  });
  if (value === undefined) return;
  return schema.type === "number" || schema.type === "integer" ? Number(value) : value;
}
async function configureAuth(call: any, ctx: ExtensionContext, p: any, signal?: AbortSignal) {
  const target = { providerId: p.id, expectedRevision: p.revision };
  const choice = await ctx.ui.select(
    "认证操作",
    p.auth.mode === "oauth"
      ? ["OAuth 登录", "粘贴 OAuth JSON", "引用服务端 OAuth JSON", "清除认证"]
      : ["设置 API Key", "清除认证"],
    { signal },
  );
  if (choice === "OAuth 登录") await call("auth.begin", target);
  else if (choice === "清除认证") {
    if (await ctx.ui.confirm("清除认证", "确认移除已存认证？", { signal })) await call("auth.clear", target);
  } else if (choice === "设置 API Key" || choice === "粘贴 OAuth JSON") {
    const value = await ctx.ui.input(`${choice}（输入可见，不回填已有内容）`, undefined, { signal });
    if (value) await call(choice === "设置 API Key" ? "auth.configure" : "auth.import", { ...target, value });
  } else if (choice === "引用服务端 OAuth JSON") {
    const path = await ctx.ui.input("Pi 服务端文件路径（刷新会写回此文件）", undefined, { signal });
    if (path) await call("auth.file", { ...target, path });
  }
}
