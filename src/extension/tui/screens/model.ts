import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { compatFieldNames, compatFieldValues, thinkingLevelValues } from "../../../domain/catalog";
import { providerPanel } from "../provider-panel";
import { settingsPanel } from "../components";
import { applyFieldPlan, needsScreen, planField, selectRow, valueLabel, type Choice } from "../field-edit";
import { column, formatValue, unset } from "../format";
import { readPath, type ProviderSession } from "../session";
import type { Screen } from "../client";
import type { ProviderSection } from "../types";

/** The model editor: every row shows what the runtime will use, and the planner decides how it edits. */
export async function modelScreen(screen: Screen, session: ProviderSession, modelId: string): Promise<void> {
  const { ctx, signal } = screen;
  // A provider Pi ships is edited through per-model patches, so the patch schema is the target.
  const builtin = session.isBuiltin;
  const modelSchema = builtin
    ? screen.client.schema("model.override")
    : (screen.client.schema("draft.upsertModel") as any).properties.model;
  const schemaAt = (path: string): any =>
    path.split(".").reduce((schema: any, key) => schema?.properties?.[key], modelSchema);
  /** The schema carries the name a user should read; the path is only a fallback. */
  const nameAt = (path: string): string => schemaAt(path)?.title || path.split(".").at(-1)!;
  const api = (): string => session.resolve(modelId).api;
  /** Compat values Pi is known to use for this API; an open-ended set, so it cycles in place. */
  const compatChoices = (key: string): Choice[] =>
    compatFieldValues(api() as any, key).map((value: string) => ({ label: value, value }));

  /** How a row is edited; the same call also decides whether the row needs the editor area. */
  const plan = (path: string) => {
    if (path.startsWith("thinkingLevelMap.")) {
      const level = path.slice("thinkingLevelMap.".length);
      // Pi decides which levels a model supports; the mapping only renames them.
      const resolved = session.resolve(modelId);
      const mapping = (resolved.thinkingLevelMap ?? {}) as Record<string, string | null | undefined>;
      const supported = new Set<string>(getSupportedThinkingLevels(resolved));
      return planField({
        title: level,
        schema: schemaAt(path),
        // An unset level resolves to its own name, so that is what the list marks as current.
        value: supported.has(level) ? (mapping[level] ?? level) : null,
        choices: [
          { label: "unsupported", value: null },
          ...thinkingLevelValues(api() as any).map((value: string) => ({ label: value, value })),
        ],
      });
    }
    if (path.startsWith("compat.")) {
      const key = path.slice("compat.".length);
      return planField({
        title: key,
        schema: schemaAt(path),
        value: (session.resolve(modelId).compat as Record<string, any>)?.[key],
        choices: compatChoices(key),
      });
    }
    return planField({
      title: schemaAt(path)?.title || path,
      schema: schemaAt(path),
      value: readPath(session.resolve(modelId), path.split(".")),
    });
  };
  const editField = async (path: string, chosen?: any) => {
    const outcome = await applyFieldPlan(ctx, plan(path), chosen, signal);
    if (!outcome.changed) return;
    if (builtin) await session.overrideModel(modelId, path, outcome.value);
    else await session.writeModelField(modelId, path, outcome.value);
  };

  const sections = (): ProviderSection[] => {
    const model = session.resolve(modelId);
    const compat = (model.compat ?? {}) as Record<string, any>;
    // `screen` comes from the same planner that performs the edit, so the two cannot disagree.
    const row = (id: string, path: string | undefined, name: string, value: any) => {
      const fieldPlan = path ? plan(path) : undefined;
      return {
        id,
        label: `${column(name)}${path ? valueLabel(schemaAt(path), value) : formatValue(value)}`,
        screen: fieldPlan ? needsScreen(fieldPlan) : false,
        ...(fieldPlan ? selectRow(fieldPlan) : {}),
      };
    };
    // Compat lists only the keys this model configures; extra keys are added explicitly.
    const compatKeys = Object.keys(compat).sort();
    const available = compatFieldNames(model.api as any).filter((key: string) => !(key in compat));
    const levels = Object.keys(modelSchema.properties?.thinkingLevelMap?.properties ?? {});
    const override = builtin ? session.overrideOf(modelId) : {};
    const patched = (key: string) => (key in override ? "  (adjusted)" : "");
    return [
      {
        heading: "Actions",
        items: builtin
          ? [
              // Pi owns the endpoint, API and model list of a provider it ships; only patches are ours.
              { id: "$reset", label: "Reset all adjustments" },
            ]
          : [
              { id: "$preset", label: "Apply model preset", screen: true },
              { id: "$remove", label: "Remove model" },
            ],
      },
      {
        heading: "Model",
        items: [
          row("field:name", "name", nameAt("name") + patched("name"), model.name),
          ...(builtin
            ? [
                { id: "read:api", label: `${column(nameAt("api"))}${valueLabel(schemaAt("api"), model.api)}` },
                {
                  id: "read:baseUrl",
                  label: `${column(nameAt("baseUrl"))}${formatValue(model.baseUrl)}`,
                },
              ]
            : [
                row("field:api", "api", nameAt("api"), model.api),
                row("field:baseUrl", "baseUrl", nameAt("baseUrl"), model.baseUrl),
              ]),
          row("field:reasoning", "reasoning", nameAt("reasoning") + patched("reasoning"), model.reasoning),
          ...["text", "image"].map((item) =>
            row(
              `array:input:${item}`,
              undefined,
              `${nameAt("input")} ${item}`,
              (model.input as string[]).includes(item),
            ),
          ),
          row(
            "field:contextWindow",
            "contextWindow",
            nameAt("contextWindow") + patched("contextWindow"),
            model.contextWindow,
          ),
          row("field:maxTokens", "maxTokens", nameAt("maxTokens") + patched("maxTokens"), model.maxTokens),
        ],
      },
      {
        heading: "Pricing",
        items: Object.entries((model.cost ?? {}) as Record<string, any>)
          .filter(([key]) => key !== "tiers")
          .map(([key, value]) =>
            row(`field:cost.${key}`, `cost.${key}`, nameAt(`cost.${key}`) + patched(`cost.${key}`), value),
          )
          .concat(
            model.cost?.tiers ? [row("field:cost.tiers", "cost.tiers", nameAt("cost.tiers"), model.cost.tiers)] : [],
          ),
      },
      {
        heading: "Thinking level mapping",
        items: levels.map((level) => {
          const path = `thinkingLevelMap.${level}`;
          const fieldPlan = plan(path);
          return row(`level:${level}`, path, nameAt(path), fieldPlan.kind === "in-place" ? fieldPlan.value : unset);
        }),
      },
      {
        heading: "Compat",
        items: [
          ...compatKeys.map((key) =>
            row(`compat:${key}`, `compat.${key}`, nameAt(`compat.${key}`) + patched(`compat.${key}`), compat[key]),
          ),
          ...(available.length
            ? [
                {
                  id: "$compatAdd",
                  label: "Add compat field",
                  choices: available.map((key: string) => ({ id: key, label: key, value: key })),
                },
              ]
            : []),
          ...(compatKeys.length
            ? [
                {
                  id: "$compatRemove",
                  label: "Remove compat field",
                  choices: compatKeys.map((key) => ({ id: key, label: key, value: key })),
                },
              ]
            : []),
        ],
      },
    ];
  };

  await providerPanel(
    ctx,
    () => ({ title: `Model: ${modelId}`, sections: sections() }),
    async (id, chosen) => {
      if (id.startsWith("field:")) await editField(id.slice("field:".length), chosen);
      else if (id.startsWith("level:")) await editField(`thinkingLevelMap.${id.slice("level:".length)}`, chosen);
      else if (id.startsWith("compat:")) await editField(`compat.${id.slice("compat:".length)}`, chosen);
      else if (id.startsWith("array:")) {
        const [, path, item] = id.split(":");
        const current = (readPath(session.resolve(modelId), path.split(".")) as string[]) ?? [];
        const next = current.includes(item) ? current.filter((value) => value !== item) : [...current, item];
        await session.writeModelField(modelId, path, next);
      } else if (id === "$compatAdd" || id === "$compatRemove") {
        if (typeof chosen !== "string") return true;
        const values = compatFieldValues(api() as any, chosen);
        await session.writeModelField(
          modelId,
          `compat.${chosen}`,
          id === "$compatAdd" ? (values[0] ?? true) : undefined,
        );
      } else if (id === "$preset") await applyModelPreset(screen, session, modelId);
      else if (id === "$reset") await session.clearOverride(modelId);
      else if (id === "$remove") {
        await session.removeModel(modelId);
        return false;
      } else if (id.startsWith("read:")) return true;
      else return false;
      return true;
    },
    signal,
  );
  await session.commit();
}

/**
 * Presets are ranked by provider affinity; the best match is first. The list is fetched, so it
 * cannot be a row's static choices: this is one of the few rows that takes the editor area.
 */
export async function applyModelPreset(screen: Screen, session: ProviderSession, modelId: string): Promise<void> {
  const presets = await screen.client.allPages("catalog.presets", {
    api: session.values.api,
    modelId,
    providerId: session.values.id,
    providerName: session.values.name,
    baseUrl: session.values.baseUrl,
  });
  if (!presets) return;
  const presetId = await settingsPanel(
    screen.ctx,
    [],
    presets.map((preset: any, index: number) => ({
      id: preset.id,
      label: index === 0 ? `${preset.label} (best match)` : preset.label,
    })),
    async () => undefined,
    screen.signal,
  );
  if (presetId) await session.applyPreset(modelId, presetId);
}
