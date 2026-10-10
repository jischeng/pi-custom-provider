import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleared, inputScreen, settingsPanel } from "./components";
import { formatValue } from "./format";
import type { ActionChoice } from "./types";

/** A choice Pi is known to use for an open-ended field, e.g. a thinking level or a compat value. */
export type Choice = { label: string; value: any };

export type SelectPlan = {
  kind: "select";
  title: string;
  choices: Choice[];
  /** The value in effect, marked in the list. */
  current: any;
};
/** A plan the panel renders itself, in place, without taking the editor area. */
export type InlinePlan = { kind: "in-place"; value: any } | SelectPlan;
/** A plan that needs the editor area: a Pi prompt or the JSON settings panel. */
export type ScreenPlan =
  | { kind: "prompt"; title: string; numeric: boolean }
  | { kind: "json"; title: string; schema: any; value: any };
export type FieldPlan = InlinePlan | ScreenPlan;

export type FieldInput = {
  title: string;
  schema: any;
  /** Current effective value. */
  value: any;
  /** Values Pi is known to use. Their set is a hint, not a contract. */
  choices?: Choice[];
};

const enumChoices = (schema: any): Choice[] =>
  [
    ...(schema?.anyOf?.map((item: any) => ({ value: item.const, label: item.title })) ?? []),
    ...(typeof schema?.const === "string" ? [{ value: schema.const, label: schema.title }] : []),
  ]
    .filter((entry: any) => typeof entry.value === "string")
    .map((entry: any) => ({ value: entry.value, label: entry.label ?? entry.value }));

/** How a value should be shown, using the schema's enum title when it has one. */
export const valueLabel = (schema: any, value: any): string =>
  enumChoices(schema).find((choice) => choice.value === value)?.label ?? formatValue(value);

/**
 * One rule for every editable field, shared by the provider page and the model form:
 * a boolean toggles in place; a known set of values is a select list the panel renders in place;
 * a structured value opens the JSON panel; anything else is prompted.
 */
export function planField(input: FieldInput): FieldPlan {
  const { title, schema, value } = input;
  if (schema?.type === "boolean") return { kind: "in-place", value: !value };
  // Values Pi is known to use win over the schema enum: their set is a hint, not a contract.
  const choices = input.choices?.length ? input.choices : enumChoices(schema);
  if (choices.length) return { kind: "select", title, choices, current: value };
  if (schema?.type === "object" || schema?.type === "array") return { kind: "json", title, schema, value };
  return { kind: "prompt", title, numeric: ["number", "integer"].includes(schema?.type) };
}

/** Whether this plan needs the shared editor area instead of being applied in the list. */
export const needsScreen = (plan: FieldPlan): boolean => plan.kind === "prompt" || plan.kind === "json";

/** The row that opens this plan's select list, marking the value in effect. */
export const selectRow = (plan: FieldPlan): { choices?: ActionChoice[] } =>
  plan.kind !== "select"
    ? {}
    : {
        choices: plan.choices.map((choice, index) => ({
          id: String(index),
          label: choice.value === plan.current ? `${choice.label}  (current)` : choice.label,
          value: choice.value,
        })),
      };

/**
 * Carries out a plan. `chosen` is the value the panel reports for a select row; a value of
 * `undefined` there means the user dismissed the list, so nothing is written.
 */
export async function applyFieldPlan(
  ctx: ExtensionContext,
  plan: FieldPlan,
  chosen?: any,
  signal?: AbortSignal,
): Promise<{ changed: boolean; value?: any }> {
  if (plan.kind === "in-place") return { changed: true, value: plan.value };
  if (plan.kind === "select") return chosen === undefined ? { changed: false } : { changed: true, value: chosen };
  if (plan.kind === "prompt") {
    const entered = await inputScreen(ctx, plan.title, undefined, signal);
    if (entered === undefined) return { changed: false };
    if (entered === "") return { changed: true, value: undefined };
    return { changed: true, value: plan.numeric ? Number(entered) : entered };
  }
  let edited = plan.value;
  const choice = await settingsPanel(
    ctx,
    [{ id: "value", label: plan.title, schema: plan.schema, value: plan.value }],
    [
      { id: "$save", label: "Save" },
      { id: "$cancel", label: "Cancel" },
    ],
    async (_id, value) => {
      edited = value === cleared ? undefined : value;
      return edited;
    },
    signal,
    { title: plan.title },
  );
  return choice === "$save" ? { changed: true, value: edited } : { changed: false };
}
