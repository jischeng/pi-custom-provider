import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OperationRegistry } from "../operations/registry";
import { registrationChannel, type Registration } from "../operations/types";
import { failure, OperationError } from "../operations/errors";
export const bridgeProtocol = "pi.extension-operations.v1";

/** Generic host extension. It does not import or recognize any provider-manager code. */
export default function (pi: ExtensionAPI) {
  if (!process.send) return;
  const send = (data: unknown) => {
    if (process.connected) process.send?.({ bridgeProtocol, data });
  };
  const registry = new OperationRegistry(send);
  const unsubscribe = pi.events.on(registrationChannel, (registration: unknown) => {
    const r = registration as Registration;
    registry.register(r.namespace, r.operations);
  });
  const receive = async (message: any) => {
    if (message?.bridgeProtocol !== bridgeProtocol) return;
    const request = message.request;
    const reply = (data: unknown) =>
      send({ type: "response", id: request?.id, command: request?.type, success: true, data });
    try {
      if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.type !== "string")
        throw new OperationError("VALIDATION_ERROR", "Invalid request format.");
      if (request.id !== undefined && (typeof request.id !== "string" || request.id.length > 128))
        throw new OperationError("VALIDATION_ERROR", "Invalid request ID.");
      switch (request.type) {
        case "get_extension_operations":
          reply({
            protocolVersion: 1,
            transport: "pi-extension-rpc",
            capabilities: ["operations", "schemas", "status", "cancel", "user-auth"],
            operations: registry.describe(),
          });
          break;
        case "invoke_extension_operation": {
          if (
            typeof request.operation !== "string" ||
            typeof request.requestId !== "string" ||
            !request.requestId ||
            request.requestId.length > 128
          )
            throw new OperationError("VALIDATION_ERROR", "Operation name and requestId are required.");
          const task = registry.invoke(request.operation, request.arguments, "user_client", request.requestId);
          reply(registry.get(task.snapshot.operationId));
          break;
        }
        case "get_extension_operation":
          reply(registry.get(request.operationId));
          break;
        case "cancel_extension_operation":
          reply(registry.cancel(request.operationId));
          break;
        case "respond_extension_interaction":
          registry.respond(
            request.operationId,
            request.interactionId,
            request.revision,
            request.response?.value,
            request.response?.cancelled,
          );
          reply({ accepted: true });
          break;
        default:
          throw new OperationError("NOT_FOUND", "Unknown extension operation command.");
      }
    } catch (error) {
      const e = failure(error);
      send({
        type: "response",
        id: typeof request?.id === "string" ? request.id : undefined,
        command: request?.type || "parse",
        success: false,
        error: e.message,
        errorDetails: e,
      });
    }
  };
  process.on("message", receive);
  pi.on("session_start", async () => {
    send({ type: "extension_operations_ready", protocolVersion: 1 });
  });
  pi.on("session_shutdown", async () => {
    unsubscribe();
    process.off("message", receive);
    await registry.dispose();
  });
}
