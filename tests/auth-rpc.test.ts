import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { rpc, repo } from "./rpc-helper";

test("headless authentication uses Pi's extension UI protocol and never exposes secrets", async () => {
  const p = await rpc(["-e", path.join(repo, "tests/fixtures/auth-operations.ts")], undefined, "auth-fixture");
  try {
    const provider = await p.invoke("provider.create", {
      id: "auth-test",
      api: "openai-codex-responses",
      baseUrl: "https://fixture.invalid",
      auth: { mode: "oauth", methodId: "openai-codex" },
      models: [],
    });
    assert.equal(provider.status, "succeeded", JSON.stringify(provider.error));
    const { result, prompts } = await p.invokeWithAnswers(
      "auth.begin",
      { providerId: "auth-test", expectedRevision: provider.data.revision },
      ["device", "fixture-code"],
    );
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    assert.equal(prompts, 2);
    const requests = p.events.filter((e) => e.type === "extension_ui_request");
    const select = requests.find((e) => e.method === "select");
    assert.deepEqual(select.options, ["Device method (device)"]);
    const input = requests.find((e) => e.method === "input");
    assert.match(input.title, /input is visible/);
    assert(requests.some((e) => e.method === "notify" && /fixture\.invalid/.test(e.message)));
    assert(fs.readFileSync(path.join(p.root, "agent/auth.json"), "utf8").includes("SENTINEL_ACCESS"));
    assert(!JSON.stringify(p.events).includes("SENTINEL_ACCESS"));
    assert.equal(p.stderr, "");
  } finally {
    await p.close();
  }
});

test("a cancelled prompt fails the operation without writing credentials", async () => {
  const p = await rpc(["-e", path.join(repo, "tests/fixtures/auth-operations.ts")], undefined, "auth-fixture");
  try {
    const provider = await p.invoke("provider.create", {
      id: "auth-cancel",
      api: "openai-codex-responses",
      baseUrl: "https://fixture.invalid",
      auth: { mode: "oauth", methodId: "openai-codex" },
      models: [],
    });
    const { result } = await p.invokeWithAnswers(
      "auth.begin",
      { providerId: "auth-cancel", expectedRevision: provider.data.revision },
      [undefined],
    );
    assert.equal(result.status, "cancelled");
    const authFile = path.join(p.root, "agent/auth.json");
    assert(!fs.existsSync(authFile) || !fs.readFileSync(authFile, "utf8").includes("SENTINEL_ACCESS"));
  } finally {
    await p.close();
  }
});
