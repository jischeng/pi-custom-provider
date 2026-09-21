import { randomUUID, createHash } from "node:crypto";
import { Value } from "typebox/value";
import type { Caller, Interaction, OperationContext, OperationDefinition, Result } from "./types";
import { failure, OperationError } from "./errors";

const lifetime = 30 * 60_000;
const maxTasks = 1000;
export type Snapshot = { operationId: string; state: string; sequence: number; result?: Result };
type Task = {
  snapshot: Snapshot;
  cancellable: boolean;
  controller: AbortController;
  done: Promise<Result>;
  completed?: number;
  pending: Map<
    string,
    { revision: number; resolve(value: string): void; reject(error: Error): void; request: Interaction }
  >;
};
export class OperationRegistry {
  private definitions = new Map<string, OperationDefinition>();
  private tasks = new Map<string, Task>();
  private requests = new Map<string, { fingerprint: string; operationId: string }>();
  constructor(
    private emit: (event: any) => void = () => {},
    private now: () => number = Date.now,
  ) {}
  register(namespace: string, definitions: OperationDefinition[]) {
    if (!/^[a-z][a-z0-9-]*$/.test(namespace))
      throw new OperationError("INVALID_NAMESPACE", "Invalid operation namespace.");
    for (const def of definitions) {
      const name = `${namespace}/${def.name}`;
      if (this.definitions.has(name))
        throw new OperationError("DUPLICATE_OPERATION", "Operation is already registered.");
      this.definitions.set(name, { ...def, name });
    }
  }
  describe(caller: Caller = "user_client") {
    return [...this.definitions.values()]
      .filter((d) => d.allowedCallers.includes(caller))
      .map(({ execute, ...d }) => structuredClone(d));
  }
  definition(name: string) {
    const d = this.definitions.get(name);
    if (!d) throw new OperationError("NOT_FOUND", "Operation not found.");
    return d;
  }
  invoke(name: string, args: unknown, caller: Caller = "user_client", requestId?: string, parentSignal?: AbortSignal) {
    this.prune();
    const def = this.definition(name);
    if (!def.allowedCallers.includes(caller))
      throw new OperationError("USER_ACTION_REQUIRED", "This operation requires a user client.");
    const fingerprint = createHash("sha256").update(JSON.stringify({ name, args, caller })).digest("hex");
    const requestKey = requestId && `${caller}:${requestId}`;
    if (requestKey && this.requests.has(requestKey)) {
      const previous = this.requests.get(requestKey)!;
      if (previous.fingerprint !== fingerprint)
        throw new OperationError("CONFLICT", "requestId is already used by a different request.");
      return this.tasks.get(previous.operationId)!;
    }
    if (this.tasks.size >= maxTasks) throw new OperationError("BUSY", "Operation limit reached.", undefined, true);
    const id = randomUUID();
    const controller = new AbortController();
    const onAbort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) onAbort();
    else parentSignal?.addEventListener("abort", onAbort, { once: true });
    const task: Task = {
      cancellable: def.cancellable,
      snapshot: { operationId: id, state: "queued", sequence: 0 },
      controller,
      pending: new Map(),
      done: undefined!,
    };
    this.tasks.set(id, task);
    if (requestKey) this.requests.set(requestKey, { fingerprint, operationId: id });
    const send = (type: string, body: any) =>
      this.emit({ type, operationId: id, sequence: ++task.snapshot.sequence, ...body });
    const context: OperationContext = {
      operationId: id,
      caller,
      signal: controller.signal,
      effects: { config: "unchanged", credentials: "unchanged", runtime: "unchanged" },
      warnings: [],
      progress: (stage) => {
        task.snapshot.state = "running";
        send("extension_operation_update", { state: "running", stage });
      },
      notify: (request) =>
        send("extension_interaction_request", {
          interactionId: randomUUID(),
          revision: 1,
          requiresResponse: false,
          ...request,
        }),
      prompt: (request, signal) =>
        new Promise<string>((resolve, reject) => {
          if (caller !== "user_client")
            return reject(new OperationError("USER_ACTION_REQUIRED", "User authentication is required."));
          const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
          if (combined.aborted) return reject(new DOMException("Cancelled", "AbortError"));
          const interactionId = randomUUID();
          const close = (reason: string) => {
            task.pending.delete(interactionId);
            combined.removeEventListener("abort", abort);
            send("extension_interaction_end", { interactionId, reason });
          };
          const abort = () => {
            close("cancelled");
            reject(new DOMException("Cancelled", "AbortError"));
          };
          combined.addEventListener("abort", abort, { once: true });
          task.pending.set(interactionId, {
            revision: 1,
            request,
            resolve: (value) => {
              close("completed");
              task.snapshot.state = "running";
              resolve(value);
            },
            reject: (error) => {
              close("cancelled");
              reject(error);
            },
          });
          task.snapshot.state = "requires_user_action";
          send("extension_interaction_request", { interactionId, revision: 1, requiresResponse: true, ...request });
        }),
    };
    // Start after the caller has received an operation ID. Do not store raw arguments in task snapshots.
    task.done = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      let result: Result;
      try {
        controller.signal.throwIfAborted();
        if (!Value.Check(def.inputSchema, args)) {
          const fields = Value.Errors(def.inputSchema, args)
            .slice(0, 20)
            .map((e) => ({
              path: String(e.instancePath ?? ""),
              code: "INVALID_FIELD",
              message: "Invalid field type, value, or required constraint.",
            }));
          throw new OperationError("VALIDATION_ERROR", "Argument validation failed.", fields);
        }
        context.progress("executing");
        const data = await def.execute(args, context);
        if (Object.values(context.effects).every((v) => v === "unchanged")) controller.signal.throwIfAborted();
        if (!Value.Check(def.resultSchema, data))
          throw new OperationError("INVALID_RESULT", "Operation result does not match its declared schema.");
        result = { operationId: id, status: "succeeded", data, warnings: context.warnings, effects: context.effects };
      } catch (error) {
        const e = failure(error);
        result = {
          operationId: id,
          status:
            e.code === "CANCELLED"
              ? "cancelled"
              : ["AUTH_REQUIRED", "USER_ACTION_REQUIRED"].includes(e.code)
                ? "requires_user_action"
                : "failed",
          error: e,
          warnings: context.warnings,
          effects: context.effects,
        };
      } finally {
        args = undefined;
        parentSignal?.removeEventListener("abort", onAbort);
        for (const pending of [...task.pending.values()]) pending.reject(new DOMException("Cancelled", "AbortError"));
      }
      task.snapshot.state = result.status;
      task.snapshot.result = structuredClone(result);
      task.completed = this.now();
      send("extension_operation_result", { result: structuredClone(result) });
      return structuredClone(result);
    });
    return task;
  }
  get(id: string): Snapshot {
    this.prune();
    const task = this.tasks.get(id);
    if (!task) throw new OperationError("NOT_FOUND", "Operation not found or expired.");
    return structuredClone(task.snapshot);
  }
  cancel(id: string) {
    const task = this.tasks.get(id);
    if (!task) throw new OperationError("NOT_FOUND", "Operation not found.");
    const accepted = task.cancellable && !task.snapshot.result;
    if (accepted) task.controller.abort();
    return { accepted, ...this.get(id) };
  }
  respond(id: string, interactionId: string, revision: number, value?: string, cancelled?: boolean) {
    const task = this.tasks.get(id);
    const pending = task?.pending.get(interactionId);
    if (!task || !pending || pending.revision !== revision)
      throw new OperationError("STALE_REVISION", "The interaction has ended or its revision does not match.");
    if (cancelled) {
      task.controller.abort();
      return;
    }
    if (typeof value !== "string" || value.length > 262144)
      throw new OperationError("VALIDATION_ERROR", "Invalid input.");
    if (pending.request.options && !pending.request.options.some((o) => o.id === value))
      throw new OperationError("VALIDATION_ERROR", "Option not found.");
    pending.resolve(value);
  }
  async dispose() {
    for (const t of this.tasks.values()) if (!t.snapshot.result) t.controller.abort();
    await Promise.allSettled([...this.tasks.values()].map((t) => t.done));
    this.tasks.clear();
    this.requests.clear();
    this.definitions.clear();
  }
  private prune() {
    for (const [id, t] of this.tasks)
      if (t.completed !== undefined && this.now() - t.completed > lifetime) this.tasks.delete(id);
    for (const [key, r] of this.requests) if (!this.tasks.has(r.operationId)) this.requests.delete(key);
  }
}
