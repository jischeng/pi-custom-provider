import { inputScreen } from "../components";
import { pickPanel, providerPanel } from "../provider-panel";
import { applyCredentialChoice, credentialChoices } from "./credentials";
import type { ActionChoice } from "../types";
import type { Screen } from "../client";

export type NewProvider = {
  /** Values for `draft.create`; credentials are collected before the draft exists. */
  values: Record<string, any>;
  credential: Record<string, any>;
  /** The user chose to sign in now, so the draft logs in before the first save. */
  signIn: boolean;
};

/**
 * Creating a provider adds a record of its own (`Enter a base URL myself`). Choosing one of the
 * endpoints Pi already knows does not create anything: that provider exists, so the flow becomes
 * "give it a credential, then manage it", which is exactly what the provider page does.
 */
export type CreateOutcome = { kind: "create"; provider: NewProvider } | { kind: "open"; id: string };

const CUSTOM = "$custom";

/**
 * Creating a provider: choose the API type, then either pick one of the endpoints for that API or
 * type your own. Credentials come last, before the draft exists, so discovery can run immediately.
 */
export async function collectNewProvider(screen: Screen): Promise<CreateOutcome | undefined> {
  const { client, ctx, signal } = screen;
  const catalog = await client.call("catalog.list", {});
  if (!catalog) return undefined;
  const api = await choose(
    screen,
    "API type",
    catalog.apis.map((item: any) => [item.id, item.label]),
  );
  if (!api) return undefined;

  // One call gives both the endpoints for this API and the authentication methods they allow.
  const forApi = await client.call("catalog.list", { api });
  const candidates: any[] = forApi?.providers ?? [];
  const apiName = catalog.apis.find((item: any) => item.id === api)?.label ?? api;
  let chosen: ActionChoice | undefined;
  await providerPanel(
    ctx,
    () => ({
      title: `${apiName} providers`,
      startAt: "Known endpoints",
      sections: [
        { heading: "Actions", items: [{ id: CUSTOM, label: "Enter a base URL myself" }] },
        {
          heading: "Known endpoints",
          items: candidates.map((provider) => ({
            id: provider.id,
            label: provider.baseUrl ? `${provider.name}  ${provider.baseUrl}` : provider.name,
            value: provider,
          })),
        },
      ],
    }),
    async (id) => {
      chosen =
        id === CUSTOM ? { id: CUSTOM, label: "" } : { id, label: "", value: candidates.find((p) => p.id === id) };
      return false;
    },
    signal,
  );
  if (!chosen) return undefined;

  // Every listed endpoint belongs to a provider Pi ships: open it instead of creating a record.
  if (chosen.id !== CUSTOM) {
    const known = chosen.value as any;
    // Already usable: just open it, so the same screen manages its credential and models.
    if (!(await setBuiltinCredential(screen, known))) return undefined;
    return { kind: "open", id: known.id };
  }

  const baseUrl = await inputScreen(ctx, "Base URL", "https://example.com/v1", signal);
  if (!baseUrl) return undefined;
  const id = await inputScreen(ctx, "Provider ID", "my-provider", signal);
  if (!id) return undefined;

  const methods: any[] = forApi?.authMethods ?? [];
  const method = await pickPanel(
    ctx,
    "Authentication method",
    methods.map((entry: any, index: number) => ({ id: String(index), label: entry.label, value: entry.value })),
    signal,
  );
  if (!method) return undefined;
  const credential = await askCredential(screen, method.value, {
    apiKey: true,
    oauth: method.value?.mode === "oauth",
    file: true,
  });
  if (!credential) return undefined;
  return {
    kind: "create",
    provider: {
      values: { id, baseUrl, api, auth: method.value, models: [] },
      credential: credential.material,
      signIn: !!credential.signIn,
    },
  };
}

/** A provider Pi ships already has an id, so it only needs a credential written to its own slot. */
async function setBuiltinCredential(screen: Screen, known: any): Promise<boolean> {
  const current = await screen.client.call("provider.get", { providerId: known.id });
  if (current?.auth?.hasCredential) return true;
  const chosen = await pickPanel(
    screen.ctx,
    `Authenticate ${known.name}`,
    credentialChoices({ auth: known.auth, hasCredential: false, allowFile: false }),
    screen.signal,
  );
  if (!chosen) return false;
  return applyCredentialChoice(screen, known.id, current.revision, chosen.id);
}

/** A select list with an id per row, so a labelled value always maps back to its id. */
async function choose(screen: Screen, title: string, entries: [string, string][]): Promise<string | undefined> {
  const chosen = await pickPanel(
    screen.ctx,
    title,
    entries.map(([id, label]) => ({ id, label, value: id })),
    screen.signal,
  );
  return chosen?.value as string | undefined;
}

type CredentialResult = { material: Record<string, any>; signIn?: boolean } | undefined;

/** Collects credential material before the draft exists; the service stores it for discovery. */
async function askCredential(
  screen: Screen,
  auth: any,
  allowed: { apiKey?: boolean; oauth?: boolean; file?: boolean },
): Promise<CredentialResult> {
  const { ctx, signal } = screen;
  if (auth.mode === "api_key") {
    if (!allowed.apiKey) return undefined;
    const apiKey = await inputScreen(ctx, "API key (input is visible)", undefined, signal);
    return apiKey === undefined ? undefined : { material: { apiKey } };
  }
  if (auth.mode !== "oauth" || !allowed.oauth) return { material: {} };
  const options = [
    { label: "Sign in", value: "sign-in" },
    { label: "Import OAuth JSON", value: "import" },
    ...(allowed.file ? [{ label: "Use OAuth file", value: "file" }] : []),
  ];
  const method = await pickPanel(
    ctx,
    "OAuth setup",
    options.map((option, index) => ({ id: String(index), label: option.label, value: option.value })),
    signal,
  );
  if (!method) return undefined;
  if (method.value === "import") {
    const oauthJson = await inputScreen(ctx, "OAuth JSON (input is visible)", undefined, signal);
    return oauthJson === undefined ? undefined : { material: { oauthJson } };
  }
  if (method.value === "file") {
    const oauthJsonPath = await inputScreen(ctx, "File path on the Pi server", undefined, signal);
    return oauthJsonPath === undefined ? undefined : { material: { oauthJsonPath } };
  }
  return { material: {}, signIn: true };
}
