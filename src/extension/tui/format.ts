/** One value formatter for the whole terminal UI, so unset never renders two different ways. */
export const unset = "—";

/** Boolean fields cycle through these labels; the first one means "not set". */
export const booleanChoices = ["Default", "Yes", "No"];

export const booleanLabel = (value: unknown): string =>
  value === undefined ? booleanChoices[0] : value ? booleanChoices[1] : booleanChoices[2];

/** Pads a row name to the value column; names that would reach it are shortened instead. */
export const column = (name: string, width = 24): string =>
  name.length >= width ? `${name.slice(0, width - 2)}… ` : name.padEnd(width);

export function formatValue(value: unknown): string {
  if (value === undefined || value === null) return unset;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.join(", ") : unset;
  if (typeof value === "object") return `${Object.keys(value as object).length} settings`;
  return String(value).slice(0, 60);
}
