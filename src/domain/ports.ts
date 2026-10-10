import type { ModelConfig, ModelsConfig } from "./types";

/**
 * Domain-facing port implemented by the Pi runtime adapter. Keeping the
 * interface here lets the service depend on the capability instead of the
 * concrete extension module.
 */
export interface RuntimePort {
  sync(config: ModelsConfig): Promise<void>;
  active(): { provider: string; id: string } | undefined;
  busy(): boolean;
  exists?(id: string): boolean;
  /** The models Pi currently uses for a provider, with every user layer already applied. */
  modelsOf?(id: string): ModelConfig[] | undefined;
}
