import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Authentication } from "../src/oauth";
import { ConfigStore } from "../src/domain/store";

test("file-backed OAuth refresh reads and writes the same credential location and aliases", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-credential-review-"));
  try {
    const expired = { access: "OLD", refresh: "OLD_REFRESH", expires: Date.now() - 1000 };
    for (const value of [
      { tokens: expired, unrelated: "keep" },
      { tokens: expired, alias: { ...expired, access: "DORMANT" }, unrelated: "keep" },
      {
        tokens: { access_token: "OLD", refresh_token: "OLD_REFRESH", expires_at: Math.floor(Date.now() / 1000) - 1 },
        unrelated: "keep",
      },
    ]) {
      const file = path.join(directory, "external.json");
      fs.writeFileSync(file, JSON.stringify(value));
      let refreshes = 0;
      const auth = new Authentication(
        directory,
        () =>
          [
            {
              id: "openai-codex",
              auth: {
                oauth: {
                  refresh: async () => {
                    refreshes++;
                    return { type: "oauth", access: "NEW", refresh: "NEW_REFRESH", expires: Date.now() + 3600000 };
                  },
                  toAuth: async (c: any) => ({ apiKey: c.access }),
                },
              },
            },
          ] as any,
      );
      const config: any = {
        baseUrl: "https://fixture.invalid",
        api: "openai-codex-responses",
        models: [],
        authMode: "oauth",
        oauthProvider: "openai-codex",
        oauthJsonPath: file,
      };
      assert.equal((await auth.resolve("alias", config)).auth.apiKey, "NEW");
      assert.equal((await auth.resolve("alias", config)).auth.apiKey, "NEW");
      assert.equal(refreshes, 1);
      const after = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(after.unrelated, "keep");
      if ("alias" in value) assert.deepEqual(after.alias, value.alias);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a file appearing empty after an absent-file read is not silently initialized", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-store-review-"));
  try {
    const store = new ConfigStore(directory),
      revision = store.read().revision;
    fs.writeFileSync(store.file, "");
    await assert.rejects(
      store.commit(
        revision,
        (config) => {
          config.providers = {};
        },
        new AbortController().signal,
      ),
      /configuration/,
    );
    assert.equal(fs.readFileSync(store.file, "utf8"), "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
