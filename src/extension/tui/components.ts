import {
  DynamicBorder,
  ExtensionEditorComponent,
  getSettingsListTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Box,
  Input,
  Spacer,
  Text,
  SettingsList,
  type SettingItem,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { booleanChoices, booleanLabel, formatValue } from "./format";
import type { Action, Field, PanelHeading } from "./types";
import { providerPanel } from "./provider-panel";

// No rendering or keyboard implementation: all components below are provided by Pi.
const cleared = Symbol("cleared");
export { cleared };

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
    currentValue: field.schema.type === "boolean" ? booleanLabel(field.value) : formatValue(field.value),
    ...(field.schema.type === "boolean"
      ? { values: field.allowDefault === false ? booleanChoices.slice(1) : booleanChoices }
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
                  done(formatValue(value === cleared ? undefined : value));
                } else done();
              },
              report,
              update,
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
  /** Applies a value to the parent row without closing this editor. */
  apply?: (value: any) => void,
): Component {
  const { schema, value, label } = field;
  // Submenus stay short enough that the parent's search row is never clipped.
  const submenuRows = Math.max(3, (tui.terminal?.rows ?? 24) - 12);
  const constants = schema.anyOf?.map((item: any) => item.const);
  if (constants?.every((item: any) => typeof item === "string")) {
    return new SettingsList(
      constants.map((item: string) => ({
        id: item,
        label: item,
        currentValue: item === value ? "Selected" : "",
        values: ["Select"],
      })),
      submenuRows,
      getSettingsListTheme(),
      (id) => done(id),
      () => done(),
      { enableSearch: true },
    );
  }
  if (schema.type === "array" && schema.items?.anyOf?.every((item: any) => typeof item.const === "string")) {
    const selected = new Set<string>(value || []);
    const list = new SettingsList(
      schema.items.anyOf.map((item: any) => ({
        id: item.const,
        label: item.const,
        currentValue: selected.has(item.const) ? "Yes" : "No",
        values: ["No", "Yes"],
      })),
      submenuRows,
      getSettingsListTheme(),
      (id, next) => {
        // Every toggle applies immediately and the list stays open, so several values can be set.
        if (next === "Yes") selected.add(id);
        else selected.delete(id);
        list.updateValue(id, selected.has(id) ? "Yes" : "No");
        apply?.([...selected]);
      },
      () => done(),
    );
    return list;
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
      submenuRows,
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
  if (!json) {
    // Scalar fields edit in a single prefilled line instead of the full editor.
    const input = new Input();
    input.setValue(value === undefined ? "" : String(value));
    input.onSubmit = (raw) => {
      if (!raw.trim()) return done(cleared);
      done(["number", "integer"].includes(schema.type) ? Number(raw) : raw);
    };
    input.onEscape = () => done();
    const panel = new Container();
    panel.addChild(new DynamicBorder());
    panel.addChild(new Text(`${label} (blank clears the field)`, 1, 0));
    panel.addChild(input);
    panel.addChild(new Text("Enter to submit  Esc to cancel", 1, 0));
    panel.addChild(new DynamicBorder());
    return Object.assign(panel, { handleInput: (data: string) => input.handleInput(data) });
  }
  return new ExtensionEditorComponent(
    tui,
    keys,
    `${label} (blank clears the field)`,
    value === undefined ? "" : JSON.stringify(value, null, 2),
    (raw) => {
      if (!raw.trim()) return done(cleared);
      try {
        done(JSON.parse(raw));
      } catch {
        report("Invalid JSON. The field was not changed.");
        done();
      }
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
  heading?: PanelHeading,
  /** Handle an action in place. Return true to close the screen, false to keep it open. */
  onAction?: (id: string) => Promise<boolean>,
): Promise<string | undefined> {
  let queue = Promise.resolve();
  let chosen: string | undefined;
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    let closed = false;
    const finish = (action?: string) => {
      if (closed) return;
      closed = true;
      chosen = action;
      signal?.removeEventListener("abort", abort);
      void queue.finally(() => done());
    };
    const abort = () => finish();
    const report = (message: string) => ctx.ui.notify(message, "error");
    const edit = (id: string, value: any) => {
      if (closed) return;
      queue = queue
        .then(async () => {
          const actual = await onEdit(id, value);
          const field = fields.find((item) => item.id === id);
          if (field) field.value = actual;
          list.updateValue(id, formatValue(actual));
          tui.requestRender();
        })
        .catch(() => report("Could not update the field."));
    };
    const run = (id: string) => {
      if (closed) return;
      queue = queue
        .then(async () => {
          if (!onAction || (await onAction(id))) finish(id);
          else tui.requestRender();
        })
        .catch(() => report("Could not complete the action."));
    };
    // Keep the search row and the panel heading visible even in short terminals.
    const maxVisible = Math.max(3, (tui.terminal?.rows ?? 24) - (heading ? 17 : 12));
    const list = new SettingsList(
      [
        ...actions.map((action) => ({
          id: action.id,
          label: action.label,
          currentValue: action.value || "",
          description: action.description,
          values: ["Open"],
        })),
        ...fields.map((field) => nativeField(field, tui, keys, (value) => edit(field.id, value), report)),
      ],
      maxVisible,
      getSettingsListTheme(),
      (id, value) => {
        if (actions.some((item) => item.id === id)) run(id);
        else if (fields.find((item) => item.id === id)?.schema.type === "boolean")
          edit(id, value === "Default" ? cleared : value === "Yes");
      },
      () => finish(),
      { enableSearch: true },
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) queueMicrotask(abort);
    if (!heading) return list;
    const panel = new Container();
    panel.addChild(new DynamicBorder());
    if (heading.context) {
      panel.addChild(new Text(theme.fg("accent", theme.bold(heading.context)), 1, 0));
      panel.addChild(new Spacer(1));
    }
    panel.addChild(new Text(theme.bold(heading.title), 1, 0));
    if (heading.description) panel.addChild(new Text(heading.description, 1, 0));
    panel.addChild(new Spacer(1));
    panel.addChild(list);
    panel.addChild(new DynamicBorder());
    const screen = new Box(1, 1);
    screen.addChild(panel);
    // Forward unchanged input to Pi; the stock container owns layout and mouse dispatch.
    return Object.assign(screen, { handleInput: list.handleInput.bind(list) });
  });
  await queue;
  return chosen;
}

/** Native Pi dialogs. Multi-field forms use `settingsPanel`; one-shot prompts use these. */
export const selectScreen = (
  ctx: ExtensionContext,
  title: string,
  options: string[],
  signal?: AbortSignal,
): Promise<string | undefined> => ctx.ui.select(title, options, { signal });

export const inputScreen = (
  ctx: ExtensionContext,
  title: string,
  placeholder?: string,
  signal?: AbortSignal,
): Promise<string | undefined> => ctx.ui.input(title, placeholder, { signal });

export const confirmScreen = (
  ctx: ExtensionContext,
  title: string,
  message: string,
  signal?: AbortSignal,
): Promise<boolean> => ctx.ui.confirm(title, message, { signal });
