import type { Api, KnownApi, KnownProvider, Provider } from "@earendil-works/pi-ai";
import * as providerCatalog from "@earendil-works/pi-ai/providers/all";

const RADIUS_API = "pi-messages" as KnownApi;

export const API_CHOICES: KnownApi[] = loadApiChoices();
export const OAUTH_PROVIDER_CHOICES: KnownProvider[] = loadOAuthProviderChoices();

export function apiLabel(api: KnownApi): string {
  return humanizeId(api);
}

export function oauthProviderLabel(provider: KnownProvider): string {
  const builtin = builtinOAuthProviderConfig(provider);
  return builtin?.name || provider;
}

export function oauthProviderChoicesForApi(api: KnownApi): KnownProvider[] {
  const providers = loadOAuthProviderChoices().filter((provider) => oauthProviderSupportsApi(provider, api));
  return providers;
}

export function apiSupportsApiKey(api: KnownApi): boolean {
  return providerCatalog
    .builtinProviders()
    .some((provider) => !!provider.auth?.apiKey && provider.getModels().some((model) => model.api === api));
}

export function oauthProviderSupportsApi(provider: KnownProvider, api: KnownApi): boolean {
  return (
    !!builtinOAuthProviderConfig(provider)
      ?.getModels()
      .some((model) => model.api === api) || dynamicOAuthProviderApi(provider) === api
  );
}

export function builtinOAuthProviderConfig(oauthProvider: KnownProvider): Provider<Api> | undefined {
  const provider = providerCatalog.builtinProviders().find((item) => item.id === oauthProvider && item.auth?.oauth);
  return provider as Provider<Api> | undefined;
}

function loadOAuthProviderChoices(): KnownProvider[] {
  return providerCatalog
    .builtinProviders()
    .filter((provider) => provider.auth?.oauth)
    .map((provider) => provider.id as KnownProvider);
}

function loadApiChoices(): KnownApi[] {
  const seen = new Set<KnownApi>();
  for (const provider of providerCatalog.builtinProviders()) {
    for (const model of provider.getModels()) {
      if (typeof model.api === "string") seen.add(model.api as KnownApi);
    }
  }
  seen.add(RADIUS_API);
  return [...seen];
}

function dynamicOAuthProviderApi(provider: KnownProvider): KnownApi | undefined {
  return provider === "radius" ? RADIUS_API : undefined;
}

function humanizeId(id: string): string {
  const acronyms = new Set(["api", "ai", "aws", "url", "id", "json", "oauth"]);
  return id
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((word) =>
      acronyms.has(word.toLowerCase()) ? word.toUpperCase() : `${word[0]?.toUpperCase() || ""}${word.slice(1)}`,
    )
    .join(" ");
}
