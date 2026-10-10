import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, SelectList, stripTerminalSequences, visibleWidth, getKeybindings } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ProviderService } from "../src/domain/service";
import { runOperation } from "../src/operations/runner";
import { runSetup } from "../src/extension/tui";
import { createTuiOperations } from "../src/extension/tui/operations";

initTheme("dark");
test("native TUI screens keep the provider open and add complete models without partial writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "provider-ui-"));
  let discoveries = 0;
  let discoveryFails = false;
  let pauseDiscovery = false;
  const service = new ProviderService({
    directory,
    runtime: { sync: async () => {}, active: () => undefined, busy: () => false },
    discovery: {
      catalogUrl: null,
      fetch: async (_url, options) => {
        if (pauseDiscovery)
          await new Promise((_, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), {
              once: true,
            });
          });
        discoveries++;
        if (discoveryFails) throw new Error("Fixture discovery unavailable");
        return new Response(JSON.stringify({ data: [{ id: "found-model" }] }), { status: 200 });
      },
    },
  });
  const definitions = service.definitions();
  const invoke = (name: string, args: unknown, signal?: AbortSignal) =>
    runOperation(definitions, name, args, {
      caller: "user_client",
      signal: signal ?? new AbortController().signal,
      prompt: async () => "",
      notify: () => {},
    });
  const stack: any[] = [];
  const notifications: string[] = [];
  const tui: any = { terminal: { rows: 40, columns: 90 }, requestRender() {} };
  const theme = {
    bg: (_role: string, text: string) => text,
    fg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  };
  const keys = getKeybindings();
  const ctx: any = {
    ui: {
      setStatus() {},
      select: async () => "Yes",
      input: async () => undefined,
      confirm: async () => true,
      notify(message: string) {
        notifications.push(message);
      },
      custom(factory: any, _options?: any) {
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
  };
  const page = (component = stack.at(-1)) => stripTerminalSequences(component.render(80).join("\n"));
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 300; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`TUI screen did not reach expected state: ${stack.length}\n${stack.length ? page() : "closed"}`);
  };
  const untilCommitted = async (predicate: (models: any[]) => boolean) => {
    for (let i = 0; i < 300; i++) {
      const models = (await invoke("provider.get", { providerId: "360" })).data?.models ?? [];
      if (predicate(models)) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("The change was not auto-saved");
  };
  const press = async (...input: string[]) => {
    for (const key of input) stack.at(-1).handleInput(key);
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const choose = async (query: string) => press("\x15", ...query.replaceAll(" ", ""), "\r");
  const edit = async (label: string, value: string) => {
    await choose(label);
    assert.match(page(), /Enter to submit/);
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
    task = runSetup(createTuiOperations(definitions, ctx), ctx, controller.signal);
    await until(() => stack.length === 1);
    await choose("360");
    await until(() => stack.length === 1 && page().includes("Models"));
    const parent = stack[0];
    assert(parent instanceof Container);
    // One list per section: Provider, Authentication, Actions and Models.
    assert.equal(parent.children.filter((child: any) => child instanceof SelectList).length, 4);
    assert.match(page(), /m-one \(Same display name\)/);
    assert.match(page(), /m-two \(Same display name\)/);
    assert.match(page(), /Delete provider/);
    // An action is not a setting: it must not render a value column.
    assert.match(page(), /^  Request headers\s*$/m);
    assert.match(page(), /^  Delete provider\s*$/m);
    assert.doesNotMatch(page(), /Provider actions|1000000|candidates|Discover models|Select models/);
    assert(parent.render(80).every((line: string) => visibleWidth(line) <= 80));
    assert(parent.render(80).length <= tui.terminal.rows - 2);

    await choose("m-two");
    await until(() => stack.length === 1);
    assert.match(page(), /Model: m-two/);
    await press("\x1b");
    await until(() => stack.length === 1);
    // The filter resets so the whole list is reachable again, and the cursor stays on the row.
    assert.match(page(), /→ m-two/);
    assert.match(page(), /^>\s*$/m);

    await choose("Add model");
    await until(() => stack.length === 1 && page().includes("Enter model manually"));
    assert.match(page(), /found-model/);
    await choose("Enter model manually");
    await until(() => stack.length === 1 && page().includes("Model name"));
    for (const label of ["Add model", "Model ID", "Model name", "Context window", "Maximum output tokens"])
      assert(page().includes(label));
    await edit("Model ID", "cancelled-model");
    await choose("Cancel");
    await until(() => stack.length === 1 && page().includes("Enter model manually"));
    await press("\x1b");
    await until(() => stack.length === 1);
    assert.doesNotMatch(page(), /cancelled-model/);

    await choose("Add model");
    await until(() => stack.length === 1 && page().includes("Enter model manually"));
    assert.match(page(), /found-model/);
    await choose("Enter model manually");
    await until(() => stack.length === 1 && page().includes("Model name"));
    await choose("Add model");
    await until(() => stack.length === 1 && page().includes("Model name"));
    await edit("Model ID", "new-model");
    await edit("Model name", "Full model");
    await edit("Context window", "64000");
    await edit("Maximum output tokens", "4096");
    await choose("Add model");
    await until(() => stack.length === 1 && page().includes("Enter model manually"));
    await choose("found-model");
    // A model opens its own menu: add it, then config or preset from the same screen.
    await until(() => stack.length === 1 && page().includes("Add to provider"));
    await choose("Add to provider");
    await until(() => stack.length === 1 && page().includes("Enter model manually"));
    await choose("found-model");
    await until(() => page().includes("Edit model config"));
    assert.match(page(), /Apply model preset/);
    await choose("Edit model config");
    await until(() => stack.length === 1 && page().includes("Model: found-model"));
    await press("\x1b");
    await until(() => stack.length === 1 && page().includes("Enter model manually"));
    await press("\x1b");
    await until(() => stack.length === 1);
    await press("\x15");
    assert.match(page(), /new-model/);
    assert.match(page(), /found-model/);
    await untilCommitted(
      (models) =>
        models.some((model: any) => model.id === "new-model") &&
        models.some((model: any) => model.id === "found-model"),
    );
    assert.equal((await invoke("provider.get", { providerId: "360" })).data.models.length, 4);

    // Adding a duplicate must not upsert over the existing model.
    await choose("Add model");
    await until(() => stack.length === 1 && page().includes("Enter model manually"));
    assert.match(page(), /found-model/);
    await choose("Enter model manually");
    await until(() => stack.length === 1 && page().includes("Model name"));
    await edit("Model ID", "new-model");
    await choose("Add model");
    await until(() => page().includes("Model name"));
    await choose("Cancel");
    await until(() => stack.length === 1 && page().includes("Enter model manually"));
    await press("\x1b");
    await until(() => stack.length === 1);

    assert(discoveries >= 3, "Add model must perform discovery on entry");
    assert.match(page(), /Add model/); // Returning from a child screen restores the provider page.
    discoveryFails = true;
    await choose("Add model");
    await until(() => page().includes("Enter model manually"));
    assert.match(page(), /found-model/); // A failed refresh retains the known candidates.
    await press("\x1b");
    await until(() => stack.length === 1);

    pauseDiscovery = true;
    discoveryFails = false;
    await press("\x15", "Addmodel", "\r");
    await press("\x1b");
    await until(() => stack.length === 1);
    assert.doesNotMatch(page(), /Enter model manually/);

    await untilCommitted((models) => models.some((model: any) => model.id === "new-model"));
    const models = (await invoke("provider.get", { providerId: "360" })).data.models;
    assert.deepEqual(
      models.find((model: any) => model.id === "new-model"),
      { id: "new-model", name: "Full model", contextWindow: 64000, maxTokens: 4096 },
    );
    assert(!models.some((model: any) => model.id === "cancelled-model"));
    assert(models.some((model: any) => model.id === "found-model"));
    await press("\x1b");
  } finally {
    controller.abort();
    await task;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the provider list tags the providers Pi ships and the ones with adjustments", async () => {
  const { providerPanel } = await import("../src/extension/tui/provider-panel");
  const { stripTerminalSequences } = await import("@earendil-works/pi-tui");
  // The label rule lives with the screen; this is the same mapping applied to a fixed list.
  const label = (provider: any) => {
    const tags = [
      provider.name && provider.name !== provider.id ? provider.name : undefined,
      provider.source === "builtin" ? "Pi built-in" : undefined,
      provider.overriddenModelIds?.length ? `${provider.overriddenModelIds.length} adjusted` : undefined,
    ].filter(Boolean);
    return tags.length ? `${provider.id} (${tags.join(", ")})` : provider.id;
  };
  assert.equal(label({ id: "360" }), "360");
  assert.equal(label({ id: "deepseek", name: "DeepSeek" }), "deepseek (DeepSeek)");
  assert.equal(
    label({ id: "openai-codex", name: "OpenAI Codex", source: "builtin" }),
    "openai-codex (OpenAI Codex, Pi built-in)",
  );
  assert.equal(
    label({ id: "anthropic", name: "Anthropic", source: "builtin", overriddenModelIds: ["a"] }),
    "anthropic (Anthropic, Pi built-in, 1 adjusted)",
  );
  let panel: any;
  const ctx: any = {
    ui: {
      custom(factory: any) {
        return new Promise<void>((done) => {
          panel = factory(
            { terminal: { rows: 30 }, requestRender() {} },
            { fg: (_r: string, t: string) => t, bold: (t: string) => t },
            {},
            done,
          );
        });
      },
    },
  };
  const abort = new AbortController();
  const task = providerPanel(
    ctx,
    () => ({
      title: "Providers",
      sections: [
        { heading: "Actions", items: [{ id: "$create", label: "Create provider" }] },
        {
          heading: "Providers",
          items: [
            { id: "360", label: label({ id: "360" }) },
            { id: "anthropic", label: label({ id: "anthropic", name: "Anthropic", source: "builtin" }) },
          ],
        },
      ],
    }),
    async () => false,
    abort.signal,
  );
  try {
    const page = panel.render(90).map(stripTerminalSequences).join("\n");
    assert.match(page, /anthropic \(Anthropic, Pi built-in\)/);
    assert.doesNotMatch(page, /360 \(/);
  } finally {
    abort.abort();
    await task;
  }
});

test("the credential actions follow what a provider supports and what Pi can record", async () => {
  const { credentialChoices } = await import("../src/extension/tui/screens/credentials");
  // A provider Pi ships cannot hold a credential file path: Pi rejects a record whose only field is it.
  assert.deepEqual(
    credentialChoices({ auth: ["api_key", "oauth"], hasCredential: false, allowFile: false }).map((c) => c.id),
    ["sign-in", "api-key", "import"],
  );
  assert.deepEqual(
    credentialChoices({ auth: ["api_key"], hasCredential: false, allowFile: false }).map((c) => c.id),
    ["api-key"],
  );
  // A configured provider keeps the file-backed OAuth path, and offers Clear once one exists.
  assert.deepEqual(
    credentialChoices({ auth: ["oauth"], hasCredential: true, allowFile: true }).map((c) => c.id),
    ["sign-in", "import", "file", "clear"],
  );
});
