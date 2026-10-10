import type { Result } from "../../operations/types";
import { resolveModel } from "../../domain/model";
import type { ProviderConfig } from "../../domain/types";
import { cleared } from "./components";
import type { Client } from "./client";

export type ModelValues = Record<string, any>;

/**
 * One provider's editing session: the draft, the saved provider it came from, and every
 * write that touches either. Screens read values from here and never hold a draft themselves.
 */
export class ProviderSession {
  private draft: any;
  private stored: any;

  private constructor(
    private client: Client,
    draft: any,
    stored: any,
  ) {
    this.draft = draft;
    this.stored = stored;
  }

  static async create(client: Client, values: ModelValues, credential: ModelValues): Promise<ProviderSession> {
    const draft = await client.call("draft.create", { ...values, ...credential });
    return new ProviderSession(client, draft, await client.call("provider.get", { providerId: values.id }));
  }

  static async open(client: Client, providerId: string): Promise<ProviderSession> {
    const stored = await client.call("provider.get", { providerId });
    // A provider Pi ships has no draft: its endpoint and models belong to Pi, and only the
    // per-model patches below are ours to write.
    if (stored?.source === "builtin") return new ProviderSession(client, undefined, stored);
    const draft = await client.call("draft.open", { providerId });
    return new ProviderSession(client, draft, stored);
  }

  get values(): ModelValues {
    return this.draft ? this.draft.values : this.stored;
  }
  get models(): any[] {
    return this.values.models ?? [];
  }
  get candidates(): any[] {
    return this.draft.candidates ?? [];
  }
  get selectedModelIds(): string[] {
    return this.draft.selectedModelIds ?? [];
  }
  get saved(): any {
    return this.stored;
  }
  /** True when this record only patches a provider Pi ships. */
  get isBuiltin(): boolean {
    return this.stored?.source === "builtin";
  }
  /** The patch stored for a built-in model, or an empty one. */
  overrideOf(modelId: string): Record<string, any> {
    return this.stored?.modelOverrides?.[modelId] ?? {};
  }
  /** Writes a patch for a built-in model; an undefined value removes that key. */
  async overrideModel(modelId: string, key: string, value: unknown): Promise<void> {
    const patch: Record<string, any> = { ...this.overrideOf(modelId) };
    if (value === undefined) delete patch[key];
    else patch[key] = value;
    const next = await this.client.call("model.override", {
      providerId: this.stored.id,
      modelId,
      expectedRevision: this.stored.revision,
      set: patch,
    });
    if (next) this.stored = next;
  }
  /** Re-reads a provider Pi ships; it has no draft to reload. */
  async refresh(): Promise<boolean> {
    const next = await this.client.call("provider.get", { providerId: this.stored.id });
    if (!next) return false;
    this.stored = next;
    return true;
  }
  /** Removes every patch for a built-in model, returning it to what Pi ships. */
  async clearOverride(modelId: string): Promise<void> {
    const keys = Object.keys(this.overrideOf(modelId));
    if (!keys.length) return;
    const next = await this.client.call("model.override", {
      providerId: this.stored.id,
      modelId,
      expectedRevision: this.stored.revision,
      unset: keys,
    });
    if (next) this.stored = next;
  }
  get ref() {
    return { draftId: this.draft.draftId, revision: this.draft.revision };
  }
  model(modelId: string): any | undefined {
    return this.models.find((item: any) => item.id === modelId);
  }
  /** The model as Pi will register it, with unset fields resolved exactly like the runtime does. */
  resolve(modelId: string) {
    return resolveModel(this.values.id, this.values as ProviderConfig, this.model(modelId) ?? { id: modelId });
  }

  async login(): Promise<void> {
    const signedIn = await this.client.call("draft.login", this.ref);
    if (signedIn) this.draft = signedIn;
  }

  async patch(set: Record<string, unknown>, unset?: string[]): Promise<void> {
    const next = await this.client.call("draft.patch", { ...this.ref, set, ...(unset ? { unset } : {}) });
    if (next) this.draft = next;
  }

  async upsertModel(model: ModelValues): Promise<void> {
    const next = await this.client.call("draft.upsertModel", { ...this.ref, model });
    if (next) this.draft = next;
  }

  /** Writes one nested model field; an undefined value removes it. */
  async writeModelField(modelId: string, path: string, value: unknown): Promise<void> {
    const updated = structuredClone(this.model(modelId) ?? { id: modelId });
    setPath(updated, path.split("."), value === undefined ? cleared : value);
    await this.upsertModel(updated);
  }

  async selectModels(modelIds: string[]): Promise<string[]> {
    const next = await this.client.call("draft.selectModels", { ...this.ref, modelIds });
    if (next) this.draft = next;
    return this.selectedModelIds;
  }

  async applyPreset(modelId: string, presetId: string): Promise<void> {
    const next = await this.client.call("draft.applyPreset", { ...this.ref, modelId, presetId });
    if (next) this.draft = next;
  }

  async removeModel(modelId: string): Promise<void> {
    const next = await this.client.call("draft.removeModel", { ...this.ref, modelId });
    if (next) this.draft = next;
  }

  async discover(): Promise<Result> {
    const result = await this.client.execute("model.discover", this.ref);
    if (result.status === "succeeded") this.draft = result.data;
    return result;
  }

  /** Commits the draft and reloads it; false when nothing was committed. */
  async commit(): Promise<boolean> {
    // Nothing to commit for a built-in provider: every edit already went through model.override.
    if (!this.draft) return true;
    const id = this.draft.values.id;
    const result = await this.client.execute("draft.commit", this.ref);
    if (result.effects.config !== "committed") return false;
    const reopened = await this.client.call("draft.open", { providerId: id });
    if (!reopened) return false;
    this.draft = reopened;
    this.stored = await this.client.call("provider.get", { providerId: id });
    return !!this.stored;
  }

  async discard(): Promise<void> {
    if (!this.draft) return;
    await this.client.call("draft.discard", this.ref);
  }
}

export const readPath = (target: any, path: string[]): any => path.reduce((value, key) => value?.[key], target);

const setPath = (target: any, path: string[], value: unknown): void => {
  const key = path[0];
  if (path.length === 1) {
    if (value === cleared) delete target[key];
    else target[key] = value;
    return;
  }
  target[key] = { ...(target[key] ?? {}) };
  setPath(target[key], path.slice(1), value);
  if (!Object.keys(target[key]).length) delete target[key];
};
