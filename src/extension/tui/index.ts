import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Client, Screen } from "./client";
import { createClient } from "./client";
import { ProviderSession } from "./session";
import { addModelsScreen } from "./screens/add-models";
import { collectNewProvider, type CreateOutcome } from "./screens/create";
import { applyModelPreset, modelScreen } from "./screens/model";
import { providerScreen } from "./screens/provider";
import { chooseProvider, type ProviderChoice } from "./screens/providers";
import type { TuiOperations } from "./operations";

/**
 * The terminal workflow: pick a provider, edit it, and commit on every screen close.
 * Every screen lives in its own module; this function only owns the loop and the draft lifetime.
 */
export async function runSetup(operations: TuiOperations, ctx: ExtensionContext, signal?: AbortSignal) {
  const client = createClient(operations, ctx, signal);
  const screen: Screen = { client, ctx, signal };
  while (!signal?.aborted) {
    const choice = await chooseProvider(screen);
    if (!choice) return;
    const outcome = choice.kind === "create" ? await collectNewProvider(screen) : undefined;
    if (choice.kind === "create" && !outcome) continue;
    const opened = await openSession(screen, client, choice, outcome);
    if (!opened) continue;
    const { session, fresh } = opened;
    try {
      // A new provider saves first, then discovers, so the provider exists before its models do.
      await session.commit();
      if (fresh)
        await addModelsScreen(screen, session, {
          editModel: (modelId) => modelScreen(screen, session, modelId),
          applyPreset: (modelId) => applyModelPreset(screen, session, modelId),
        });
      await providerScreen(screen, session);
    } finally {
      await session.discard();
    }
  }
}

async function openSession(
  screen: Screen,
  client: Client,
  choice: ProviderChoice,
  outcome: CreateOutcome | undefined,
): Promise<{ session: ProviderSession; fresh: boolean } | undefined> {
  // Picking an endpoint Pi already ships, or an existing provider, opens it instead of creating.
  const target = outcome?.kind === "open" ? outcome.id : choice.kind === "open" ? choice.id : undefined;
  if (target) {
    if (outcome?.kind === "open")
      screen.ctx.ui.notify(`${target} is a provider Pi ships. Log in or adjust its models here.`, "info");
    return { session: await ProviderSession.open(client, target), fresh: false };
  }
  if (outcome?.kind !== "create") return undefined;
  const session = await ProviderSession.create(client, outcome.provider.values, outcome.provider.credential);
  if (outcome.provider.signIn) await session.login();
  return { session, fresh: true };
}
