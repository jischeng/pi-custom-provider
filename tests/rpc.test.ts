import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { rpc, repo } from "./rpc-helper";

test("real Pi RPC: direct management, discovery, persistence, model registration and unrelated extension", async () => {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "fixture-native-model-a" }, { id: "fixture-native-model-b" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const p = await rpc(["-e", path.join(repo, "tests/fixtures/unrelated.ts")]);
  try {
    const operations = await p.catalog();
    assert(operations.some((d: any) => d.name === "provider.create"));
    assert(operations.every((d: any) => d.inputSchema?.type === "object"));
    const commands = await p.command("get_commands");
    assert(commands.data.commands.some((c: any) => c.name === "model-config"));
    assert(commands.data.commands.some((c: any) => c.name === "notes-length"));
    const cfg = {
      id: "rpc-fixture",
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      auth: { mode: "none" },
      models: [],
    };
    let result = await p.invoke("provider.create", cfg);
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    const discovered = await p.invoke("model.discover", { providerId: cfg.id });
    assert.equal(discovered.status, "succeeded", JSON.stringify(discovered));
    assert(discovered.data.items.some((c: any) => c.model.id === "fixture-native-model-a"));
    assert.equal(requests[0].authorization, undefined);
    result = await p.invoke("provider.selectModels", {
      providerId: cfg.id,
      expectedRevision: result.data.revision,
      models: [{ id: "fixture-native-model-a", contextWindow: 128000, maxTokens: 4096, input: ["text"] }],
    });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    const models = await p.command("get_available_models");
    assert(
      models.data.models.some((m: any) => m.provider === cfg.id && m.id === "fixture-native-model-a"),
      JSON.stringify(models),
    );
    const renamed = await p.invoke("provider.update", {
      providerId: cfg.id,
      expectedRevision: result.data.revision,
      set: { id: "rpc-renamed", name: "Rename" },
    });
    assert.equal(renamed.status, "succeeded", JSON.stringify(renamed));
    assert.equal(
      (await p.command("set_model", { provider: "rpc-renamed", modelId: "fixture-native-model-a" })).success,
      true,
    );
    const deletion = await p.invoke("provider.delete", {
      providerId: "rpc-renamed",
      expectedRevision: renamed.data.revision,
    });
    assert.equal(deletion.error.code, "ACTIVE_MODEL_IN_USE");
    const other = await p.invoke("provider.create", {
      ...cfg,
      id: "rpc-other",
      models: [{ id: "other" }],
    });
    assert.equal(other.status, "succeeded");
    assert.equal((await p.command("set_model", { provider: "rpc-other", modelId: "other" })).success, true);
    assert.equal(
      (
        await p.invoke("provider.delete", {
          providerId: "rpc-renamed",
          expectedRevision: other.data.revision,
        })
      ).status,
      "succeeded",
    );
    const disk = JSON.parse(fs.readFileSync(path.join(p.root, "agent/models.json"), "utf8"));
    assert(!disk.providers["rpc-renamed"]);
    assert(disk.providers["rpc-other"]);
    assert(
      !p.events.some(
        (e) => e.type === "extension_ui_request" && ["input", "select", "confirm", "editor"].includes(e.method),
      ),
      "management must not use UI requests",
    );
    assert(!p.events.some((e) => e.type === "agent_start"), "management must not invoke a model");
    assert.equal(p.stderr, "");
  } finally {
    await p.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a provider Pi ships appears once it is logged in, and adjusting a model changes what Pi serves", async () => {
  // Pi's own /login wrote this credential; the provider itself is not in models.json.
  const p = await rpc([], { providers: {} }, "model-config", {
    anthropic: { type: "api_key", key: "fixture-key" },
  });
  try {
    const listed = await p.invoke("provider.list", {});
    const provider = listed.data.items.find((item: any) => item.id === "anthropic");
    assert.equal(provider?.source, "builtin", JSON.stringify(listed.data.items.map((i: any) => i.id)));
    assert(provider.modelCount > 0, "Pi's own models are listed");

    const target = provider.models[0];
    const adjusted = await p.invoke("model.override", {
      providerId: "anthropic",
      modelId: target.id,
      expectedRevision: provider.revision,
      set: { contextWindow: 424242, maxTokens: 7777 },
    });
    assert.equal(adjusted.status, "succeeded", JSON.stringify(adjusted.error));

    // Pi's registry is the source of truth: the effective model must show the new values.
    const after = await p.invoke("provider.get", { providerId: "anthropic" });
    const effective = after.data.models.find((model: any) => model.id === target.id);
    assert.equal(effective.contextWindow, 424242);
    assert.equal(effective.maxTokens, 7777);
    assert.equal(after.data.models.length, provider.models.length, "no other model changed");

    // The record holds only the patch, so Pi keeps its own endpoint and model list.
    const record = JSON.parse(fs.readFileSync(path.join(p.root, "agent/models.json"), "utf8")).providers.anthropic;
    assert.deepEqual(Object.keys(record), ["modelOverrides"]);
    assert.equal(record.baseUrl, undefined);

    const reverted = await p.invoke("model.override", {
      providerId: "anthropic",
      modelId: target.id,
      expectedRevision: after.data.revision,
      unset: ["contextWindow", "maxTokens"],
    });
    assert.equal(reverted.status, "succeeded", JSON.stringify(reverted.error));
    const restored = await p.invoke("provider.get", { providerId: "anthropic" });
    assert.equal(restored.data.models.find((model: any) => model.id === target.id).contextWindow, target.contextWindow);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(p.root, "agent/models.json"), "utf8")).providers.anthropic,
      undefined,
    );
    assert.equal(p.stderr, "");
  } finally {
    await p.close();
  }
});

test("a credential for a provider Pi ships is written where Pi reads it", async () => {
  // Pi's own /login owns the OAuth flow; an API key for a built-in lands in the same slot.
  const p = await rpc([], { providers: {} }, "model-config", {
    anthropic: { type: "api_key", key: "old-key" },
  });
  try {
    const listed = await p.invoke("provider.list", {});
    const provider = listed.data.items.find((item: any) => item.id === "anthropic");
    assert.equal(provider.source, "builtin");
    assert.equal(provider.auth.status, "configured");

    const rotated = await p.invoke("auth.configure", {
      providerId: "anthropic",
      expectedRevision: provider.revision,
      value: "rotated-key",
    });
    assert.equal(rotated.status, "succeeded", JSON.stringify(rotated.error));

    // The credential stays in Pi's own store, keyed by the provider id, and no record is created.
    const auth = JSON.parse(fs.readFileSync(path.join(p.root, "agent/auth.json"), "utf8"));
    assert.equal(auth.anthropic.key, "rotated-key");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(p.root, "agent/models.json"), "utf8")).providers.anthropic,
      undefined,
    );
    const after = await p.invoke("provider.get", { providerId: "anthropic" });
    assert.equal(after.data.auth.status, "configured");

    const cleared = await p.invoke("auth.clear", {
      providerId: "anthropic",
      expectedRevision: after.data.revision,
    });
    assert.equal(cleared.status, "succeeded", JSON.stringify(cleared.error));
    assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, "agent/auth.json"), "utf8")).anthropic, undefined);
    // Without a credential the provider drops out of the list again.
    const final = await p.invoke("provider.list", {});
    assert(!final.data.items.some((item: any) => item.id === "anthropic"));
    assert.equal(p.stderr, "");
  } finally {
    await p.close();
  }
});

test("Pi RPC is the only transport: no custom command exists", async () => {
  const p = await rpc();
  try {
    const commands = await p.command("get_commands");
    assert(commands.data.commands.some((c: any) => c.name === "model-config"));
    const missing = await p.command("get_extension_operations");
    assert.equal(missing.success, false);
    const unknown = await p.command("invoke_extension_operation", { operation: "x", arguments: {}, requestId: "x" });
    assert.equal(unknown.success, false);
  } finally {
    await p.close();
  }
});

test("real Pi resolves newly saved credentials for HTTP without exposing keys or headers", async () => {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers);
    if (req.method === "POST") {
      req.resume();
      res.setHeader("content-type", "text/event-stream");
      for (const [delta, finish_reason] of [
        [{ role: "assistant", content: "OK" }, null],
        [{}, "stop"],
      ])
        res.write(
          `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 0, model: "secret-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      res.end("data: [DONE]\n\n");
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "secret-model" }] }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const p = await rpc();
  try {
    let created = await p.invoke("provider.create", {
      id: "secrets",
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      auth: { mode: "api_key" },
      models: [{ id: "secret-model" }],
    });
    assert.equal(
      (
        await p.invoke("auth.configure", {
          providerId: "secrets",
          expectedRevision: created.data.revision,
          value: "SENTINEL_API_KEY",
        })
      ).status,
      "succeeded",
    );
    assert.equal(
      (
        await p.invoke("headers.set", {
          providerId: "secrets",
          expectedRevision: created.data.revision,
          name: "X-Secret",
          value: "SENTINEL_HEADER",
        })
      ).status,
      "succeeded",
    );
    assert.equal((await p.invoke("model.discover", { providerId: "secrets" })).status, "succeeded");
    assert.equal(requests[0].authorization, "Bearer SENTINEL_API_KEY");
    assert.equal(requests[0]["x-secret"], "SENTINEL_HEADER");
    const models = await p.command("get_available_models");
    assert(models.data.models.some((m: any) => m.provider === "secrets"));
    assert.equal((await p.command("set_model", { provider: "secrets", modelId: "secret-model" })).success, true);
    await p.command("get_state");
    assert.equal((await p.command("prompt", { message: "Local fixture request" })).success, true);
    await p.wait((e) => e.type === "agent_end");
    assert(requests.length >= 2, "new credentials must work for inference without restarting Pi");
    assert.equal(requests.at(-1).authorization, "Bearer SENTINEL_API_KEY");
    assert.equal(requests.at(-1)["x-secret"], "SENTINEL_HEADER");
    assert(
      p.events.some(
        (e) => e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason === "stop",
      ),
    );
    assert(!JSON.stringify(p.events).includes("SENTINEL"), "native and management RPC must never serialize secrets");
  } finally {
    await p.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("existing Pi compat metadata survives startup and provider edits", async () => {
  const compat = { supportsAdditionalTools: true, supportsToolSearch: true, customCapability: { enabled: true } };
  const config = {
    providers: {
      existing: {
        api: "openai-responses",
        baseUrl: "https://fixture.invalid/v1",
        authMode: "none",
        compat,
        models: [{ id: "fixture", compat }],
      },
    },
  };
  const p = await rpc([], config);
  try {
    const result = await p.invoke("provider.get", { providerId: "existing" });
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.deepEqual(result.data.compat, compat);
    assert.deepEqual(result.data.models[0].compat, compat);
    const models = await p.command("get_available_models");
    const model = models.data.models.find((m: any) => m.provider === "existing" && m.id === "fixture");
    assert(model, JSON.stringify(models));
    assert.deepEqual(model.compat, compat);
    const updated = await p.invoke("provider.update", {
      providerId: "existing",
      expectedRevision: result.data.revision,
      set: { name: "Edited" },
    });
    assert.equal(updated.status, "succeeded", JSON.stringify(updated));
    const saved = JSON.parse(fs.readFileSync(path.join(p.root, "agent/models.json"), "utf8"));
    assert.deepEqual(saved.providers.existing.compat, compat);
    assert.deepEqual(saved.providers.existing.models[0].compat, compat);
    assert(
      !p.events.some((e) => e.type === "extension_ui_request" && e.method === "notify" && e.notifyType === "error"),
    );
  } finally {
    await p.close();
  }
});
