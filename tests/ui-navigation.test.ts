import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, SettingsList, stripTerminalSequences, visibleWidth, getKeybindings } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ProviderService } from "../src/domain/service";
import { OperationRegistry } from "../src/operations/registry";
import { runSetup } from "../src/ui";
import { dialogContext } from "../src/ui/dialogs";

initTheme("dark");
test("native dialogs keep the provider open, restore focus, and add complete models without partial writes", async () => {
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
  const stack: any[] = [];
  const tui: any = { terminal: { rows: 40, columns: 90 }, requestRender() {} };
  const theme = {
    bg: (_role: string, text: string) => text,
    fg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  };
  const keys = getKeybindings();
  const ctx = dialogContext({
    ui: {
      notify(message: string) {
        assert.equal(message, "Configuration saved.");
      },
      custom(factory: any, options: any) {
        assert.equal(options.overlay, true);
        return new Promise((resolve, reject) => {
          try {
            const component = factory(tui, theme, keys, (value: any) => {
              stack.splice(stack.indexOf(component), 1);
              component.dispose?.();
              resolve(value);
            });
            stack.push(component);
          } catch (error) {
            reject(error);
          }
        });
      },
    },
  } as any);
  const page = (component = stack.at(-1)) => stripTerminalSequences(component.render(80).join("\n"));
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 300; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`Dialog did not reach expected state: ${stack.length}\n${stack.length ? page() : "closed"}`);
  };
  const press = async (...input: string[]) => {
    for (const key of input) stack.at(-1).handleInput(key);
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const choose = async (query: string) => press("\x15", ...query.replaceAll(" ", ""), "\r");
  const edit = async (label: string, value: string) => {
    await choose(label);
    assert.match(page(), /external\s+editor/);
    await press("\x01", "\x0b", ...value, "\r");
  };
  const controller = new AbortController();
  let task: Promise<void> | undefined;
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
    task = runSetup(
      { describe: (name) => definitions.find((item) => item.name === name)!, invoke },
      ctx,
      controller.signal,
    );
    await until(() => stack.length === 1);
    await choose("360");
    await until(() => stack.length === 1 && page().includes("Actions"));
    const parent = stack[0];
    assert(parent instanceof Container);
    assert.equal(parent.children.filter((child: any) => child instanceof SettingsList).length, 2);
    assert.match(page(), /m-one \(Same display name\)/);
    assert.match(page(), /m-two \(Same display name\)/);
    assert.match(page(), /Save changes/);
    assert.match(page(), /Delete provider/);
    assert.doesNotMatch(page(), /Provider actions|1000000|candidates|configured/);
    assert(parent.render(80).every((line: string) => visibleWidth(line) <= 80));
    assert(parent.render(80).length <= tui.terminal.rows - 2);

    await choose("m-two");
    await until(() => stack.length === 2);
    assert.equal(stack[0], parent);
    assert.match(page(), /Model: m-two/);
    await press("\x1b");
    await until(() => stack.length === 1);
    assert.equal(stack[0], parent);
    assert.match(page(), /> m-two/); // Native search and selection survive closing the child.

    await press("\t", "\r");
    await until(() => stack.length === 2);
    for (const label of ["Add model", "Model ID", "Model name", "Context window", "Maximum output tokens"])
      assert(page().includes(label));
    await edit("Model ID", "cancelled-model");
    await choose("Cancel");
    await until(() => stack.length === 1);
    assert.doesNotMatch(page(parent), /cancelled-model/);

    await press("\r");
    await until(() => stack.length === 2);
    await choose("Add model");
    await until(() => stack.length === 2 && page().includes("validation"));
    assert.match(page(), /\/model\/id/);
    await press("\r");
    await until(() => stack.length === 2 && page().includes("Model name"));
    await edit("Model ID", "new-model");
    await edit("Model name", "Full model");
    await edit("Context window", "64000");
    await edit("Maximum output tokens", "4096");
    await choose("Add model");
    await until(() => stack.length === 1 && page().includes("new-model"));
    assert.equal((await invoke("provider.get", { providerId: "360" })).data.models.length, 2);

    // Adding a duplicate must not upsert over the existing model.
    await press("\r");
    await until(() => stack.length === 2);
    await edit("Model ID", "new-model");
    await choose("Add model");
    await until(() => page().includes("already exists"));
    await press("\r");
    await until(() => page().includes("Model name"));
    await choose("Cancel");
    await until(() => stack.length === 1);

    await press(...Array(6).fill("\x1b[B"), "\r");
    await until(() => stack.length === 2 && page().includes("Save configuration"));
    await press("\r");
    await until(() => stack.length === 1 && page().includes("Create provider"));
    const models = (await invoke("provider.get", { providerId: "360" })).data.models;
    assert.deepEqual(
      models.find((model: any) => model.id === "new-model"),
      { id: "new-model", name: "Full model", contextWindow: 64000, maxTokens: 4096 },
    );
    assert(!models.some((model: any) => model.id === "cancelled-model"));
    await press("\x1b");
    await task;
  } finally {
    controller.abort();
    await task;
    await registry.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
