import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { operationsFor, runOperation } from "../operations/runner";
import type { Interaction, OperationDefinition, Result } from "../operations/types";

/** Session entry that carries a headless result. Read it with Pi's `get_entries` RPC command. */
export const resultEntryType = "provider-manager/result";

const summary = (operation: string, result: Result): string =>
  result.status === "succeeded"
    ? `${operation}: succeeded`
    : `${operation}: ${result.status}${result.error ? ` — ${result.error.message}` : ""}`;

/**
 * Headless mode for Pi's RPC: `prompt` with `/model-config <operation> <json>` runs one
 * declared operation. Prompts travel through Pi's extension UI sub-protocol; the result is
 * appended as a session entry, so a client reads it with `get_entries` and nothing here
 * implements its own transport.
 */
export async function runHeadlessCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  definitions: OperationDefinition[],
  operation: string | undefined,
  rawArguments: string,
) {
  const operations = operationsFor(definitions, "user_client");
  const names = operations.map((item) => item.name);
  if (!operation || operation === "help" || operation === "list-operations") {
    pi.appendEntry(resultEntryType, { kind: "catalog", operations });
    ctx.ui.notify(`Operations: ${names.join(", ")}. Invoke with <operation> <json>; read entry "${resultEntryType}".`);
    return;
  }
  if (!names.includes(operation)) {
    ctx.ui.notify(`Unknown operation "${operation}". Known: ${names.join(", ")}.`, "error");
    return;
  }
  let args: unknown = {};
  if (rawArguments.trim()) {
    try {
      args = JSON.parse(rawArguments);
    } catch {
      ctx.ui.notify("Arguments must be a JSON object.", "error");
      return;
    }
  }
  const notice = (request: Interaction) => {
    if (request.url) ctx.ui.notify(`${request.message}\n${request.url}`);
    else if (request.verificationUri)
      ctx.ui.notify(`${request.message}\n${request.verificationUri}\n${request.userCode}`);
    else ctx.ui.notify(request.message);
  };
  const result = await runOperation(definitions, operation, args, {
    caller: "user_client",
    // Pi owns cancellation; a headless command always runs to completion or fails.
    signal: new AbortController().signal,
    notify: notice,
    progress: (stage) => ctx.ui.setStatus("model-config", `${operation}: ${stage}`),
    prompt: async (request) => {
      if (request.options) {
        const labels = request.options.map((option) => `${option.label} (${option.id})`);
        const selected = await ctx.ui.select(request.message, labels);
        // Accept the shown label, the bare id, or the label text: clients differ.
        const option =
          request.options.find((item, index) => labels[index] === selected) ??
          request.options.find((item) => item.id === selected) ??
          request.options.find((item) => item.label === selected);
        if (!option) throw new DOMException("Cancelled", "AbortError");
        return option.id;
      }
      const entered = await ctx.ui.input(
        request.message + (request.secret ? " (input is visible; stored credentials are not shown)" : ""),
        request.placeholder,
      );
      if (entered === undefined) throw new DOMException("Cancelled", "AbortError");
      return entered;
    },
  });
  ctx.ui.setStatus("model-config", undefined);
  pi.appendEntry(resultEntryType, { kind: "result", operation, result });
  ctx.ui.notify(summary(operation, result), result.status === "failed" ? "error" : "info");
}

/** Renders headless results in the interactive transcript (they are session entries, not messages). */
export function registerResultRenderer(pi: ExtensionAPI) {
  pi.registerEntryRenderer(resultEntryType, (entry, _options, theme) => {
    const data = entry.data as { kind?: string; operation?: string; result?: Result } | undefined;
    if (data?.kind === "catalog")
      return new Text(theme.fg("muted", "provider-manager: operation catalog written to the session."), 1, 0);
    if (!data?.result) return undefined;
    return new Text(
      (data.result.status === "succeeded"
        ? theme.fg("accent", summary(data.operation!, data.result))
        : theme.fg("error", summary(data.operation!, data.result))) +
        "\n" +
        theme.fg("muted", JSON.stringify(data.result.data ?? data.result.error, null, 2)),
      1,
      0,
    );
  });
}
