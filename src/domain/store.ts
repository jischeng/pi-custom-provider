import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { withLockedFile } from "./file-store";
import { OperationError, checkAbort } from "../operations/errors";
import { safeKeys } from "./schema";
import type { ModelsConfig } from "./types";
export class ConfigStore {
  readonly file: string;
  constructor(readonly directory: string) {
    this.file = path.join(directory, "models.json");
  }
  read() {
    let raw: string | undefined;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (error: any) {
      if (error.code !== "ENOENT")
        throw new OperationError("CONFIG_READ_FAILED", "Could not read the model configuration.");
    }
    return this.decode(raw);
  }
  private decode(raw: string | undefined) {
    try {
      const config = JSON.parse(raw ?? "{}");
      if (config && typeof config === "object" && !Array.isArray(config) && config.providers === undefined)
        config.providers = {};
      if (
        !config ||
        typeof config !== "object" ||
        Array.isArray(config) ||
        !config.providers ||
        typeof config.providers !== "object" ||
        Array.isArray(config.providers)
      )
        throw new Error();
      safeKeys(config);
      return {
        config: config as ModelsConfig & Record<string, unknown>,
        revision: createHash("sha256")
          .update(raw ?? "{}")
          .digest("hex"),
      };
    } catch {
      throw new OperationError(
        "CONFIG_READ_FAILED",
        "The model configuration is not a valid object. Nothing was repaired or overwritten.",
      );
    }
  }
  async commit(expected: string, mutate: (config: ModelsConfig) => void | Promise<void>, signal: AbortSignal) {
    checkAbort(signal);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      return await withLockedFile(this.file, signal, async (raw) => {
        checkAbort(signal);
        const state = this.decode(raw);
        if (state.revision !== expected)
          throw new OperationError(
            "CONFLICT",
            "The configuration was changed by another operation. Reload it and try again.",
          );
        await mutate(state.config);
        safeKeys(state.config);
        checkAbort(signal);
        const next = JSON.stringify(state.config, null, 2) + "\n";
        return { result: this.decode(next), next };
      });
    } catch (error) {
      if (error instanceof OperationError || (error instanceof Error && error.name === "AbortError")) throw error;
      throw new OperationError(
        "CONFIG_WRITE_FAILED",
        "Could not save the configuration. The original file was not replaced.",
        undefined,
        true,
      );
    }
  }
}
