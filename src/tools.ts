import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProviderService } from "./domain/service";
import { OperationRegistry } from "./operations/registry";
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
      description: `${operation.title}。不接收或返回凭据；写入需要用户确认。`,
      parameters: operation.inputSchema,
      executionMode: writes ? "sequential" : "parallel",
      execute: async (_id, args, signal, onUpdate, ctx) => {
        if (writes) {
          if (!ctx.hasUI)
            return {
              content: [{ type: "text", text: "需要用户确认，请使用 /provider-setup。" }],
              details: unexecuted("requires_user_action"),
            };
          const confirmed = await ctx.ui.confirm(operation.title, JSON.stringify(args, null, 2), { signal });
          if (!confirmed)
            return { content: [{ type: "text", text: "用户未确认，未修改配置。" }], details: unexecuted("cancelled") };
        }
        const registry = new OperationRegistry((event) => {
          if (event.type === "extension_operation_update")
            onUpdate?.({ content: [{ type: "text", text: operation.title }], details: { stage: event.stage } });
        });
        registry.register("provider-manager", service.definitions());
        try {
          const result = await registry.invoke(
            `provider-manager/${operation.name}`,
            args,
            "model_tool",
            undefined,
            signal,
          ).done;
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        } finally {
          await registry.dispose();
        }
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
    operationId: randomUUID(),
    status,
    error: {
      code: status === "cancelled" ? "CANCELLED" : "USER_ACTION_REQUIRED",
      message: status === "cancelled" ? "用户未确认。" : "需要用户确认。",
      retryable: false,
    },
    warnings: [],
    effects: { config: "unchanged", credentials: "unchanged", runtime: "unchanged" },
  };
}
