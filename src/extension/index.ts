import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ProviderService } from "../domain/service";
import { Authentication } from "./adapters/authentication";
import { createRuntimeAdapter } from "./adapters/runtime";
import { failure } from "../operations/errors";
import { runSetup } from "./tui";
import { createTuiOperations } from "./tui/operations";
import { registerResultRenderer, runHeadlessCommand } from "./headless";
import { registerManagementTools } from "./tools";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("provider-catalog-url", {
    description: "Model metadata catalog URL; use off to disable the remote catalog",
    type: "string",
  });
  const directory = getAgentDir();
  const auth = new Authentication(directory);
  const runtime = createRuntimeAdapter(pi, auth);
  const service = new ProviderService({
    directory,
    runtime,
    authentication: auth,
    discovery: {
      get catalogUrl() {
        // Pi parses extension flags after loading the extension factory.
        const value = pi.getFlag("provider-catalog-url");
        return value === "off" ? null : typeof value === "string" ? value : undefined;
      },
    },
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
  registerResultRenderer(pi);
  pi.on("session_start", async (_event, ctx) => {
    runtime.bind(ctx);
    if (initialError) ctx.ui.notify(initialError, "error");
  });
  pi.on("session_shutdown", async () => {
    controller?.abort();
    service.dispose();
  });
  pi.registerCommand("model-config", {
    description: "Manage providers, models, and authentication using native Pi controls",
    handler: async (args, ctx) => {
      runtime.bind(ctx);
      const [operation, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      // Arguments select a headless operation: the same command works in the terminal UI
      // and in Pi's RPC mode, where the result is a session entry.
      if (operation && operation !== "cancel" && operation !== "tui") {
        await runHeadlessCommand(pi, ctx, service.definitions(), operation, rest.join(" "));
        return;
      }
      if (args.trim() === "cancel") {
        controller?.abort();
        return;
      }
      if (ctx.mode !== "tui") {
        await runHeadlessCommand(pi, ctx, service.definitions(), undefined, "");
        return;
      }
      if (controller) {
        ctx.ui.notify("Provider management is already open.", "warning");
        return;
      }
      controller = new AbortController();
      try {
        await runSetup(createTuiOperations(service.definitions(), ctx), ctx, controller.signal);
      } finally {
        controller = undefined;
      }
    },
  });
  registerManagementTools(pi, service);
}
