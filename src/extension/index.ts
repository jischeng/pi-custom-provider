import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ProviderService } from "./domain/service";
import { Authentication } from "./oauth";
import { createRuntimeAdapter } from "./provider-registry";
import { registrationChannel } from "./operations/types";
import { failure } from "./operations/errors";
import { runSetup } from "./ui";
import { createUiOperations } from "./ui/operations";
import { dialogContext } from "./ui/dialogs";
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
    description: "Manage providers, models, and authentication using native Pi controls",
    handler: async (args, ctx) => {
      runtime.bind(ctx);
      if (args.trim() === "cancel") {
        controller?.abort();
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "Use the extension operations RPC for programmatic access. This command is for the terminal UI.",
          "error",
        );
        return;
      }
      if (controller) {
        ctx.ui.notify("Provider management is already open.", "warning");
        return;
      }
      controller = new AbortController();
      try {
        const dialogs = dialogContext(ctx);
        await runSetup(createUiOperations(service.definitions(), dialogs), dialogs, controller.signal);
      } finally {
        controller = undefined;
      }
    },
  });
  registerManagementTools(pi, service);
}
