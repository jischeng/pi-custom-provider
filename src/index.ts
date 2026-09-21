import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ProviderService } from "./domain/service";
import { Authentication } from "./oauth";
import { createRuntimeAdapter } from "./provider-registry";
import { registrationChannel } from "./operations/types";
import { failure } from "./operations/errors";
import { runSetup } from "./ui";
import { registerManagementTools } from "./tools";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("provider-catalog-url", { description: "模型元数据目录 URL，off 禁用远端目录", type: "string" });
  const catalogUrl = pi.getFlag("provider-catalog-url");
  const directory = getAgentDir();
  const auth = new Authentication(directory);
  const runtime = createRuntimeAdapter(pi, auth);
  const service = new ProviderService({
    directory,
    runtime,
    authentication: auth,
    discovery: { catalogUrl: catalogUrl === "off" ? null : typeof catalogUrl === "string" ? catalogUrl : undefined },
  });
  let controller: AbortController | undefined;
  let initialError: string | undefined;
  try {
    const state = service.store.read();
    for (const [id, p] of Object.entries(state.config.providers)) service.view(id, p, state.revision);
    runtime.initialize(state.config);
  } catch (error) {
    initialError = failure(error).message;
  }
  // Public event bus registration, consumed only by a host implementing the generic operations bridge.
  pi.events.emit(registrationChannel, { namespace: "provider-manager", operations: service.definitions() });
  pi.on("session_start", async (_event, ctx) => {
    runtime.bind(ctx);
    if (initialError) ctx.ui.notify(initialError, "error");
  });
  pi.on("session_shutdown", async () => {
    controller?.abort();
    service.dispose();
  });
  pi.registerCommand("provider-setup", {
    description: "管理供应商、模型及认证（Pi 原生界面）",
    handler: async (args, ctx) => {
      runtime.bind(ctx);
      if (args.trim() === "cancel") {
        controller?.abort();
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("程序接口请使用通用扩展操作 RPC，不通过此终端命令执行。", "error");
        return;
      }
      if (controller) {
        ctx.ui.notify("供应商管理已打开。", "warning");
        return;
      }
      controller = new AbortController();
      try {
        await runSetup(service, ctx, controller.signal);
      } finally {
        controller = undefined;
      }
    },
  });
  registerManagementTools(pi, service);
}
