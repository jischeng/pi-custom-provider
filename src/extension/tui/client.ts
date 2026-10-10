import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Result } from "../../operations/types";
import type { TuiOperations } from "./operations";

export type Client = {
  /** Runs an operation, reporting failures and warnings through Pi's notifications. */
  execute(name: string, args: unknown): Promise<Result>;
  /** Runs an operation and returns its data, or undefined when it did not succeed. */
  call(name: string, args: unknown): Promise<any>;
  /** Reads every page of a paged operation. */
  allPages(name: string, args?: Record<string, unknown>): Promise<any[] | undefined>;
  /** Reads the JSON schema an operation accepts. */
  schema(name: string): any;
};

/** What every screen needs: the operations client, Pi's UI context and the run signal. */
export type Screen = { client: Client; ctx: ExtensionContext; signal?: AbortSignal };

/** The only place the terminal screens touch the operations contract. */
export function createClient(operations: TuiOperations, ctx: ExtensionContext, signal?: AbortSignal): Client {
  const execute = async (name: string, args: unknown): Promise<Result> => {
    const result = await operations.invoke(name, args, signal);
    if (result.status === "failed")
      ctx.ui.notify(
        `${operations.describe(name).title}: ${result.error?.message || "Operation cancelled."}${result.error?.fields?.length ? ` Fields: ${[...new Set(result.error.fields.map((field) => field.path))].join(", ")}.` : ""}${result.effects.config === "committed" ? " Configuration saved." : ""}`,
        "error",
      );
    for (const warning of result.warnings) ctx.ui.notify(warning.message, "warning");
    return result;
  };
  return {
    execute,
    schema: (name) => operations.describe(name).inputSchema,
    call: async (name, args) => {
      const result = await execute(name, args);
      return result.status === "succeeded" ? result.data : undefined;
    },
    allPages: async (name, args = {}) => {
      const items: any[] = [];
      let cursor: string | undefined;
      do {
        const page = await execute(name, { ...args, limit: 200, ...(cursor ? { cursor } : {}) });
        if (page.status !== "succeeded") return undefined;
        items.push(...page.data.items);
        cursor = page.data.nextCursor;
      } while (cursor && !signal?.aborted);
      return items;
    },
  };
}
