import { ExtensionEditorComponent, getSettingsListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem, type Component, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

// No rendering or keyboard implementation: all components below are provided by Pi.
export type Field = {
  id: string;
  label: string;
  description?: string;
  schema: any;
  value: any;
  allowDefault?: boolean;
};
export type Action = { id: string; label: string; value?: string; description?: string };
const cleared = Symbol("cleared");
export { cleared };
export const displayValue = (value: any): string =>
  value === undefined
    ? "Default"
    : typeof value === "boolean"
      ? value
        ? "Yes"
        : "No"
      : Array.isArray(value)
        ? value.join(", ") || "None"
        : value && typeof value === "object"
          ? `${Object.keys(value).length} settings`
          : String(value);

function nativeField(
  field: Field,
  tui: TUI,
  keys: KeybindingsManager,
  update: (value: any) => void,
  report: (message: string) => void,
): SettingItem {
  return {
    id: field.id,
    label: field.label,
    description: field.description,
    currentValue: displayValue(field.value),
    ...(field.schema.type === "boolean"
      ? { values: field.allowDefault === false ? ["No", "Yes"] : ["Default", "Yes", "No"] }
      : {}),
    ...(field.schema.type !== "boolean"
      ? {
          submenu: (_value: string, done: (value?: string) => void) =>
            editComponent(
              field,
              tui,
              keys,
              (value) => {
                if (value !== undefined) {
                  update(value);
                  done(displayValue(value === cleared ? undefined : value));
                } else done();
              },
              report,
            ),
        }
      : {}),
  };
}

function editComponent(
  field: Field,
  tui: TUI,
  keys: KeybindingsManager,
  done: (value?: any) => void,
  report: (message: string) => void,
): Component {
  const { schema, value, label } = field;
  const constants = schema.anyOf?.map((item: any) => item.const);
  if (constants?.every((item: any) => typeof item === "string")) {
    return new SettingsList(
      constants.map((item: string) => ({
        id: item,
        label: item,
        currentValue: item === value ? "Selected" : "",
        values: ["Select"],
      })),
      14,
      getSettingsListTheme(),
      (id) => done(id),
      () => done(),
      { enableSearch: true },
    );
  }
  if (schema.type === "array" && schema.items?.anyOf?.every((item: any) => typeof item.const === "string")) {
    const selected = new Set<string>(value || []);
    return new SettingsList(
      [
        { id: "$done", label: "Done", currentValue: "Apply selection", values: ["Apply"] },
        ...schema.items.anyOf.map((item: any) => ({
          id: item.const,
          label: item.const,
          currentValue: selected.has(item.const) ? "Yes" : "No",
          values: ["No", "Yes"],
        })),
      ],
      14,
      getSettingsListTheme(),
      (id, next) => {
        if (id === "$done") done([...selected]);
        else next === "Yes" ? selected.add(id) : selected.delete(id);
      },
      () => done(),
    );
  }
  if (schema.type === "object" && schema.properties) {
    const values = structuredClone(value || {});
    const fields = Object.entries(schema.properties).map(([id, schema]: [string, any]) => ({
      id,
      label: schema.title || id,
      schema,
      value: values[id],
    }));
    const set = (id: string, next: any) => {
      if (next === cleared) delete values[id];
      else values[id] = next;
      const field = fields.find((item) => item.id === id);
      if (field) field.value = next === cleared ? undefined : next;
    };
    const items: SettingItem[] = [
      { id: "$done", label: `Apply ${label}`, currentValue: "", values: ["Apply"] },
      { id: "$clear", label: "Use defaults", currentValue: "Clear this field", values: ["Clear"] },
      ...fields.map((item) => nativeField(item, tui, keys, (next) => set(item.id, next), report)),
      {
        id: "$json",
        label: "Advanced JSON",
        currentValue: "All settings",
        submenu: (_current, close) =>
          new ExtensionEditorComponent(
            tui,
            keys,
            label,
            JSON.stringify(values, null, 2),
            (raw) => {
              try {
                done(JSON.parse(raw));
              } catch {
                report("Invalid JSON. The field was not changed.");
                close();
              }
            },
            () => close(),
          ),
      },
    ];
    return new SettingsList(
      items,
      14,
      getSettingsListTheme(),
      (id, next) => {
        if (id === "$done") done(values);
        else if (id === "$clear") done(cleared);
        else if (fields.find((item) => item.id === id)?.schema.type === "boolean")
          set(id, next === "Default" ? cleared : next === "Yes");
      },
      () => done(),
      { enableSearch: true },
    );
  }
  const json = schema.type === "object" || schema.type === "array";
  return new ExtensionEditorComponent(
    tui,
    keys,
    `${label} (blank clears the field)`,
    value === undefined ? "" : json ? JSON.stringify(value, null, 2) : String(value),
    (raw) => {
      if (!raw.trim()) return done(cleared);
      if (json) {
        try {
          done(JSON.parse(raw));
        } catch {
          report("Invalid JSON. The field was not changed.");
          done();
        }
      } else done(["number", "integer"].includes(schema.type) ? Number(raw) : raw);
    },
    () => done(),
  );
}

/** A persistent native settings screen. Field writes are serialized before navigation completes. */
export async function settingsPanel(
  ctx: ExtensionContext,
  fields: Field[],
  actions: Action[],
  onEdit: (id: string, value: any) => Promise<any>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let queue = Promise.resolve();
  let chosen: string | undefined;
  await ctx.ui.custom<void>((tui, _theme, keys, done) => {
    let closed = false;
    const finish = (action?: string) => {
      if (closed) return;
      closed = true;
      chosen = action;
      signal?.removeEventListener("abort", abort);
      void queue.finally(() => done());
    };
    const abort = () => finish();
    const edit = (id: string, value: any) => {
      if (closed) return;
      queue = queue
        .then(async () => {
          const actual = await onEdit(id, value);
          const field = fields.find((item) => item.id === id);
          if (field) field.value = actual;
          list.updateValue(id, displayValue(actual));
          tui.requestRender();
        })
        .catch(() => ctx.ui.notify("Could not update the field.", "error"));
    };
    const list = new SettingsList(
      [
        ...fields.map((field) =>
          nativeField(
            field,
            tui,
            keys,
            (value) => edit(field.id, value),
            (message) => ctx.ui.notify(message, "error"),
          ),
        ),
        ...actions.map((action) => ({
          id: action.id,
          label: action.label,
          currentValue: action.value || "",
          description: action.description,
          values: ["Open"],
        })),
      ],
      16,
      getSettingsListTheme(),
      (id, value) => {
        if (actions.some((item) => item.id === id)) finish(id);
        else if (fields.find((item) => item.id === id)?.schema.type === "boolean")
          edit(id, value === "Default" ? cleared : value === "Yes");
      },
      () => finish(),
      { enableSearch: true },
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) queueMicrotask(abort);
    return list;
  });
  await queue;
  return chosen;
}

export async function selectModels(ctx: ExtensionContext, candidates: any[], ids: string[], signal?: AbortSignal) {
  const selected = new Set(ids);
  const fields = candidates.map((item) => ({
    id: `model:${item.model.id}`,
    label: item.model.name || item.model.id,
    description: `${item.model.id} · ${item.source} · ${item.availability}`,
    schema: { type: "boolean" },
    allowDefault: false,
    value: selected.has(item.model.id),
  }));
  const action = await settingsPanel(
    ctx,
    fields,
    [{ id: "$apply", label: "Apply selection", description: "Apply the selected models to this draft." }],
    async (id, value) => {
      const modelId = id.slice("model:".length);
      if (value === true) selected.add(modelId);
      else selected.delete(modelId);
      return selected.has(modelId);
    },
    signal,
  );
  return action === "$apply" ? [...selected] : undefined;
}
