import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registrationChannel } from "../../src/operations/types";
export default function (pi: ExtensionAPI) {
  pi.events.emit(registrationChannel, {
    namespace: "notes",
    operations: [
      {
        name: "length",
        title: "Character count",
        description: "Test operation unrelated to provider management",
        inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
        resultSchema: Type.Object({ length: Type.Number() }),
        effects: ["read"],
        allowedCallers: ["user_client"],
        cancellable: false,
        execute: async (args: { text: string }) => ({ length: [...args.text].length }),
      },
    ],
  });
}
