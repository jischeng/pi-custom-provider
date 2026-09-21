import type { Failure } from "./types";
const operationErrorBrand = Symbol.for("pi.extension-operations.error.v1");
export class OperationError extends Error {
  readonly [operationErrorBrand] = true;
  constructor(
    public code: string,
    message: string,
    public fields?: Failure["fields"],
    public retryable = false,
  ) {
    super(message);
  }
}
export function failure(error: unknown): Failure {
  if (error instanceof OperationError || (error instanceof Error && (error as any)[operationErrorBrand] === true)) {
    const e = error as OperationError;
    return { code: e.code, message: e.message, fields: e.fields, retryable: e.retryable };
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
    return {
      code: error.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED",
      message: error.name === "TimeoutError" ? "Operation timed out." : "Operation cancelled.",
      retryable: true,
    };
  // Raw provider, filesystem and credential errors must never cross this boundary.
  return {
    code: "INTERNAL_ERROR",
    message: "Operation failed. Check the service configuration and try again.",
    retryable: false,
  };
}
export function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
