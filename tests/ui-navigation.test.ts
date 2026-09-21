import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, SettingsList, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ProviderService } from "../src/domain/service";
import { OperationRegistry } from "../src/operations/registry";
import { runSetup } from "../src/ui";

initTheme("dark");
test("provider navigation identifies same-name models and separates management from models", async () => {
  const directory = mkdtempSync(join(tmpdir(), "provider-ui-"));
  const service = new ProviderService({
    directory,
    runtime: { sync: async () => {}, active: () => undefined, busy: () => false },
    discovery: { catalogUrl: null },
  });
  const registry = new OperationRegistry(() => {});
  const definitions = service.definitions();
  registry.register("provider-manager", definitions);
  const invoke = (name: string, args: unknown, signal?: AbortSignal) =>
    registry.invoke(`provider-manager/${name}`, args, "user_client", undefined, signal).done;
  const steps = [
    (page: string) => {
      assert.match(page, /Providers/);
      return "360\r";
    },
    (page: string) => {
      assert.match(page, /Provider: 360 *\n\n Models/);
      assert.match(page, /m-one \(Same display name\)/);
      assert.match(page, /m-two \(Same display name\)/);
      assert.doesNotMatch(
        page,
        /1000000|candidates|selected|configured|Save changes|Delete provider|Provider settings/,
      );
      return "m-two\r";
    },
    (page: string) => {
      assert.match(page, /Provider: 360 *\n\n Model: m-two/);
      return "\x1b";
    },
    (page: string) => {
      assert.match(page, /m-one/);
      return "Provider actions\r";
    },
    (page: string) => {
      assert.match(page, /Provider: 360 *\n\n Provider actions/);
      assert.match(page, /Save changes/);
      assert.doesNotMatch(page, /m-one|m-two|1000000|configured|candidates/);
      return "\x1b";
    },
    (page: string) => {
      assert.match(page, /Provider: 360 *\n\n Models/);
      return "\x1b";
    },
    (page: string) => {
      assert.match(page, /Providers/);
      return "\x1b";
    },
  ];
  let screen = 0;
  try {
    assert.equal(
      (
        await invoke("provider.create", {
          id: "360",
          api: "openai-completions",
          baseUrl: "http://localhost:18080/v1",
          auth: { mode: "none" },
          models: ["m-one", "m-two"].map((id) => ({ id, name: "Same display name", contextWindow: 1000000 })),
        })
      ).status,
      "succeeded",
    );
    const ctx: any = {
      ui: {
        notify(message: string) {
          assert.fail(message);
        },
        custom(factory: any) {
          return new Promise<void>((done, reject) => {
            try {
              const panel = factory(
                { requestRender() {} },
                { fg: (_role: string, text: string) => text, bold: (text: string) => text },
                {},
                done,
              );
              assert(panel instanceof Container);
              assert(panel.children[0] instanceof Text);
              assert(panel.children.at(-1) instanceof SettingsList);
              const lines = panel.render(72);
              assert(lines.every((line: string) => visibleWidth(line) <= 72));
              const keys = steps[screen++](stripTerminalSequences(lines.join("\n")));
              // All input, including search and cancellation, runs through the native child.
              for (const key of keys) (panel as any).handleInput(key);
            } catch (error) {
              reject(error);
            }
          });
        },
      },
    };
    await runSetup({ describe: (name) => definitions.find((item) => item.name === name)!, invoke }, ctx);
    assert.equal(screen, steps.length);
    assert.equal((await invoke("provider.get", { providerId: "360" })).data.models.length, 2);
  } finally {
    await registry.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
