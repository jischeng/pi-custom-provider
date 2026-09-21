import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProviderService } from "../src/domain/service";
import { OperationRegistry } from "../src/operations/registry";
import { Authentication } from "../src/oauth";

const values = (id = "fixture") => ({
  id,
  name: "Fixture",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:18080/v1",
  auth: { mode: "none" },
  models: [{ id: "m1", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
});
function fixture(options: any = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-service-"));
  const events: any[] = [];
  let synced: any,
    active: any,
    busy = false,
    failSync = false;
  const runtime = {
    sync: async (c: any) => {
      if (failSync) throw new Error("internal secret");
      synced = c;
    },
    active: () => active,
    busy: () => busy,
  };
  const service = new ProviderService({
    directory,
    now: options.now,
    runtime,
    discovery: { catalogUrl: null, ...options.discovery },
    authentication: options.authFactory?.(directory),
  });
  const registry = new OperationRegistry((e) => events.push(e));
  registry.register("provider-manager", service.definitions());
  const run = (name: string, args: any, caller: any = "user_client", requestId?: string) =>
    registry.invoke(`provider-manager/${name}`, args, caller, requestId).done;
  return {
    directory,
    service,
    registry,
    events,
    run,
    get synced() {
      return synced;
    },
    setActive: (a: any) => {
      active = a;
    },
    failSync: () => {
      failSync = true;
    },
    dispose: async () => {
      await registry.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("create/update/rename/delete use revisions and preserve unrelated configuration", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.directory, "models.json"), JSON.stringify({ extra: { keep: 1 }, providers: {} }));
    let r = await f.run("provider.create", values());
    assert.equal(r.status, "succeeded");
    assert.equal(r.effects.config, "committed");
    assert.equal(f.synced.providers.fixture.models[0].id, "m1");
    assert.equal((await f.run("provider.create", values())).error?.code, "CONFLICT");
    const revision = r.data.revision;
    r = await f.run("provider.update", {
      providerId: "fixture",
      expectedRevision: revision,
      set: { id: "renamed", name: "Renamed" },
    });
    assert.equal(r.status, "succeeded");
    assert.equal(
      (await f.run("provider.update", { providerId: "renamed", expectedRevision: revision, set: { name: "stale" } }))
        .error?.code,
      "CONFLICT",
    );
    assert.equal((await f.run("provider.get", { providerId: "fixture" })).error?.code, "NOT_FOUND");
    f.setActive({ provider: "renamed", id: "m1" });
    assert.equal(
      (await f.run("provider.delete", { providerId: "renamed", expectedRevision: r.data.revision })).error?.code,
      "ACTIVE_MODEL_IN_USE",
    );
    f.setActive(undefined);
    assert.equal(
      (await f.run("provider.delete", { providerId: "renamed", expectedRevision: r.data.revision })).status,
      "succeeded",
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, "models.json"), "utf8")), {
      extra: { keep: 1 },
      providers: {},
    });
  } finally {
    await f.dispose();
  }
});
test("draft changes are explicit, versioned, discardable and preserve model fields", async () => {
  const f = fixture();
  try {
    await f.run("provider.create", values());
    const before = fs.readFileSync(path.join(f.directory, "models.json"), "utf8");
    let d = (await f.run("draft.open", { providerId: "fixture" })).data;
    const old = d.revision;
    d = (
      await f.run("draft.upsertModel", {
        draftId: d.draftId,
        revision: d.revision,
        model: {
          id: "m2",
          reasoning: true,
          cost: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            tiers: [{ inputTokensAbove: 100, input: 2, output: 3, cacheRead: 1, cacheWrite: 1 }],
          },
          compat: { supportsStore: false },
        },
      })
    ).data;
    assert.equal(
      (await f.run("draft.patch", { draftId: d.draftId, revision: old, set: { name: "stale" } })).error?.code,
      "STALE_REVISION",
    );
    assert.equal(fs.readFileSync(path.join(f.directory, "models.json"), "utf8"), before);
    d = (await f.run("draft.selectModels", { draftId: d.draftId, revision: d.revision, modelIds: ["m2"] })).data;
    const saved = await f.run("draft.commit", { draftId: d.draftId, revision: d.revision });
    assert.equal(saved.status, "succeeded");
    assert.equal(saved.data.models[0].cost.tiers[0].inputTokensAbove, 100);
    const draft = (await f.run("draft.open", { providerId: "fixture" })).data;
    await f.run("draft.discard", { draftId: draft.draftId, revision: draft.revision });
    assert.equal((await f.run("draft.get", { draftId: draft.draftId })).error?.code, "NOT_FOUND");
  } finally {
    await f.dispose();
  }
});
test("validation does not silently replace values; broken config is never overwritten", async () => {
  const f = fixture();
  try {
    assert.equal((await f.run("provider.create", { ...values(), apiKey: "secret" })).error?.code, "VALIDATION_ERROR");
    assert.equal(
      (await f.run("provider.create", { ...values(), baseUrl: "https://x.test?token=SECRET" })).error?.code,
      "VALIDATION_ERROR",
    );
    assert.equal(
      (await f.run("provider.create", { ...values(), models: [{ id: "m", maxTokens: -1 }] })).error?.code,
      "VALIDATION_ERROR",
    );
    fs.writeFileSync(path.join(f.directory, "models.json"), "BROKEN");
    assert.equal((await f.run("provider.create", values())).error?.code, "CONFIG_READ_FAILED");
    assert.equal(fs.readFileSync(path.join(f.directory, "models.json"), "utf8"), "BROKEN");
  } finally {
    await f.dispose();
  }
});
test("credentials and header values are absent from every public projection, destination changes detach them", async () => {
  const f = fixture();
  try {
    let p = (await f.run("provider.create", { ...values(), auth: { mode: "api_key" } })).data;
    assert.equal(
      (await f.run("auth.configure", { providerId: p.id, expectedRevision: p.revision, value: "SENTINEL_KEY" })).status,
      "succeeded",
    );
    assert.equal(
      (
        await f.run("headers.set", {
          providerId: p.id,
          expectedRevision: p.revision,
          name: "X-Token",
          value: "SENTINEL_HEADER",
        })
      ).status,
      "succeeded",
    );
    p = (await f.run("provider.get", { providerId: p.id })).data;
    assert.equal(p.auth.status, "configured");
    assert.equal(p.headers[0].hasValue, true);
    assert(!JSON.stringify(f.events).includes("SENTINEL"));
    assert.throws(
      () =>
        f.registry.invoke(
          "provider-manager/auth.configure",
          { providerId: p.id, expectedRevision: p.revision, value: "x" },
          "model_tool",
        ),
      /user/,
    );
    let r = await f.run("provider.update", { providerId: p.id, expectedRevision: p.revision, set: { id: "new-id" } });
    assert.equal(r.data.auth.status, "configured");
    p = r.data;
    r = await f.run("provider.update", {
      providerId: p.id,
      expectedRevision: p.revision,
      set: { baseUrl: "https://other.test/v1" },
    });
    assert.equal(r.data.auth.status, "missing");
    assert.deepEqual(r.data.headers, []);
  } finally {
    await f.dispose();
  }
});
test("discovery cancellation aborts HTTP and never updates a discarded or newer draft", async () => {
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  let aborted = false;
  const f = fixture({
    discovery: {
      fetch: async (_url: any, init: any) =>
        new Promise((_r, reject) => {
          started();
          init.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(init.signal.reason);
            },
            { once: true },
          );
        }),
    },
  });
  try {
    const d = (await f.run("draft.create", values())).data;
    const task = f.registry.invoke("provider-manager/model.discover", { draftId: d.draftId, revision: d.revision });
    await ready;
    f.registry.cancel(task.snapshot.operationId);
    assert.equal((await task.done).status, "cancelled");
    assert(aborted);
    assert.equal((await f.run("draft.get", { draftId: d.draftId })).data.revision, d.revision);
    assert(!fs.existsSync(path.join(f.directory, "models.json")));
  } finally {
    await f.dispose();
  }
});
test("request IDs deduplicate writes and sync failure reports committed effects", async () => {
  const f = fixture();
  try {
    const r = await f.run("provider.create", values(), "user_client", "request1");
    const repeated = await f.run("provider.create", values(), "user_client", "request1");
    assert.equal(r.operationId, repeated.operationId);
    assert.throws(
      () => f.registry.invoke("provider-manager/provider.create", values("other"), "user_client", "request1"),
      /requestId/,
    );
    f.failSync();
    const failed = await f.run("provider.update", {
      providerId: "fixture",
      expectedRevision: r.data.revision,
      set: { name: "Committed" },
    });
    assert.equal(failed.error?.code, "RUNTIME_SYNC_FAILED");
    assert.equal(failed.effects.config, "committed");
    assert.equal(failed.effects.runtime, "failed");
    assert(!JSON.stringify(failed).includes("internal secret"));
  } finally {
    await f.dispose();
  }
});
test("OAuth returns typed user actions, handles callback cancellation and stores no secrets in results", async () => {
  const f = fixture({
    authFactory: (directory: string) =>
      new Authentication(
        directory,
        () =>
          [
            {
              id: "openai-codex",
              name: "Fake",
              getModels: () => [],
              stream: () => undefined,
              streamSimple: () => undefined,
              auth: {
                oauth: {
                  name: "Fake",
                  login: async (interaction: any) => {
                    const method = await interaction.prompt({
                      type: "select",
                      message: "Method",
                      options: [{ id: "device", label: "Device" }],
                    });
                    assert.equal(method, "device");
                    interaction.notify({
                      type: "device_code",
                      verificationUri: "https://fixture.test",
                      userCode: "FAKE-CODE",
                    });
                    const value = await interaction.prompt({ type: "manual_code", message: "Code" });
                    assert.equal(value, "fixture-code");
                    return {
                      type: "oauth",
                      access: "SENTINEL_ACCESS",
                      refresh: "SENTINEL_REFRESH",
                      expires: Date.now() + 3600000,
                    };
                  },
                  refresh: async (c: any) => c,
                  toAuth: async (c: any) => ({ apiKey: c.access }),
                },
              },
            },
          ] as any,
      ),
  });
  try {
    const p = (
      await f.run("provider.create", {
        ...values(),
        api: "openai-codex-responses",
        auth: { mode: "oauth", methodId: "openai-codex" },
      })
    ).data;
    const task = f.registry.invoke("provider-manager/auth.begin", { providerId: p.id, expectedRevision: p.revision });
    for (const value of ["device", "fixture-code"]) {
      let event: any;
      for (let i = 0; i < 100; i++) {
        event = f.events.find(
          (e) =>
            e.operationId === task.snapshot.operationId &&
            e.requiresResponse &&
            !f.events.some((x) => x.type === "extension_interaction_end" && x.interactionId === e.interactionId),
        );
        if (event) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      assert(event);
      f.registry.respond(task.snapshot.operationId, event.interactionId, event.revision, value);
    }
    assert.equal((await task.done).status, "succeeded");
    assert(!JSON.stringify(f.events).includes("SENTINEL"));
    const stored = f.service.store.read().config.providers.fixture;
    assert.equal((await f.service.auth.resolve("fixture", stored)).auth.apiKey, "SENTINEL_ACCESS");
  } finally {
    await f.dispose();
  }
});

test("concurrent updates cannot overwrite another writer", async () => {
  const f = fixture();
  try {
    const p = (await f.run("provider.create", values())).data;
    const args = { providerId: p.id, expectedRevision: p.revision };
    const results = await Promise.all([
      f.run("provider.update", { ...args, set: { name: "A" } }),
      f.run("provider.update", { ...args, set: { name: "B" } }),
    ]);
    assert.equal(results.filter((r) => r.status === "succeeded").length, 1);
    assert.equal(results.filter((r) => r.error?.code === "CONFLICT").length, 1);
    assert.equal(
      (await f.run("provider.get", { providerId: p.id })).data.name,
      results.find((r) => r.status === "succeeded")!.data.name,
    );
  } finally {
    await f.dispose();
  }
});

test("clearing legacy credentials removes the fallback; model URL edits detach authorization", async () => {
  const f = fixture();
  try {
    let p = (await f.run("provider.create", { ...values(), auth: { mode: "api_key" } })).data;
    await f.run("auth.configure", { providerId: p.id, expectedRevision: p.revision, value: "SENTINEL_KEY" });
    let d = (await f.run("draft.open", { providerId: p.id })).data;
    d = (
      await f.run("draft.upsertModel", {
        draftId: d.draftId,
        revision: d.revision,
        model: { id: "m1", baseUrl: "https://new.test" },
      })
    ).data;
    p = (await f.run("draft.commit", { draftId: d.draftId, revision: d.revision })).data;
    assert.equal(p.auth.status, "missing");
    const file = path.join(f.directory, "models.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.providers.fixture.apiKey = "SENTINEL_OLD_KEY";
    fs.writeFileSync(file, JSON.stringify(raw));
    p = (await f.run("provider.get", { providerId: p.id })).data;
    assert.equal(p.auth.status, "configured");
    const cleared = await f.run("auth.clear", { providerId: p.id, expectedRevision: p.revision });
    assert.equal(cleared.status, "succeeded");
    assert.equal(cleared.data.status, "missing");
    assert.equal(cleared.effects.config, "committed");
    assert(!JSON.stringify(f.events).includes("SENTINEL"));
  } finally {
    await f.dispose();
  }
});

test("Pi model presets satisfy the public model contract", async () => {
  const f = fixture();
  try {
    const catalog = (await f.run("catalog.list", {})).data;
    for (const api of catalog.apis) {
      let cursor: string | undefined;
      do {
        const result = await f.run("catalog.presets", {
          api: api.id,
          modelId: "gpt",
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        assert.equal(result.status, "succeeded", `${api.id}: ${JSON.stringify(result.error)}`);
        cursor = result.data.nextCursor;
      } while (cursor);
    }
  } finally {
    await f.dispose();
  }
});

test("discovery cannot overwrite an edited draft and model callers cannot access user drafts", async () => {
  let release!: (response: Response) => void, started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const f = fixture({
    discovery: {
      fetch: async () => {
        started();
        return new Promise<Response>((r) => (release = r));
      },
    },
  });
  try {
    const draft = (await f.run("draft.create", values())).data;
    const rejected = await f.run("model.discover", { draftId: draft.draftId, revision: draft.revision }, "model_tool");
    assert.equal(rejected.status, "requires_user_action");
    const pending = f.run("model.discover", { draftId: draft.draftId, revision: draft.revision });
    await ready;
    const changed = (
      await f.run("draft.patch", { draftId: draft.draftId, revision: draft.revision, set: { name: "Changed" } })
    ).data;
    release(
      new Response(JSON.stringify({ data: [{ id: "late" }] }), { headers: { "content-type": "application/json" } }),
    );
    assert.equal((await pending).error?.code, "STALE_REVISION");
    const current = (await f.run("draft.get", { draftId: draft.draftId })).data;
    assert.equal(current.revision, changed.revision);
    assert(!current.candidates.some((c: any) => c.model.id === "late"));
  } finally {
    await f.dispose();
  }
});

test("reselecting a draft candidate cannot restore headers detached by an endpoint change", async () => {
  const f = fixture();
  try {
    let p = (await f.run("provider.create", values())).data;
    await f.run("headers.set", {
      providerId: p.id,
      expectedRevision: p.revision,
      modelId: "m1",
      name: "X-Secret",
      value: "SENTINEL_HEADER",
    });
    let d = (await f.run("draft.open", { providerId: p.id })).data;
    d = (await f.run("draft.selectModels", { draftId: d.draftId, revision: d.revision, modelIds: [] })).data;
    d = (await f.run("draft.patch", { draftId: d.draftId, revision: d.revision, set: { baseUrl: "https://new.test" } }))
      .data;
    assert.deepEqual(d.candidates, []);
    assert.equal(
      (await f.run("draft.selectModels", { draftId: d.draftId, revision: d.revision, modelIds: ["m1"] })).error?.code,
      "VALIDATION_ERROR",
    );
    d = (await f.run("draft.upsertModel", { draftId: d.draftId, revision: d.revision, model: { id: "m1" } })).data;
    const result = await f.run("draft.commit", { draftId: d.draftId, revision: d.revision });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.data.modelHeaders, []);
    assert(!fs.readFileSync(path.join(f.directory, "models.json"), "utf8").includes("SENTINEL"));
  } finally {
    await f.dispose();
  }
});

test("unset removes provider fields through both direct and draft updates", async () => {
  const f = fixture();
  try {
    let p = (await f.run("provider.create", { ...values(), compat: { supportsStore: false } })).data;
    p = (
      await f.run("provider.update", {
        providerId: p.id,
        expectedRevision: p.revision,
        set: {},
        unset: ["name", "compat"],
      })
    ).data;
    assert.equal(p.name, undefined);
    assert.equal(p.compat, undefined);
    p = (
      await f.run("provider.update", {
        providerId: p.id,
        expectedRevision: p.revision,
        set: { name: "Again", compat: { supportsStore: true } },
      })
    ).data;
    let d = (await f.run("draft.open", { providerId: p.id })).data;
    d = (await f.run("draft.patch", { draftId: d.draftId, revision: d.revision, set: {}, unset: ["name", "compat"] }))
      .data;
    assert.equal(d.values.name, undefined);
    assert.equal(d.values.compat, undefined);
    const saved = await f.run("draft.commit", { draftId: d.draftId, revision: d.revision });
    assert.equal(saved.status, "succeeded");
    assert.equal(saved.data.name, undefined);
  } finally {
    await f.dispose();
  }
});

test("saving cannot consume a draft changed while persistence is waiting", async () => {
  const f = fixture();
  try {
    const d = (await f.run("draft.create", values())).data;
    let started!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => (started = r)),
      gate = new Promise<void>((r) => (release = r));
    const commit = f.service.store.commit.bind(f.service.store);
    f.service.store.commit = async (...args) => {
      started();
      await gate;
      return commit(...args);
    };
    const saving = f.run("draft.commit", { draftId: d.draftId, revision: d.revision });
    await ready;
    const changed = (await f.run("draft.patch", { draftId: d.draftId, revision: d.revision, set: { id: "later-id" } }))
      .data;
    release();
    const result = await saving;
    assert.equal(result.error?.code, "STALE_REVISION");
    assert.equal(result.effects.config, "unchanged");
    assert.equal((await f.run("draft.get", { draftId: d.draftId })).data.revision, changed.revision);
    assert(!fs.existsSync(path.join(f.directory, "models.json")));
  } finally {
    await f.dispose();
  }
});

test("invalid discovery output cannot poison a draft or advance its revision", async () => {
  const f = fixture({
    discovery: { fetch: async () => new Response(JSON.stringify({ data: [{ id: "x".repeat(300) }] })) },
  });
  try {
    const d = (await f.run("draft.create", values())).data;
    assert.equal((await f.run("model.discover", { draftId: d.draftId, revision: d.revision })).status, "failed");
    const current = await f.run("draft.get", { draftId: d.draftId });
    assert.equal(current.status, "succeeded");
    assert.equal(current.data.revision, d.revision);
    assert.deepEqual(current.data.candidates, d.candidates);
  } finally {
    await f.dispose();
  }
});

test("all model edits update candidates consistently and direct writes do not consume draft capacity", async () => {
  const f = fixture();
  try {
    let d = (await f.run("draft.create", values())).data;
    d = (
      await f.run("draft.patch", { draftId: d.draftId, revision: d.revision, set: { models: [{ id: "new-model" }] } })
    ).data;
    d = (await f.run("draft.selectModels", { draftId: d.draftId, revision: d.revision, modelIds: [] })).data;
    const selected = await f.run("draft.selectModels", {
      draftId: d.draftId,
      revision: d.revision,
      modelIds: ["new-model"],
    });
    assert.equal(selected.status, "succeeded");
    for (let n = 1; n < 100; n++) assert.equal((await f.run("draft.create", values(`draft-${n}`))).status, "succeeded");
    assert.equal((await f.run("provider.create", values("direct"))).status, "succeeded");
  } finally {
    await f.dispose();
  }
});

test("expired draft slots are reclaimed before creation", async () => {
  let now = 1000;
  const f = fixture({ now: () => now });
  try {
    for (let n = 0; n < 100; n++) await f.run("draft.create", values(`d-${n}`));
    now += 31 * 60_000;
    assert.equal((await f.run("draft.create", values("after-expiry"))).status, "succeeded");
  } finally {
    await f.dispose();
  }
});

test("OAuth completing after a configuration change cannot persist stale credentials", async () => {
  let entered!: () => void, finish!: (value: any) => void;
  const ready = new Promise<void>((r) => (entered = r));
  const f = fixture({
    authFactory: (directory: string) =>
      new Authentication(
        directory,
        () =>
          [
            {
              id: "openai-codex",
              auth: {
                oauth: {
                  login: async () => {
                    entered();
                    return new Promise((r) => (finish = r));
                  },
                  refresh: async (c: any) => c,
                  toAuth: async (c: any) => ({ apiKey: c.access }),
                },
              },
            },
          ] as any,
      ),
  });
  try {
    const p = (
      await f.run("provider.create", {
        ...values(),
        api: "openai-codex-responses",
        auth: { mode: "oauth", methodId: "openai-codex" },
      })
    ).data;
    const pending = f.run("auth.begin", { providerId: p.id, expectedRevision: p.revision });
    await ready;
    await f.run("provider.update", {
      providerId: p.id,
      expectedRevision: p.revision,
      set: { baseUrl: "https://changed.test" },
    });
    finish({ type: "oauth", access: "STALE_SENTINEL", refresh: "refresh", expires: Date.now() + 3600000 });
    const result = await pending;
    assert.equal(result.error?.code, "CONFLICT");
    assert.equal(result.effects.credentials, "unchanged");
    assert(!fs.existsSync(path.join(f.directory, "auth.json")));
  } finally {
    await f.dispose();
  }
});

test("credential writes refuse empty or malformed auth storage", async () => {
  const f = fixture();
  try {
    const p = (await f.run("provider.create", { ...values(), auth: { mode: "api_key" } })).data;
    const file = path.join(f.directory, "auth.json");
    for (const raw of ["", "[]", "null", "BROKEN"]) {
      fs.writeFileSync(file, raw);
      const result = await f.run("auth.configure", {
        providerId: p.id,
        expectedRevision: p.revision,
        value: "SENTINEL",
      });
      assert.equal(result.status, "failed");
      assert.equal(result.effects.credentials, "unchanged");
      assert.equal(fs.readFileSync(file, "utf8"), raw);
    }
  } finally {
    await f.dispose();
  }
});

test("invalid known compat fields identify the provider and field without exposing values", async () => {
  const f = fixture();
  try {
    const bad = { ...values(), models: [{ id: "fixture", compat: { supportsStore: "PRIVATE_SENTINEL" } }] };
    fs.writeFileSync(path.join(f.directory, "models.json"), JSON.stringify({ providers: { broken: bad } }));
    const before = fs.readFileSync(f.service.store.file, "utf8");
    const result = await f.run("provider.get", { providerId: "broken" });
    assert.equal(result.error?.code, "VALIDATION_ERROR");
    assert.match(result.error!.message, /\/providers\/broken\/models\/0\/compat\/supportsStore/);
    assert(!JSON.stringify(result).includes("PRIVATE_SENTINEL"));
    assert.equal(fs.readFileSync(f.service.store.file, "utf8"), before);
  } finally {
    await f.dispose();
  }
});

test("discovery accepts runtime-advertised Baseten metadata without dropping the batch", async () => {
  const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
  const native = builtinProviders()
    .flatMap((provider) => provider.getModels())
    .filter((model) => (model.compat as any)?.thinkingFormat === "baseten");
  assert(native.length > 0, "The regression must exercise the runtime format missed by the old schema");
  const f = fixture({
    discovery: {
      fetch: async () =>
        new Response(JSON.stringify({ data: native.map((model) => ({ id: model.id })) }), { status: 200 }),
    },
  });
  try {
    await f.run("provider.create", values());
    const opened = await f.run("draft.open", { providerId: "fixture" });
    const d = opened.data;
    const result = await f.run("model.discover", { draftId: d.draftId, revision: d.revision });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    assert(result.data.candidates.some((candidate: any) => candidate.model.compat?.thinkingFormat === "baseten"));
    assert.deepEqual(result.data.selectedModelIds, ["m1"]);
  } finally {
    await f.dispose();
  }
});
