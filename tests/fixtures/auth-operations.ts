import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Authentication } from "../../src/extension/adapters/authentication";
import { ProviderService } from "../../src/domain/service";
import { runHeadlessCommand } from "../../src/extension/headless";

/** A second extension exposing its own operations through the same Pi-native headless path. */
export default function (pi: ExtensionAPI) {
  const authentication = new Authentication(
    getAgentDir(),
    () =>
      [
        {
          id: "openai-codex",
          name: "Fixture OAuth",
          getModels: () => [],
          auth: {
            oauth: {
              name: "Fixture OAuth",
              login: async (interaction: any) => {
                await interaction.prompt({
                  type: "select",
                  message: "Choose method",
                  options: [{ id: "device", label: "Device method" }],
                });
                interaction.notify({
                  type: "device_code",
                  verificationUri: "https://fixture.invalid/login",
                  userCode: "LOCAL-ONLY",
                });
                const code = await interaction.prompt({ type: "manual_code", message: "Paste test code" });
                if (code !== "fixture-code") throw new Error("SENTINEL_INTERNAL_ERROR");
                return {
                  type: "oauth",
                  access: "SENTINEL_ACCESS",
                  refresh: "SENTINEL_REFRESH",
                  expires: Date.now() + 3600000,
                };
              },
              refresh: async (c: any) => c,
              toAuth: async (c: any) => ({ apiKey: c.access }),
            },
          },
          stream: () => undefined,
          streamSimple: () => undefined,
        },
      ] as any,
  );
  const service = new ProviderService({
    directory: getAgentDir(),
    authentication,
    runtime: { sync: async () => {}, active: () => undefined, busy: () => false },
    discovery: { catalogUrl: null },
  });
  pi.registerCommand("auth-fixture", {
    description: "Fixture provider operations",
    handler: async (args, ctx) => {
      const [operation, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      await runHeadlessCommand(pi, ctx, service.definitions(), operation, rest.join(" "));
    },
  });
  pi.on("session_shutdown", async () => service.dispose());
}
