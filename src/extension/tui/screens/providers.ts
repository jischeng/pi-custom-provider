import { providerPanel } from "../provider-panel";
import type { Screen } from "../client";

export type ProviderChoice = { kind: "create" } | { kind: "open"; id: string };

/**
 * `id (name, tags)`. The tags matter: a provider Pi ships behaves differently from one the user
 * configured — its endpoint, API and model list belong to Pi, and only per-model patches are ours.
 */
export function providerLabel(provider: any): string {
  const tags = [
    provider.name && provider.name !== provider.id ? provider.name : undefined,
    provider.source === "builtin" ? "Pi built-in" : undefined,
    provider.overriddenModelIds?.length ? `${provider.overriddenModelIds.length} adjusted` : undefined,
  ].filter(Boolean);
  return tags.length ? `${provider.id} (${tags.join(", ")})` : provider.id;
}

/** The entry screen: create a provider, or open one that already exists. */
export async function chooseProvider(screen: Screen): Promise<ProviderChoice | undefined> {
  const providers = await screen.client.allPages("provider.list");
  if (!providers) return undefined;
  let choice: string | undefined;
  await providerPanel(
    screen.ctx,
    () => ({
      title: "Providers",
      sections: [
        {
          heading: "Actions",
          items: [{ id: "$create", label: "Create provider" }],
        },
        {
          heading: "Providers",
          items: providers.map((provider: any) => ({ id: provider.id, label: providerLabel(provider) })),
        },
      ],
    }),
    async (id) => {
      choice = id;
      return false;
    },
    screen.signal,
  );
  if (!choice) return undefined;
  return choice === "$create" ? { kind: "create" } : { kind: "open", id: choice };
}
