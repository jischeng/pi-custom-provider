import { BorderedLoader, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findOperation, descriptorOf, runOperation } from "../../operations/runner";
import type { Interaction, Result } from "../../operations/types";
import type { OperationDefinition, OperationDescriptor } from "../../operations/types";
import { inputScreen, selectScreen } from "./components";

export interface TuiOperations {
  describe(name: string): OperationDescriptor;
  invoke(name: string, args: unknown, signal?: AbortSignal): Promise<Result>;
}

/**
 * Terminal UI adapter. Prompts use Pi's native dialogs; long network operations show Pi's
 * cancellable loader. Writes stay silent so an in-place edit never swaps the screen.
 */
export function createTuiOperations(definitions: OperationDefinition[], ctx: ExtensionContext): TuiOperations {
  return {
    describe: (name) => descriptorOf(findOperation(definitions, name)),
    async invoke(name, args, signal) {
      const definition = findOperation(definitions, name);
      const controller = new AbortController();
      const forward = () => controller.abort(signal?.reason);
      if (signal?.aborted) forward();
      else signal?.addEventListener("abort", forward, { once: true });
      let closeLoader: (() => void) | undefined;
      const hideLoader = () => {
        const close = closeLoader;
        closeLoader = undefined;
        close?.();
      };
      const showLoader = () => {
        if (!definition.effects.includes("network") || closeLoader) return;
        void ctx.ui.custom<void>((tui, theme, _keys, done) => {
          const loader = new BorderedLoader(tui, theme, definition.title);
          let closed = false;
          const finish = () => {
            if (closed) return;
            closed = true;
            if (closeLoader === finish) closeLoader = undefined;
            loader.dispose();
            done();
          };
          closeLoader = finish;
          loader.onAbort = () => {
            controller.abort();
            finish();
          };
          if (controller.signal.aborted) queueMicrotask(finish);
          return loader;
        });
      };
      const notify = (request: Interaction) => {
        if (request.url) ctx.ui.notify(`${request.message}\n${request.url}`);
        else if (request.verificationUri)
          ctx.ui.notify(`${request.message}\n${request.verificationUri}\n${request.userCode}`);
        else ctx.ui.notify(request.message);
      };
      ctx.ui.setStatus("model-config", definition.title);
      showLoader();
      try {
        return await runOperation(definitions, name, args, {
          caller: "user_client",
          signal: controller.signal,
          notify,
          progress: (stage) => ctx.ui.setStatus("model-config", `${definition.title}: ${stage}`),
          prompt: async (request, promptSignal) => {
            // The loader owns the screen; step aside for the dialog, then resume.
            hideLoader();
            try {
              const combined = promptSignal ? AbortSignal.any([promptSignal, controller.signal]) : controller.signal;
              if (request.options) {
                const labels = request.options.map((option) => `${option.label} (${option.id})`);
                const selected = await selectScreen(ctx, request.message, labels, combined);
                const option = request.options[labels.indexOf(selected ?? "")];
                if (!option) throw new DOMException("Cancelled", "AbortError");
                return option.id;
              }
              const entered = await inputScreen(
                ctx,
                request.message + (request.secret ? " (input is visible; stored credentials are not shown)" : ""),
                request.placeholder,
                combined,
              );
              if (entered === undefined) throw new DOMException("Cancelled", "AbortError");
              return entered;
            } finally {
              if (!controller.signal.aborted) showLoader();
            }
          },
        });
      } finally {
        hideLoader();
        signal?.removeEventListener("abort", forward);
        ctx.ui.setStatus("model-config", undefined);
      }
    },
  };
}
