import {
  ExtensionInputComponent,
  ExtensionSelectorComponent,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

/** Use Pi's own dialogs and overlay focus stack, including nested authentication prompts. */
export function dialogContext(ctx: ExtensionContext): ExtensionContext {
  const custom: ExtensionContext["ui"]["custom"] = (factory, options) =>
    ctx.ui.custom(factory, {
      overlay: true,
      overlayOptions: { width: "85%", margin: 1 },
      ...options,
    });
  const prompt = <T>(
    build: (tui: TUI, done: (value: T | undefined) => void) => Component & { dispose?(): void },
    signal?: AbortSignal,
  ) =>
    custom<T | undefined>((tui, _theme, _keys, done) => {
      let closed = false;
      const finish = (value?: T) => {
        if (closed) return;
        closed = true;
        signal?.removeEventListener("abort", abort);
        done(value);
      };
      const abort = () => finish();
      const component = build(tui, finish);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) queueMicrotask(abort);
      return component;
    });
  const select: ExtensionContext["ui"]["select"] = (title, options, opts) =>
    prompt<string>(
      (tui, done) =>
        new ExtensionSelectorComponent(title, options, done, () => done(undefined), {
          tui,
          timeout: opts?.timeout,
        }),
      opts?.signal,
    );
  return {
    ...ctx,
    ui: {
      ...ctx.ui,
      custom,
      select,
      input: (title, placeholder, opts) =>
        prompt<string>(
          (tui, done) =>
            new ExtensionInputComponent(title, placeholder, done, () => done(undefined), {
              tui,
              timeout: opts?.timeout,
            }),
          opts?.signal,
        ),
      confirm: async (title, message, opts) => (await select(`${title}\n${message}`, ["Yes", "No"], opts)) === "Yes",
    },
  };
}
