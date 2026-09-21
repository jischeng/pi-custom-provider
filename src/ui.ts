import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Result } from "./operations/types";
import type { ProviderOperations } from "./ui/operations";
import { providerPanel } from "./ui/provider-panel";
import { cleared, settingsPanel, selectModels, type Field } from "./ui/components";

type Call = (name: string, args: unknown) => Promise<any>;
const fields = (schema: any, values: any, omit: string[] = []): Field[] =>
  Object.entries(schema.properties)
    .filter(([key]) => !omit.includes(key))
    .map(([id, field]: [string, any]) => ({
      id,
      label: field.title || id,
      schema: field,
      value: values[id],
    }));

/** Presentation only: schemas and results come from the operations contract, never the domain implementation. */
export async function runSetup(operations: ProviderOperations, ctx: ExtensionContext, signal?: AbortSignal) {
  const execute = async (name: string, args: unknown): Promise<Result> => {
    const result = await operations.invoke(name, args, signal);
    if (result.status === "failed")
      await ctx.ui.select(
        `${operations.describe(name).title}: ${result.error?.message || "Operation cancelled."}${result.error?.fields?.length ? ` Fields: ${[...new Set(result.error.fields.map((field) => field.path))].join(", ")}.` : ""}${result.effects.config === "committed" ? " Configuration saved." : ""}`,
        ["Back"],
        { signal },
      );
    for (const warning of result.warnings) ctx.ui.notify(warning.message, "warning");
    return result;
  };
  const call: Call = async (name, args) => {
    const result = await execute(name, args);
    return result.status === "succeeded" ? result.data : undefined;
  };
  const providerSchema = operations.describe("provider.create").inputSchema;
  const modelSchema = (operations.describe("draft.upsertModel").inputSchema as any).properties.model;
  const allPages = async (name: string, args: any = {}) => {
    const items: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(name, { ...args, limit: 200, ...(cursor ? { cursor } : {}) });
      if (!page) return;
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && !signal?.aborted);
    return items;
  };
  while (!signal?.aborted) {
    const providers = await allPages("provider.list");
    if (!providers) return;
    const choice = await settingsPanel(
      ctx,
      [],
      [
        { id: "$create", label: "Create provider", description: "Add a provider. Type to search existing providers." },
        ...providers.map((p: any) => ({
          id: p.id,
          label: p.name && p.name !== p.id ? `${p.id} (${p.name})` : p.id,
          description: `Provider ID: ${p.id}`,
        })),
      ],
      async () => undefined,
      signal,
      { title: "Providers" },
    );
    if (!choice) return;
    let draft: any;
    let stored = providers.find((p: any) => p.id === choice);
    if (choice === "$create") {
      const catalog = await call("catalog.list", {});
      if (!catalog) continue;
      const api = await ctx.ui.select(
        "API type",
        catalog.apis.map((item: any) => item.id),
        { signal },
      );
      if (!api) continue;
      const baseUrl = await ctx.ui.input("Base URL", "https://example.com/v1", { signal });
      if (baseUrl === undefined) continue;
      const id = await ctx.ui.input("Provider ID", "my-provider", { signal });
      if (!id) continue;
      const auth = await chooseAuth(call, ctx, api, signal);
      if (!auth) continue;
      draft = await call("draft.create", { id, baseUrl, api, auth, models: [] });
    } else draft = await call("draft.open", { providerId: choice });
    if (!draft) continue;
    const initialRevision = draft.revision;
    const ref = () => ({ draftId: draft.draftId, revision: draft.revision });
    const save = async () => {
      const result = await execute("draft.commit", ref());
      if (result.effects.config === "committed") {
        draft = undefined;
        if (result.status === "succeeded") ctx.ui.notify("Configuration saved.");
        return true;
      }
      return false;
    };
    try {
      await providerPanel(
        ctx,
        () => ({
          title: `Provider: ${draft.values.id}`,
          models: draft.values.models.map((m: any) => ({
            id: `model:${m.id}`,
            label: m.name && m.name !== m.id ? `${m.id} (${m.name})` : m.id,
          })),
          actions: [
            { id: "$add", label: "Add model" },
            { id: "$discover", label: "Discover models" },
            { id: "$models", label: "Select models" },
            { id: "$settings", label: "Provider settings" },
            ...(stored
              ? [
                  { id: "$credentials", label: "Credentials" },
                  { id: "$headers", label: "Request headers" },
                ]
              : []),
            { id: "$save", label: "Save changes" },
            { id: "$discard", label: "Discard changes" },
            ...(stored ? [{ id: "$delete", label: "Delete provider" }] : []),
          ],
        }),
        async (action) => {
          const providerContext = `Provider: ${draft.values.id}`;
          if (action === "$discard") return false;
          if (action === "$settings") {
            while (!signal?.aborted) {
              const setting = await settingsPanel(
                ctx,
                fields(providerSchema, draft.values, ["models", "auth"]),
                [
                  { id: "$auth", label: "Authentication method", value: draft.values.auth.mode },
                  { id: "$back", label: "Back to models" },
                ],
                async (id, value) => {
                  const next = await call("draft.patch", {
                    ...ref(),
                    set: value === cleared ? {} : { [id]: value },
                    ...(value === cleared ? { unset: [id] } : {}),
                  });
                  if (next) draft = next;
                  return draft.values[id];
                },
                signal,
                { context: providerContext, title: "Provider settings" },
              );
              if (setting !== "$auth") break;
              const auth = await chooseAuth(call, ctx, draft.values.api, signal);
              if (auth) draft = (await call("draft.patch", { ...ref(), set: { auth } })) || draft;
            }
          } else if (action === "$credentials" || action === "$headers") {
            if (draft.revision !== initialRevision) {
              await ctx.ui.select(
                "Save or discard your changes before updating stored credentials or headers.",
                ["Back"],
                { signal },
              );
              return true;
            }
            if (action === "$credentials") await configureAuth(call, ctx, stored, signal);
            else await editHeaders(call, ctx, stored, signal);
            stored = await call("provider.get", { providerId: stored.id });
            if (!stored) return false;
            await call("draft.discard", ref());
            draft = await call("draft.open", { providerId: stored.id });
          } else if (action === "$discover") {
            const next = await call("model.discover", ref());
            if (next) draft = next;
          } else if (action === "$models") {
            const ids = await selectModels(ctx, draft.candidates, draft.selectedModelIds, signal, providerContext);
            if (ids) draft = (await call("draft.selectModels", { ...ref(), modelIds: ids })) || draft;
          } else if (action === "$add") {
            const model: Record<string, any> = { id: "" };
            while (!signal?.aborted) {
              const choice = await settingsPanel(
                ctx,
                fields(modelSchema, model),
                [
                  { id: "$add", label: "Add model" },
                  { id: "$cancel", label: "Cancel" },
                ],
                async (id, value) => {
                  if (value === cleared) delete model[id];
                  else model[id] = value;
                  return model[id];
                },
                signal,
                { context: providerContext, title: "Add model" },
              );
              if (choice !== "$add") break;
              if (draft.values.models.some((item: any) => item.id === model.id)) {
                await ctx.ui.select("This model ID already exists. Open the existing model to edit it.", ["Back"], {
                  signal,
                });
                continue;
              }
              const next = await call("draft.upsertModel", { ...ref(), model });
              if (next) {
                draft = next;
                break;
              }
            }
          } else if (action.startsWith("model:")) {
            const modelId = action.slice(6);
            let model = draft.values.models.find((item: any) => item.id === modelId);
            const modelAction = await settingsPanel(
              ctx,
              fields(modelSchema, model, ["id"]),
              [
                { id: "$preset", label: "Apply model preset" },
                { id: "$remove", label: "Remove model" },
                { id: "$back", label: "Back to provider" },
              ],
              async (id, value) => {
                const updated = { ...model };
                if (value === cleared) delete updated[id];
                else updated[id] = value;
                const next = await call("draft.upsertModel", { ...ref(), model: updated });
                if (next) {
                  draft = next;
                  model = draft.values.models.find((item: any) => item.id === modelId);
                }
                return model[id];
              },
              signal,
              { context: providerContext, title: `Model: ${modelId}` },
            );
            if (modelAction === "$remove") draft = (await call("draft.removeModel", { ...ref(), modelId })) || draft;
            else if (modelAction === "$preset") {
              const presets = await allPages("catalog.presets", { api: draft.values.api, modelId });
              if (!presets) return true;
              const presetId = await settingsPanel(
                ctx,
                [],
                presets.map((p: any) => ({ id: p.id, label: p.id })),
                async () => undefined,
                signal,
              );
              if (presetId) draft = (await call("draft.applyPreset", { ...ref(), modelId, presetId })) || draft;
            }
          } else if (action === "$save") {
            if (
              await ctx.ui.confirm(
                "Save configuration",
                `Save ${draft.values.id} with ${draft.values.models.length} models?`,
                { signal },
              )
            )
              await save();
          } else if (action === "$delete") {
            if (
              await ctx.ui.confirm("Delete provider", `Delete ${stored.id}? Existing credentials will be retained.`, {
                signal,
              })
            ) {
              if (await call("provider.delete", { providerId: stored.id, expectedRevision: stored.revision }))
                return false;
            }
          }
          return Boolean(draft);
        },
        signal,
      );
    } finally {
      if (draft) await operations.invoke("draft.discard", ref());
    }
  }
}

async function chooseAuth(call: Call, ctx: ExtensionContext, api: string, signal?: AbortSignal) {
  const list = await call("catalog.list", { api });
  if (!list) return;
  const selected = await ctx.ui.select(
    "Authentication method",
    list.authMethods.map((method: any) => method.label),
    { signal },
  );
  return list.authMethods.find((method: any) => method.label === selected)?.value;
}
async function configureAuth(call: Call, ctx: ExtensionContext, provider: any, signal?: AbortSignal) {
  const target = { providerId: provider.id, expectedRevision: provider.revision };
  const choice = await ctx.ui.select(
    "Credentials",
    provider.auth.mode === "oauth"
      ? ["Sign in", "Import OAuth JSON", "Use OAuth file", "Clear credentials"]
      : ["Set API key", "Clear credentials"],
    { signal },
  );
  if (choice === "Sign in") await call("auth.begin", target);
  else if (choice === "Clear credentials") {
    if (await ctx.ui.confirm("Clear credentials", "Remove stored credentials?", { signal }))
      await call("auth.clear", target);
  } else if (choice === "Set API key" || choice === "Import OAuth JSON") {
    const value = await ctx.ui.input(`${choice} (input is visible)`, undefined, { signal });
    if (value) await call(choice === "Set API key" ? "auth.configure" : "auth.import", { ...target, value });
  } else if (choice === "Use OAuth file") {
    const path = await ctx.ui.input("File path on the Pi server (refreshes are written back)", undefined, { signal });
    if (path) await call("auth.file", { ...target, path });
  }
}
async function editHeaders(call: Call, ctx: ExtensionContext, provider: any, signal?: AbortSignal) {
  const scopes = ["Provider", ...provider.models.map((model: any) => `Model: ${model.id}`)];
  const scope = await ctx.ui.select("Header scope", scopes, { signal });
  if (!scope) return;
  const name = await ctx.ui.input("Header name", undefined, { signal });
  if (!name) return;
  const value = await ctx.ui.input("Header value (input is visible; blank deletes)", undefined, { signal });
  if (value === undefined) return;
  await call("headers.set", {
    providerId: provider.id,
    expectedRevision: provider.revision,
    ...(scope === "Provider" ? {} : { modelId: scope.slice("Model: ".length) }),
    name,
    ...(value ? { value } : {}),
  });
}
