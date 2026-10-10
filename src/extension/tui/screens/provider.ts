import { providerPanel } from "../provider-panel";
import { confirmScreen, inputScreen, selectScreen, settingsPanel, cleared } from "../components";
import { applyFieldPlan, needsScreen, planField, selectRow, valueLabel } from "../field-edit";
import { column, formatValue } from "../format";
import type { Screen } from "../client";
import type { ProviderSession } from "../session";
import type { Field } from "../types";
import { addModelsScreen } from "./add-models";
import { applyModelPreset, modelScreen } from "./model";
import { applyCredentialChoice, credentialChoices } from "./credentials";

/** The provider page: identity and authentication fields, then the models it serves. */
export async function providerScreen(screen: Screen, session: ProviderSession): Promise<void> {
  const { client, ctx, signal } = screen;
  const schema = (client.schema("provider.create") as any).properties ?? {};
  /** The catalog names each authentication method; the draft only stores its id. */
  let authMethods: any[] = [];
  const loadAuthMethods = async () => {
    const catalog = await client.call("catalog.list", { api: session.values.api });
    authMethods = catalog?.authMethods ?? [];
  };
  await loadAuthMethods();
  /** Provider and per-model headers are both real request headers; the row shows how many exist. */
  const headerCount = () =>
    (session.saved?.headers?.length ?? 0) +
    ((session.saved?.modelHeaders ?? []) as any[]).reduce((total, entry) => total + (entry.names?.length ?? 0), 0);
  /** Provider fields use the same planner as model fields, so one rule covers both pages. */
  const plan = (field: string) => {
    const fieldSchema = schema[field];
    const value = field === "authHeader" ? session.values.authHeader || "auto" : session.values[field];
    return planField({ title: fieldSchema?.title || field, schema: fieldSchema, value });
  };
  const editField = async (field: string, chosen?: any) => {
    const outcome = await applyFieldPlan(ctx, plan(field), chosen, signal);
    if (!outcome.changed) return;
    await session.patch({ [field]: outcome.value });
    await session.commit();
  };
  const editHeaders = async () => {
    const scopes = ["Provider", ...session.models.map((model: any) => `Model: ${model.id}`)];
    const header: Record<string, string> = { scope: scopes[0], name: "", value: "" };
    const choice = await settingsPanel(
      ctx,
      [
        {
          id: "scope",
          label: "Scope",
          schema: { anyOf: scopes.map((scope) => ({ const: scope })) },
          value: header.scope,
        },
        { id: "name", label: "Header name", schema: { type: "string" }, value: header.name },
        { id: "value", label: "Header value (blank deletes)", schema: { type: "string" }, value: header.value },
      ] as Field[],
      [
        { id: "$save", label: "Save header" },
        { id: "$cancel", label: "Cancel" },
      ],
      async (id, value) => {
        header[id] = value === cleared || value === undefined ? "" : String(value);
        return header[id];
      },
      signal,
      { context: `Provider: ${session.values.id}`, title: "Request header" },
    );
    if (choice !== "$save" || !header.name) return;
    await client.call("headers.set", {
      providerId: session.saved.id,
      expectedRevision: session.saved.revision,
      ...(header.scope === "Provider" ? {} : { modelId: header.scope.slice("Model: ".length) }),
      name: header.name,
      ...(header.value ? { value: header.value } : {}),
    });
  };
  const authKey = (auth: any) => (auth.mode === "oauth" ? `oauth:${auth.methodId}` : auth.mode);
  /** The catalog names each method; the mode itself is only a fallback. */
  const authModeLabel: Record<string, string> = { none: "None", api_key: "API key", oauth: "OAuth" };
  const currentAuthLabel = () =>
    authMethods.find((method: any) => authKey(method.value) === authKey(session.values.auth))?.label ??
    authModeLabel[session.values.auth.mode] ??
    session.values.auth.mode;
  /** Which authentication methods this provider actually has, for the credential actions. */
  const providerAuth = (): ("api_key" | "oauth")[] => {
    if (!session.isBuiltin) return [session.values.auth.mode === "oauth" ? "oauth" : "api_key"];
    return authMethods
      .map((method: any) => method.value?.mode)
      .filter((mode: string) => mode === "api_key" || mode === "oauth");
  };
  const credentials = () =>
    credentialChoices({
      auth: providerAuth(),
      hasCredential: !!session.saved?.auth.hasCredential,
      // Pi owns the record of a provider it ships, so the file-backed path has nowhere to go.
      allowFile: !session.isBuiltin,
    });

  /** Credentials belong to the saved provider, so a configured one reopens its draft afterwards. */
  const editSaved = async (work: () => Promise<void>) => {
    await work();
    if (session.isBuiltin) return session.refresh();
    const id = session.values.id;
    await session.discard();
    const reopened = await client.call("draft.open", { providerId: id });
    return !!reopened;
  };

  /** The schema carries the name a user should read; the field key is only a fallback. */
  const fieldRow = (field: string, value?: any) => ({
    id: `field:${field}`,
    label: `${column(schema[field]?.title || field, 22)}${valueLabel(schema[field], value)}`,
    screen: needsScreen(plan(field)),
    ...selectRow(plan(field)),
  });
  /** An action is not a setting: it only shows a value column when it actually has one. */
  const actionRow = (id: string, name: string, value?: any) => ({
    id,
    label: value === undefined ? name : `${column(name, 22)}${formatValue(value)}`,
    screen: true,
  });
  /** A row that only reports a value Pi owns. */
  const readRow = (name: string, value?: any) => ({
    id: `read:${name}`,
    label: `${column(name, 22)}${formatValue(value)}`,
  });
  /** An action that also offers a fixed set of choices: the panel renders the list in place. */
  const choiceRow = (id: string, name: string, value: any, choices: { id: string; label: string; value?: any }[]) => ({
    id,
    label: `${column(name, 22)}${formatValue(value)}`,
    choices,
  });

  await providerPanel(
    ctx,
    () => ({
      title: `Provider: ${session.values.id}`,
      startAt: "Models",
      sections: [
        {
          // Pi owns the identity and endpoint of a provider it ships, so those rows only report.
          heading: "Provider",
          items: session.isBuiltin
            ? [
                readRow("Provider ID", session.values.id),
                readRow("Display name", session.values.name),
                readRow("API type", valueLabel(schema.api, session.values.api)),
                readRow("Base URL", session.values.baseUrl),
                readRow("Models from", "Pi (built-in)"),
              ]
            : [
                fieldRow("id", session.values.id),
                fieldRow("name", session.values.name),
                fieldRow("api", session.values.api),
                fieldRow("baseUrl", session.values.baseUrl),
                fieldRow("authHeader", session.values.authHeader || "auto"),
              ],
        },
        {
          // Credentials and headers belong to the saved provider, so they are their own group.
          heading: "Authentication",
          items: [
            // A provider Pi ships already has its authentication method; only its credential
            // is the user's to choose.
            ...(session.isBuiltin
              ? [readRow("Authentication method", currentAuthLabel())]
              : session.saved?.auth.hasCredential || session.saved?.auth.status !== "missing"
                ? [
                    choiceRow(
                      "$auth",
                      "Authentication method",
                      currentAuthLabel(),
                      authMethods.map((method: any, index: number) => ({
                        id: String(index),
                        label: method.label,
                        value: method.value,
                      })),
                    ),
                  ]
                : []),
            ...(credentials().length
              ? [choiceRow("$credentials", "Credentials", session.saved?.auth.status, credentials())]
              : []),
            ...(session.isBuiltin ? [] : [actionRow("$headers", "Request headers", headerCount() || undefined)]),
          ],
        },
        {
          heading: "Actions",
          items: session.isBuiltin
            ? session.saved?.modelOverrides
              ? [actionRow("$revert", "Revert to Pi defaults")]
              : []
            : session.saved
              ? [actionRow("$delete", "Delete provider")]
              : [],
        },
        {
          heading: "Models",
          items: [
            ...(session.isBuiltin ? [] : [{ id: "$add", label: "Add model", screen: true }]),
            ...session.models.map((model: any) => {
              const adjusted = session.isBuiltin && model.id in (session.saved?.modelOverrides ?? {});
              const label = model.name && model.name !== model.id ? `${model.id} (${model.name})` : model.id;
              return { id: `model:${model.id}`, label: adjusted ? `${label}  (adjusted)` : label, screen: true };
            }),
          ],
        },
      ],
    }),
    async (action, chosen) => {
      if (action.startsWith("field:")) {
        const api = session.values.api;
        await editField(action.slice("field:".length), chosen);
        // The api decides which authentication methods exist, so they are re-read after a change.
        if (session.values.api !== api) await loadAuthMethods();
      } else if (action === "$add")
        await addModelsScreen(screen, session, {
          editModel: (modelId) => modelScreen(screen, session, modelId),
          applyPreset: (modelId) => applyModelPreset(screen, session, modelId),
        });
      else if (action.startsWith("model:")) await modelScreen(screen, session, action.slice("model:".length));
      else if (action === "$auth") {
        if (chosen) {
          await session.patch({ auth: chosen });
          await session.commit();
        }
      } else if (action === "$credentials") {
        const provider = session.saved;
        if (typeof chosen !== "string") return true;
        const done = await editSaved(() =>
          applyCredentialChoice(screen, provider.id, provider.revision, chosen).then(() => undefined),
        );
        if (!done) return false;
      } else if (action === "$headers") {
        if (!(await editSaved(editHeaders))) return false;
      } else if (action === "$revert") {
        const provider = session.saved;
        if (
          await confirmScreen(
            ctx,
            "Revert to Pi defaults",
            `Remove every adjustment for ${provider.id}? Pi's own models and login stay.`,
            signal,
          )
        ) {
          if (await client.call("provider.delete", { providerId: provider.id, expectedRevision: provider.revision }))
            return false;
        }
      } else if (action.startsWith("read:")) return true;
      else if (action === "$delete") {
        const provider = session.saved;
        if (
          await confirmScreen(
            ctx,
            "Delete provider",
            `Delete ${provider.id}? Existing credentials will be retained.`,
            signal,
          )
        ) {
          if (await client.call("provider.delete", { providerId: provider.id, expectedRevision: provider.revision }))
            return false;
        }
      }
      return true;
    },
    signal,
  );
}
