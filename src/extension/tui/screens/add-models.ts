import { providerPanel } from "../provider-panel";
import { cleared, settingsPanel } from "../components";
import { column } from "../format";
import type { Field } from "../types";
import type { Screen } from "../client";
import type { ProviderSession } from "../session";
import { modelScreen } from "./model";

export type ModelActions = {
  editModel(modelId: string): Promise<void>;
  applyPreset(modelId: string): Promise<void>;
};

/**
 * Discovery plus the model selection list. Choosing a model opens its own menu, so a model can
 * be added, configured and preset without leaving the screen.
 */
export async function addModelsScreen(screen: Screen, session: ProviderSession, actions: ModelActions): Promise<void> {
  const { client, ctx, signal } = screen;
  const result = await session.discover();
  if (result.status === "cancelled") return;

  const modelSchema = (client.schema("draft.upsertModel") as any).properties.model;
  const fields = (values: any): Field[] =>
    Object.entries(modelSchema.properties).map(([id, field]: [string, any]) => ({
      id,
      label: field.title || id,
      schema: field,
      value: values[id],
    }));
  /** Manual entry is a plain form; it only returns once the draft actually holds the model. */
  const addManually = async (): Promise<{ id: string } | undefined> => {
    const model: Record<string, any> = { id: "" };
    while (!signal?.aborted) {
      const choice = await settingsPanel(
        ctx,
        fields(model),
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
        { context: `Provider: ${session.values.id}`, title: "Add model" },
      );
      if (choice !== "$add") return undefined;
      if (session.models.some((item: any) => item.id === model.id)) {
        ctx.ui.notify("This model ID already exists. Open the existing model to edit it.", "error");
        continue;
      }
      await session.upsertModel(model);
      const stored = session.model(model.id);
      // A rejected write reopens the form with the entered values instead of dropping them.
      if (stored) return stored;
    }
    return undefined;
  };

  const models = session.candidates.map((item: any) => item.model);
  const selected = new Set(session.selectedModelIds);
  const toggle = async (modelId: string) => {
    const next = new Set(selected);
    if (next.has(modelId)) next.delete(modelId);
    else next.add(modelId);
    const saved = await session.selectModels([...next]);
    selected.clear();
    for (const value of saved) selected.add(value);
  };
  /** The per-model menu is a plain list of actions; picking one closes it. */
  const modelMenu = async (modelId: string): Promise<string | undefined> => {
    let choice: string | undefined;
    await providerPanel(
      ctx,
      () => ({
        title: modelId,
        sections: [
          {
            heading: "Actions",
            items: [
              { id: "$toggle", label: selected.has(modelId) ? "Remove from provider" : "Add to provider" },
              ...(selected.has(modelId) ? [{ id: "$edit", label: "Edit model config", screen: true }] : []),
              ...(selected.has(modelId) ? [{ id: "$preset", label: "Apply model preset", screen: true }] : []),
            ],
          },
        ],
      }),
      async (action) => {
        choice = action;
        return false;
      },
      signal,
    );
    return choice;
  };

  await providerPanel(
    ctx,
    () => ({
      title: "Add model",
      startAt: "Models",
      sections: [
        {
          heading: "Actions",
          items: [{ id: "$manual", label: "Enter model manually", screen: true }],
        },
        {
          heading: "Models",
          items: models.map((model: any) => ({
            id: `candidate:${model.id}`,
            label: `${column(model.id, 36)}${selected.has(model.id) ? "Yes" : "No"}`,
            screen: true,
          })),
        },
      ],
    }),
    async (id) => {
      if (id === "$manual") {
        const model = await addManually();
        if (model && !models.some((item: any) => item.id === model.id)) {
          models.push(model);
          selected.add(model.id);
        }
        return true;
      }
      if (!id.startsWith("candidate:")) return false;
      const modelId = id.slice("candidate:".length);
      const choice = await modelMenu(modelId);
      if (choice === "$toggle") await toggle(modelId);
      else if (choice === "$edit") await actions.editModel(modelId);
      else if (choice === "$preset") await actions.applyPreset(modelId);
      return true;
    },
    signal,
  );
  await session.commit();
}
