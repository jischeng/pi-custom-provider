import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { rpc, repo } from "./rpc-helper";

test("real Pi agent dispatches management tools, reports errors and confirms writes", async () => {
  const names = ["provider_list", "provider_get", "provider_create"];
  const p = await rpc(["-e", path.join(repo, "tests/fixtures/tool-model.ts"), "--tools", names.join(",")]);
  try {
    assert.equal((await p.command("set_model", { provider: "fixture-agent", modelId: "fixture" })).success, true);
    async function call(name: string, args: any, confirm?: boolean) {
      const start = p.events.length;
      assert.equal((await p.command("prompt", { message: JSON.stringify({ name, arguments: args }) })).success, true);
      if (confirm !== undefined) {
        const ui = await p.wait(
          (e) => p.events.indexOf(e) >= start && e.type === "extension_ui_request" && e.method === "confirm",
        );
        p.send({ type: "extension_ui_response", id: ui.id, confirmed: confirm });
      }
      const result = await p.wait((e) => p.events.indexOf(e) >= start && e.type === "tool_execution_end");
      await p.wait((e) => p.events.indexOf(e) >= start && e.type === "agent_end");
      return result;
    }
    const list = await call(names[0], {});
    assert.equal(list.isError, false);
    assert.equal(list.result.details.status, "succeeded");
    const missing = await call(names[1], { providerId: "missing" });
    assert.equal(missing.isError, true);
    assert.equal(missing.result.details.error.code, "NOT_FOUND");
    const cfg = {
      id: "tool-created",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:18080/v1",
      auth: { mode: "none" },
      models: [],
    };
    const denied = await call(names[2], cfg, false);
    assert.equal(denied.result.details.status, "cancelled");
    assert(!fs.existsSync(path.join(p.root, "agent/models.json")));
    const created = await call(names[2], cfg, true);
    assert.equal(created.result.details.status, "succeeded", JSON.stringify(created));
    assert(JSON.parse(fs.readFileSync(path.join(p.root, "agent/models.json"), "utf8")).providers["tool-created"]);
    assert.equal(p.stderr, "");
  } finally {
    await p.close();
  }
});
