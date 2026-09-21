import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { safeKeys } from "./domain/schema";
import { withLockedFile } from "./domain/file-store";
import {
  createModels,
  type AuthInteraction,
  type Credential,
  type CredentialStore,
  type OAuthCredential,
  type Provider,
  type Api,
  type KnownProvider,
  type AuthResult,
} from "@earendil-works/pi-ai";
import * as catalog from "@earendil-works/pi-ai/providers/all";
import { OperationError, checkAbort } from "./operations/errors";
import type { ProviderConfig } from "./types";
import type { Effects, OperationContext } from "./operations/types";

export class Authentication {
  constructor(
    readonly directory: string,
    private providers: () => readonly Provider[] = catalog.builtinProviders,
  ) {}
  key(id: string, config: ProviderConfig) {
    return config.credentialId || id;
  }
  mode(config: ProviderConfig) {
    return (
      config.authMode ||
      (config.oauthProvider
        ? "oauth"
        : config.apiKey || (config.credentialId && this.raw()[config.credentialId])
          ? "api_key"
          : "none")
    );
  }
  private raw(): Record<string, Credential> {
    try {
      return parseAuthStore(fs.readFileSync(path.join(this.directory, "auth.json"), "utf8"));
    } catch (error: any) {
      if (error.code === "ENOENT") return {};
      throw new OperationError("AUTH_FAILED", "认证存储不可读取。");
    }
  }
  status(id: string, config: ProviderConfig) {
    const mode = this.mode(config);
    const stored = this.raw()[this.key(id, config)];
    return {
      mode,
      methodId: config.oauthProvider,
      status:
        mode === "none"
          ? "configured"
          : config.oauthJsonPath
            ? "unknown"
            : stored || config.apiKey
              ? stored?.type === "oauth" && stored.expires < Date.now()
                ? "expired"
                : "configured"
              : "missing",
      hasCredential: !!(stored || config.apiKey || config.oauthJsonPath),
    };
  }
  private store(id: string, config: ProviderConfig, signal?: AbortSignal, onWrite?: () => void): CredentialStore {
    const authPath = path.join(this.directory, "auth.json");
    if (!config.oauthJsonPath)
      return {
        read: async (key) => this.raw()[key],
        list: async () =>
          Object.entries(this.raw()).map(([providerId, credential]) => ({ providerId, type: credential.type })),
        modify: (key, fn) =>
          withLockedFile(
            authPath,
            signal,
            async (raw) => {
              const data = parseAuthStore(raw);
              const next = await fn(data[key]);
              if (!next) return { result: data[key] };
              data[key] = next;
              return { result: next, next: JSON.stringify(data, null, 2) + "\n" };
            },
            onWrite,
          ),
        delete: (key) =>
          withLockedFile(
            authPath,
            signal,
            async (raw) => {
              const data = parseAuthStore(raw);
              delete data[key];
              return { result: undefined, next: JSON.stringify(data, null, 2) + "\n" };
            },
            onWrite,
          ),
      };
    const file = path.resolve(config.oauthJsonPath.replace(/^~(?=$|\/)/, os.homedir()));
    const read = () => {
      try {
        return credentialFromJson(JSON.parse(fs.readFileSync(file, "utf8")), {
          providerId: id,
          oauthProvider: config.oauthProvider!,
        });
      } catch {
        throw new OperationError("AUTH_FAILED", "无法读取所选 OAuth JSON 文件。");
      }
    };
    return {
      read: async () => read(),
      list: async () => [{ providerId: this.key(id, config), type: "oauth" }],
      modify: async (_key, fn) => {
        if (!fs.existsSync(file)) throw new OperationError("AUTH_FAILED", "所选 OAuth JSON 文件不存在。");
        try {
          return await withLockedFile(
            file,
            signal,
            async (raw) => {
              if (raw === undefined) throw new OperationError("AUTH_FAILED", "所选认证文件不存在。");
              const json = JSON.parse(raw);
              const current = credentialFromJson(json, { providerId: id, oauthProvider: config.oauthProvider! });
              const next = await fn(current);
              if (!next) return { result: current };
              return {
                result: next,
                next:
                  JSON.stringify(
                    replaceCredentialInJson(json, next as OAuthCredential, {
                      providerId: id,
                      oauthProvider: config.oauthProvider!,
                    }),
                    null,
                    2,
                  ) + "\n",
              };
            },
            onWrite,
          );
        } catch (error) {
          checkAbort(signal);
          if (error instanceof OperationError) throw error;
          throw new OperationError("AUTH_FAILED", "无法刷新或写入所选 OAuth JSON 文件。");
        }
      },
      delete: async () => {
        throw new OperationError("UNSUPPORTED_CAPABILITY", "外部认证文件不会被删除，请移除文件引用。");
      },
    };
  }
  oauthProvider(config: ProviderConfig): Provider<Api> {
    const provider =
      config.oauthProvider === "radius"
        ? catalog.radiusProvider({ gateway: config.baseUrl })
        : this.providers().find((p) => p.id === config.oauthProvider);
    if (!provider?.auth.oauth) throw new OperationError("UNSUPPORTED_CAPABILITY", "此 OAuth 方式不可用。");
    return provider as Provider<Api>;
  }
  async resolve(id: string, config: ProviderConfig, signal?: AbortSignal, effects?: Effects): Promise<AuthResult> {
    checkAbort(signal);
    if (this.mode(config) === "none") return { auth: { apiKey: "unused", headers: { Authorization: null } } };
    if (this.mode(config) === "api_key") {
      const credential = this.raw()[this.key(id, config)];
      let key = credential?.type === "api_key" ? credential.key : config.apiKey;
      if (!key) throw new OperationError("AUTH_REQUIRED", "请先由用户配置 API Key。");
      // Existing command-based credentials are deliberately not executed by management operations.
      if (key.startsWith("!"))
        throw new OperationError("UNSUPPORTED_CAPABILITY", "请使用已存 API Key 或环境变量引用，不执行凭据命令。");
      if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(key)) key = process.env[key.replace(/^\$\{?|\}$/g, "")];
      if (!key) throw new OperationError("AUTH_REQUIRED", "认证环境变量尚未设置。");
      return { auth: { apiKey: key, ...(config.authHeader === false ? { headers: { Authorization: null } } : {}) } };
    }
    const provider = this.oauthProvider(config);
    const oauth = provider.auth.oauth!;
    const key = this.key(id, config);
    const credentials = this.store(id, config, signal, () => {
      if (effects) effects.credentials = "updated";
    });
    const models = createModels({ credentials });
    models.setProvider({
      ...provider,
      id: key,
      auth: {
        oauth: {
          ...oauth,
          refresh: (c, s) => oauth.refresh(c, signal && s ? AbortSignal.any([signal, s]) : signal || s),
        },
      },
    });
    try {
      const result = await models.getAuth(key);
      checkAbort(signal);
      if (!result) throw new OperationError("AUTH_REQUIRED", "请先由用户完成 OAuth 登录。");
      return result;
    } catch (error) {
      checkAbort(signal);
      if (error instanceof OperationError) throw error;
      throw new OperationError("AUTH_FAILED", "OAuth 认证或刷新失败。", undefined, true);
    }
  }
  async saveCredential(
    id: string,
    config: ProviderConfig,
    credential: Credential | undefined,
    context: OperationContext,
  ) {
    checkAbort(context.signal);
    const store = this.store(id, { ...config, oauthJsonPath: undefined }, context.signal, () => {
      context.effects.credentials = "updated";
    });
    if (credential) await store.modify(this.key(id, config), async () => credential);
    else await store.delete(this.key(id, config));
  }
  importedCredential(id: string, config: ProviderConfig, value: string): OAuthCredential {
    if (this.mode(config) !== "oauth") throw new OperationError("VALIDATION_ERROR", "当前认证方式不是 OAuth。");
    try {
      return credentialFromJson(JSON.parse(value), { providerId: id, oauthProvider: config.oauthProvider! });
    } catch {
      throw new OperationError("VALIDATION_ERROR", "OAuth JSON 不包含有效认证数据。");
    }
  }
  async login(config: ProviderConfig, context: OperationContext): Promise<OAuthCredential> {
    if (context.caller !== "user_client") throw new OperationError("USER_ACTION_REQUIRED", "请由用户完成认证。");
    const interaction: AuthInteraction = {
      signal: context.signal,
      prompt: (p) =>
        context.prompt(
          {
            kind: p.type,
            message: p.message,
            ...(p.type === "select"
              ? { options: [...p.options] }
              : { placeholder: p.placeholder, secret: p.type === "secret" || p.type === "manual_code" }),
          },
          p.signal,
        ),
      notify: (e) => {
        if (e.type === "auth_url")
          context.notify({ kind: "open_url", message: e.instructions || "在浏览器中完成登录。", url: e.url });
        else if (e.type === "device_code")
          context.notify({
            kind: "device_code",
            message: "使用设备码完成登录。",
            userCode: e.userCode,
            verificationUri: e.verificationUri,
          });
        else context.progress("authenticating");
      },
    };
    try {
      const credential = await this.oauthProvider(config).auth.oauth!.login(interaction);
      checkAbort(context.signal);
      return credential;
    } catch (error) {
      checkAbort(context.signal);
      if (error instanceof OperationError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new OperationError("AUTH_FAILED", "OAuth 登录未完成。", undefined, true);
    }
  }
  newBinding() {
    return `provider-auth-${randomUUID()}`;
  }
}
export function credentialFromJson(
  value: unknown,
  options: { providerId: string; oauthProvider: KnownProvider; fallbackToOAuthProvider?: boolean },
): OAuthCredential {
  const { credential: picked } = locateCredential(value, options);
  const access =
    stringValue(picked.access) ||
    stringValue(picked.access_token) ||
    stringValue(picked.token) ||
    stringValue(picked.key);
  if (!access) throw new Error("OAuth JSON is missing access/access_token.");
  const refresh = stringValue(picked.refresh) || stringValue(picked.refresh_token) || "";
  return {
    ...picked,
    type: "oauth",
    access,
    refresh,
    expires: expiresValue(picked),
  };
}

function locateCredential(
  value: unknown,
  options: { providerId: string; oauthProvider: KnownProvider; fallbackToOAuthProvider?: boolean },
) {
  if (!isRecord(value)) throw new Error("OAuth JSON must be an object.");
  if (looksLikeCredential(value)) return { root: value, credential: value, key: undefined };
  for (const key of [
    "tokens",
    options.providerId,
    ...(options.fallbackToOAuthProvider === false ? [] : [options.oauthProvider]),
  ]) {
    const candidate = value[key];
    if (isRecord(candidate) && looksLikeCredential(candidate)) return { root: value, credential: candidate, key };
  }
  throw new Error("OAuth JSON does not contain a credential.");
}

function replaceCredentialInJson(
  value: unknown,
  credential: OAuthCredential,
  options: { providerId: string; oauthProvider: KnownProvider },
): unknown {
  const located = locateCredential(value, options);
  const next: Record<string, unknown> = { ...located.credential, ...credential };
  // Update aliases used by the external owner too, instead of leaving a stale token next to a new one.
  for (const key of ["access_token", "token", "key"]) if (key in located.credential) next[key] = credential.access;
  if ("refresh_token" in located.credential) next.refresh_token = credential.refresh;
  for (const key of ["expires_at", "expiry_date"]) {
    const original = located.credential[key];
    if (original === undefined) continue;
    const numeric = numberValue(original);
    next[key] =
      numeric === undefined
        ? new Date(credential.expires).toISOString()
        : numeric < 10_000_000_000
          ? Math.floor(credential.expires / 1000)
          : credential.expires;
  }
  if ("expires_in" in located.credential)
    next.expires_in = Math.max(0, Math.floor((credential.expires - Date.now()) / 1000));
  return located.key === undefined ? next : { ...located.root, [located.key]: next };
}

function looksLikeCredential(value: Record<string, unknown>): boolean {
  return (
    value.type === "oauth" ||
    typeof value.access === "string" ||
    typeof value.access_token === "string" ||
    typeof value.token === "string" ||
    typeof value.key === "string"
  );
}

function expiresValue(value: Record<string, unknown>): number {
  const explicit =
    numberValue(value.expires) ??
    numberValue(value.expires_at) ??
    numberValue(value.expiry_date) ??
    dateValue(value.expires) ??
    dateValue(value.expires_at) ??
    dateValue(value.expiry_date);
  if (explicit !== undefined) return explicit < 10_000_000_000 ? explicit * 1000 : explicit;
  const expiresIn = numberValue(value.expires_in);
  return expiresIn === undefined ? Number.MAX_SAFE_INTEGER : Date.now() + expiresIn * 1000;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function dateValue(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const n = Date.parse(value);
  return Number.isNaN(n) ? undefined : n;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseAuthStore(raw: string | undefined): Record<string, Credential> {
  try {
    const value = JSON.parse(raw ?? "{}");
    if (!isRecord(value)) throw new Error();
    safeKeys(value);
    return value as Record<string, Credential>;
  } catch {
    throw new OperationError("AUTH_FAILED", "认证存储不是有效对象，未修改文件。");
  }
}
