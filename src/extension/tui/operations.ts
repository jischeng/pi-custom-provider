import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { OperationRegistry } from "../operations/registry";
import type { Result } from "../operations/types";
import type { OperationDefinition, OperationDescriptor } from "../operations/types";

/** UI orchestration only. Every control is implemented by Pi; there is no terminal rendering or input handling here. */
async function runUiOperation(
  definitions: OperationDefinition[],
  ctx: ExtensionContext,
  name: string,
  args: unknown,
  outerSignal?: AbortSignal,
): Promise<Result> {
  let finished = false;
  let active: AbortController | undefined;
  let activeInteraction: string | undefined;
  const prompts: any[] = [];
  const ended = new Set<string>();
  const registry = new OperationRegistry((event) => {
    if (event.type === "extension_interaction_request") {
      if (event.requiresResponse) {
        prompts.push(event);
        active?.abort();
      } else if (event.url) ctx.ui.notify(`${event.message}\n${event.url}`);
      else if (event.verificationUri) ctx.ui.notify(`${event.message}\n${event.verificationUri}\n${event.userCode}`);
    } else if (event.type === "extension_interaction_end") {
      ended.add(event.interactionId);
      if (activeInteraction === event.interactionId) active?.abort();
    } else if (event.type === "extension_operation_result") {
      finished = true;
      active?.abort();
    }
  });
  registry.register("provider-manager", definitions);
  const definition = registry.definition(`provider-manager/${name}`);
  const task = registry.invoke(definition.name, args, "user_client", undefined, outerSignal);
  ctx.ui.setStatus("provider-setup", definition.title);
  try {
    if (definition.effects.includes("network")) {
      while (!finished) {
        const prompt = prompts.shift();
        if (prompt && ended.has(prompt.interactionId)) continue;
        active = new AbortController();
        activeInteraction = prompt?.interactionId;
        if (prompt) {
          let value: string | undefined;
          if (prompt.options) {
            const labels = prompt.options.map((o: any) => `${o.label} (${o.id})`);
            const selected = await ctx.ui.select(prompt.message, labels, { signal: active.signal });
            value = selected === undefined ? undefined : prompt.options[labels.indexOf(selected)]?.id;
          } else
            value = await ctx.ui.input(
              prompt.message + (prompt.secret ? " (input is visible; stored credentials are not shown)" : ""),
              prompt.placeholder,
              { signal: active.signal },
            );
          if (!active.signal.aborted && !ended.has(prompt.interactionId))
            registry.respond(
              task.snapshot.operationId,
              prompt.interactionId,
              prompt.revision,
              value,
              value === undefined,
            );
        } else {
          const waitSignal = active.signal;
          await ctx.ui.custom<void>((tui, theme, _keys, done) => {
            const loader = new BorderedLoader(tui, theme, definition.title);
            let closed = false;
            const finish = () => {
              if (closed) return;
              closed = true;
              waitSignal.removeEventListener("abort", finish);
              loader.dispose();
              done();
            };
            loader.onAbort = finish;
            waitSignal.addEventListener("abort", finish, { once: true });
            if (waitSignal.aborted) queueMicrotask(finish);
            return loader;
          });
          if (!active.signal.aborted) registry.cancel(task.snapshot.operationId);
        }
      }
    }
    return await task.done;
  } finally {
    active?.abort();
    ctx.ui.setStatus("provider-setup", undefined);
    await registry.dispose();
  }
}

export interface ProviderOperations {
  describe(name: string): OperationDescriptor;
  invoke(name: string, args: unknown, signal?: AbortSignal): Promise<Result>;
}

/** Local transport adapter. Screens only depend on this interface and JSON schemas. */
export function createUiOperations(definitions: OperationDefinition[], ctx: ExtensionContext): ProviderOperations {
  return {
    describe(name) {
      const definition = definitions.find((item) => item.name === name);
      if (!definition) throw new Error(`Unknown operation: ${name}`);
      const { execute: _execute, ...descriptor } = definition;
      return descriptor;
    },
    invoke: (name, args, signal) => runUiOperation(definitions, ctx, name, args, signal),
  };
}
