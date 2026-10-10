/** Public contract for extensions that declare operations. */
export type {
  Caller,
  Effects,
  Failure,
  Result,
  Interaction,
  OperationContext,
  OperationDefinition,
  OperationDescriptor,
} from "./types";
export { descriptorOf, findOperation, operationsFor, runOperation } from "./runner";
export { OperationError } from "./errors";
