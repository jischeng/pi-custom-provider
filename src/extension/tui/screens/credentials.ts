import { confirmScreen, inputScreen } from "../components";
import type { Screen } from "../client";

export type CredentialChoice = { id: string; label: string; value?: any };

/**
 * The credential actions that apply to a provider. `file` is only offered where the extension can
 * record the path legally: a provider Pi ships has no record to hold it, and Pi rejects a record
 * whose only field is the path.
 */
export function credentialChoices(options: {
  auth: ("api_key" | "oauth")[];
  hasCredential: boolean;
  allowFile: boolean;
}): CredentialChoice[] {
  const oauth = options.auth.includes("oauth");
  const apiKey = options.auth.includes("api_key");
  return [
    ...(oauth ? [{ id: "sign-in", label: "Sign in" }] : []),
    ...(apiKey ? [{ id: "api-key", label: "Set API key" }] : []),
    ...(oauth ? [{ id: "import", label: "Import OAuth JSON" }] : []),
    ...(oauth && options.allowFile ? [{ id: "file", label: "Use OAuth file" }] : []),
    ...(options.hasCredential ? [{ id: "clear", label: "Clear credentials" }] : []),
  ];
}

/** Carries out a credential action for a provider that already exists. */
export async function applyCredentialChoice(
  screen: Screen,
  providerId: string,
  expectedRevision: string,
  action: string,
): Promise<boolean> {
  const { client, ctx, signal } = screen;
  const target = { providerId, expectedRevision };
  if (action === "sign-in") return !!(await client.call("auth.begin", target));
  if (action === "clear")
    return (
      (await confirmScreen(ctx, "Clear credentials", "Remove stored credentials?", signal)) &&
      !!(await client.call("auth.clear", target))
    );
  if (action === "api-key" || action === "import") {
    const label = action === "api-key" ? "Set API key" : "Import OAuth JSON";
    const value = await inputScreen(ctx, `${label} (input is visible)`, undefined, signal);
    if (!value) return false;
    return !!(await client.call(action === "api-key" ? "auth.configure" : "auth.import", { ...target, value }));
  }
  if (action === "file") {
    const path = await inputScreen(ctx, "File path on the Pi server (refreshes are written back)", undefined, signal);
    if (!path) return false;
    return !!(await client.call("auth.file", { ...target, path }));
  }
  return false;
}
