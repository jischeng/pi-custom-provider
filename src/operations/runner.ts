import { Value } from "typebox/value";
import type {
  Caller,
  Effects,
  Interaction,
  OperationContext,
  OperationDefinition,
  OperationDescriptor,
  Result,
} from "./types";
import { failure, OperationError } from "./errors";

/**
 * Runs a declared operation. This is the only execution path: the terminal UI, the
 * headless RPC command and the agent tools all call it with their own handlers.
 * There is no task store, operation id, idempotency cache or event stream — Pi's own
 * RPC already owns request/response, streaming and cancellation.
 */
export type OperationHandlers = {
  caller: Caller;
  signal: AbortSignal;
  /** Ask the user for input. Only valid for the user_client caller. */
  prompt(request: Interaction, signal?: AbortSignal): Promise<string>;
  /** Show a one-way notice (URL, device code, progress text). */
  notify(request: Interaction): void;
  progress?(stage: string): void;
};

export function descriptorOf(definition: OperationDefinition): OperationDescriptor {
  const { execute: _execute, ...descriptor } = definition;
  return descriptor;
}

export function operationsFor(definitions: OperationDefinition[], caller: Caller): OperationDescriptor[] {
  return definitions.filter((item) => item.allowedCallers.includes(caller)).map(descriptorOf);
}

export function findOperation(definitions: OperationDefinition[], name: string): OperationDefinition {
  const found = definitions.find((item) => item.name === name);
  if (!found) throw new OperationError("NOT_FOUND", `Unknown operation: ${name}`);
  return found;
}

function statusOf(code: string): Result["status"] {
  if (code === "CANCELLED") return "cancelled";
  if (code === "AUTH_REQUIRED" || code === "USER_ACTION_REQUIRED") return "requires_user_action";
  return "failed";
}

export async function runOperation(
  definitions: OperationDefinition[],
  name: string,
  args: unknown,
  handlers: OperationHandlers,
): Promise<Result> {
  const definition = findOperation(definitions, name);
  const effects: Effects = { config: "unchanged", credentials: "unchanged", runtime: "unchanged" };
  const warnings: Result["warnings"] = [];
  try {
    if (!definition.allowedCallers.includes(handlers.caller))
      throw new OperationError("USER_ACTION_REQUIRED", "This operation requires a user client.");
    if (!Value.Check(definition.inputSchema, args)) {
      const fields = Value.Errors(definition.inputSchema, args)
        .slice(0, 20)
        .map((error) => ({
          path: String(error.instancePath ?? ""),
          code: "INVALID_FIELD",
          message: "Invalid field type, value, or required constraint.",
        }));
      throw new OperationError("VALIDATION_ERROR", "Argument validation failed.", fields);
    }
    const context: OperationContext = {
      caller: handlers.caller,
      signal: handlers.signal,
      effects,
      warnings,
      progress: (stage) => handlers.progress?.(stage),
      notify: (request) => handlers.notify(request),
      prompt: (request, signal) =>
        handlers.caller === "user_client"
          ? handlers.prompt(request, signal)
          : Promise.reject(new OperationError("USER_ACTION_REQUIRED", "User authentication is required.")),
    };
    handlers.progress?.("executing");
    const data = await definition.execute(args, context);
    if (Object.values(effects).every((value) => value === "unchanged")) handlers.signal.throwIfAborted();
    if (!Value.Check(definition.resultSchema, data))
      throw new OperationError("INVALID_RESULT", "Operation result does not match its declared schema.");
    return { status: "succeeded", data, warnings, effects };
  } catch (error) {
    const detail = failure(error);
    return { status: statusOf(detail.code), error: detail, warnings, effects };
  }
}
