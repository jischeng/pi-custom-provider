import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProviderService } from "../domain/service";
import { runOperation } from "../operations/runner";
const toolOperations = [
  "provider.list",
  "provider.get",
  "catalog.list",
  "catalog.presets",
  "provider.create",
  "provider.update",
  "provider.delete",
  "provider.selectModels",
  "model.discover",
  "model.recommend",
  "auth.status",
];
export function registerManagementTools(pi: ExtensionAPI, service: ProviderService) {
  const names = new Set<string>();
  for (const operation of service.definitions().filter((d) => toolOperations.includes(d.name))) {
    const name = operation.name.startsWith("provider.")
      ? operation.name.replaceAll(".", "_")
      : `provider_${operation.name.replaceAll(".", "_")}`;
    names.add(name);
    const writes = operation.effects.includes("config_write");
    pi.registerTool({
      name,
      label: operation.title,
      description: `${operation.title}. Does not accept or return credentials. Writes require user confirmation.`,
      parameters: operation.inputSchema,
      executionMode: writes ? "sequential" : "parallel",
      execute: async (_id, args, signal, onUpdate, ctx) => {
        if (writes) {
          if (!ctx.hasUI)
            return {
              content: [{ type: "text", text: "User confirmation is required. Use /model-config." }],
              details: unexecuted("requires_user_action"),
            };
          const confirmed = await ctx.ui.confirm(operation.title, JSON.stringify(args, null, 2), { signal });
          if (!confirmed)
            return {
              content: [{ type: "text", text: "The user did not confirm. The configuration was not changed." }],
              details: unexecuted("cancelled"),
            };
        }
        const result = await runOperation(service.definitions(), operation.name, args, {
          caller: "model_tool",
          signal: signal ?? new AbortController().signal,
          prompt: async () => "",
          notify: (request) => onUpdate?.({ content: [{ type: "text", text: request.message }], details: {} }),
          progress: (stage) => onUpdate?.({ content: [{ type: "text", text: operation.title }], details: { stage } }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
  }
  pi.on("tool_result", (event) => {
    if (!names.has(event.toolName)) return;
    const status = (event.details as any)?.status;
    if (status === "failed") return { isError: true };
  });
}

function unexecuted(status: "cancelled" | "requires_user_action") {
  return {
    status,
    error: {
      code: status === "cancelled" ? "CANCELLED" : "USER_ACTION_REQUIRED",
      message: status === "cancelled" ? "The user did not confirm." : "User confirmation is required.",
      retryable: false,
    },
    warnings: [],
    effects: { config: "unchanged", credentials: "unchanged", runtime: "unchanged" },
  };
}
