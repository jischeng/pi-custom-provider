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
  const p = await rpc(true, ["-e", path.join(repo, "tests/fixtures/unrelated.ts")]);
  try {
    const description = await p.command("get_extension_operations");
    assert.equal(description.success, true, JSON.stringify(description));
    const names = description.data.operations.map((d: any) => d.name);
    assert(names.includes("provider-manager/provider.create"));
    assert(names.includes("notes/length"));
    assert.deepEqual((await p.invoke("notes/length", { text: "中文" })).data, { length: 2 });
    const cfg = {
      id: "rpc-fixture",
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      auth: { mode: "none" },
      models: [],
    };
    let result = await p.invoke("provider-manager/provider.create", cfg);
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    const discovered = await p.invoke("provider-manager/model.discover", { providerId: cfg.id });
    assert.equal(discovered.status, "succeeded", JSON.stringify(discovered));
    assert(discovered.data.items.some((c: any) => c.model.id === "fixture-native-model-a"));
    assert.equal(requests[0].authorization, undefined);
    result = await p.invoke("provider-manager/provider.selectModels", {
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
    const renamed = await p.invoke("provider-manager/provider.update", {
      providerId: cfg.id,
      expectedRevision: result.data.revision,
      set: { id: "rpc-renamed", name: "Rename" },
    });
    assert.equal(renamed.status, "succeeded", JSON.stringify(renamed));
    assert.equal(
      (await p.command("set_model", { provider: "rpc-renamed", modelId: "fixture-native-model-a" })).success,
      true,
    );
    const deletion = await p.invoke("provider-manager/provider.delete", {
      providerId: "rpc-renamed",
      expectedRevision: renamed.data.revision,
    });
    assert.equal(deletion.error.code, "ACTIVE_MODEL_IN_USE");
    const other = await p.invoke("provider-manager/provider.create", {
      ...cfg,
      id: "rpc-other",
      models: [{ id: "other" }],
    });
    assert.equal(other.status, "succeeded");
    assert.equal((await p.command("set_model", { provider: "rpc-other", modelId: "other" })).success, true);
    assert.equal(
      (
        await p.invoke("provider-manager/provider.delete", {
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

test("real Pi RPC: task query, cancellation, validation and request id conflict", async () => {
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  let disconnected = false;
  const server = http.createServer((req, _res) => {
    started();
    req.on("close", () => {
      disconnected = true;
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const p = await rpc();
  try {
    const port = (server.address() as any).port;
    await p.invoke("provider-manager/provider.create", {
      id: "slow",
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${port}`,
      auth: { mode: "none" },
      models: [],
    });
    const start = await p.command("invoke_extension_operation", {
      operation: "provider-manager/model.discover",
      arguments: { providerId: "slow" },
      requestId: "slow1",
    });
    await ready;
    const operationId = start.data.operationId;
    assert.equal((await p.command("get_extension_operation", { operationId })).data.state, "running");
    await p.command("cancel_extension_operation", { operationId });
    const result = await p.wait((e) => e.type === "extension_operation_result" && e.operationId === operationId);
    assert.equal(result.result.status, "cancelled");
    assert.equal((await p.command("get_extension_operation", { operationId })).data.result.status, "cancelled");
    const repeated = await p.command("invoke_extension_operation", {
      operation: "provider-manager/model.discover",
      arguments: { providerId: "slow" },
      requestId: "slow1",
    });
    assert.equal(repeated.data.operationId, operationId);
    const conflict = await p.command("invoke_extension_operation", {
      operation: "provider-manager/model.discover",
      arguments: { providerId: "different" },
      requestId: "slow1",
    });
    assert.equal(conflict.errorDetails.code, "CONFLICT");
    const invalid = await p.invoke("provider-manager/provider.create", { id: "bad", apiKey: "SENTINEL" });
    assert.equal(invalid.error.code, "VALIDATION_ERROR");
    assert(!JSON.stringify(p.events).includes("SENTINEL"));
    for (let i = 0; i < 20 && !disconnected; i++) await new Promise((r) => setTimeout(r, 5));
    assert(disconnected);
  } finally {
    await p.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("unmodified Pi RPC does not pretend to implement operation registration", async () => {
  const p = await rpc(false);
  try {
    const commands = await p.command("get_commands");
    assert(commands.data.commands.some((c: any) => c.name === "provider-setup"));
    const missing = await p.command("get_extension_operations");
    assert.equal(missing.success, false);
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
    let created = await p.invoke("provider-manager/provider.create", {
      id: "secrets",
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      auth: { mode: "api_key" },
      models: [{ id: "secret-model" }],
    });
    assert.equal(
      (
        await p.invoke("provider-manager/auth.configure", {
          providerId: "secrets",
          expectedRevision: created.data.revision,
          value: "SENTINEL_API_KEY",
        })
      ).status,
      "succeeded",
    );
    assert.equal(
      (
        await p.invoke("provider-manager/headers.set", {
          providerId: "secrets",
          expectedRevision: created.data.revision,
          name: "X-Secret",
          value: "SENTINEL_HEADER",
        })
      ).status,
      "succeeded",
    );
    assert.equal((await p.invoke("provider-manager/model.discover", { providerId: "secrets" })).status, "succeeded");
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
