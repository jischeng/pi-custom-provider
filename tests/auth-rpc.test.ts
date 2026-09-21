import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { rpc, repo } from "./rpc-helper";
test("real Pi generic RPC carries typed authentication actions and cancels pending input", async () => {
  const p = await rpc(true, ["-e", path.join(repo, "tests/fixtures/auth-operations.ts")]);
  try {
    const provider = await p.invoke("auth-fixture/provider.create", {
      id: "auth-test",
      api: "openai-codex-responses",
      baseUrl: "https://fixture.invalid",
      auth: { mode: "oauth", methodId: "openai-codex" },
      models: [],
    });
    assert.equal(provider.status, "succeeded");
    const args = { providerId: "auth-test", expectedRevision: provider.data.revision };
    const begin = await p.command("invoke_extension_operation", {
      operation: "auth-fixture/auth.begin",
      arguments: args,
      requestId: "auth-start",
    });
    const operationId = begin.data.operationId;
    const select = await p.wait(
      (e) => e.operationId === operationId && e.type === "extension_interaction_request" && e.options,
    );
    const invalid = await p.command("respond_extension_interaction", {
      operationId,
      interactionId: select.interactionId,
      revision: select.revision,
      response: { value: "Device method" },
    });
    assert.equal(invalid.success, false);
    assert.equal(
      (
        await p.command("respond_extension_interaction", {
          operationId,
          interactionId: select.interactionId,
          revision: select.revision,
          response: { value: "device" },
        })
      ).success,
      true,
    );
    const manual = await p.wait(
      (e) => e.operationId === operationId && e.type === "extension_interaction_request" && e.kind === "manual_code",
    );
    assert.equal(manual.secret, true);
    await p.command("respond_extension_interaction", {
      operationId,
      interactionId: manual.interactionId,
      revision: manual.revision,
      response: { value: "fixture-code" },
    });
    assert.equal(
      (await p.wait((e) => e.operationId === operationId && e.type === "extension_operation_result")).result.status,
      "succeeded",
    );
    const saved = fs.readFileSync(path.join(p.root, "agent/auth.json"), "utf8");
    const again = await p.command("invoke_extension_operation", {
      operation: "auth-fixture/auth.begin",
      arguments: args,
      requestId: "auth-cancel",
    });
    const pending = await p.wait(
      (e) =>
        e.operationId === again.data.operationId && e.type === "extension_interaction_request" && e.requiresResponse,
    );
    await p.command("cancel_extension_operation", { operationId: again.data.operationId });
    assert.equal(
      (await p.wait((e) => e.operationId === again.data.operationId && e.type === "extension_operation_result")).result
        .status,
      "cancelled",
    );
    assert.equal(
      (
        await p.command("respond_extension_interaction", {
          operationId: again.data.operationId,
          interactionId: pending.interactionId,
          revision: pending.revision,
          response: { value: "device" },
        })
      ).success,
      false,
    );
    assert.equal(fs.readFileSync(path.join(p.root, "agent/auth.json"), "utf8"), saved);
    assert(!JSON.stringify(p.events).includes("SENTINEL"));
    assert(!p.events.some((e) => e.type === "extension_ui_request"));
    assert.equal(p.stderr, "");
  } finally {
    await p.close();
  }
});
