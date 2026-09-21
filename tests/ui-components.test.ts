import test from "node:test";
import assert from "node:assert/strict";
import { SettingsList } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { settingsPanel } from "../src/ui/components";

initTheme("dark");
test("native settings wait for pending edits before returning a save action", async () => {
  let component!: SettingsList;
  let release!: (value: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const ctx: any = {
    ui: {
      notify() {},
      custom(factory: any) {
        return new Promise<void>((done) => {
          component = factory({ requestRender() {} }, {}, {}, done);
        });
      },
    },
  };
  let finished = false;
  const result = settingsPanel(
    ctx,
    [{ id: "reasoning", label: "Reasoning", schema: { type: "boolean" }, value: false }],
    [{ id: "save", label: "Save" }],
    () => pending,
  ).then((value) => {
    finished = true;
    return value;
  });
  assert(component instanceof SettingsList);
  component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  component.handleInput("\x1b[B");
  component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  release(true);
  assert.equal(await result, "save");
});

test("native settings restore the authoritative value after a rejected edit", async () => {
  let component!: SettingsList;
  const ctx: any = {
    ui: {
      notify() {},
      custom(factory: any) {
        return new Promise<void>((done) => {
          component = factory({ requestRender() {} }, {}, {}, done);
        });
      },
    },
  };
  const result = settingsPanel(
    ctx,
    [{ id: "reasoning", label: "Reasoning", schema: { type: "boolean" }, value: false }],
    [],
    async () => false,
  );
  component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(component.render(90).join("\n"), /No/);
  component.handleInput("\x1b");
  assert.equal(await result, undefined);
});

test("the local operation adapter uses Pi's cancellable loader without a UI-specific business operation", async () => {
  const { BorderedLoader } = await import("@earendil-works/pi-coding-agent");
  const { Type } = await import("typebox");
  const { createUiOperations } = await import("../src/ui/operations");
  let component: any;
  const ctx: any = {
    ui: {
      setStatus() {},
      custom(factory: any) {
        return new Promise<void>((done) => {
          component = factory({ requestRender() {} }, { fg: (_role: string, text: string) => text }, {}, done);
        });
      },
    },
  };
  const client = createUiOperations(
    [
      {
        name: "wait",
        title: "Wait",
        description: "Wait",
        inputSchema: Type.Object({}),
        resultSchema: Type.Null(),
        effects: ["network"],
        allowedCallers: ["user_client"],
        cancellable: true,
        execute: (_args, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), {
              once: true,
            });
          }),
      },
    ],
    ctx,
  );
  assert(!("execute" in client.describe("wait")));
  const result = client.invoke("wait", {});
  await new Promise((resolve) => setImmediate(resolve));
  assert(component instanceof BorderedLoader);
  component.handleInput("\x1b");
  assert.equal((await result).status, "cancelled");
});

test("grouped native provider controls fit short terminals and route mouse/Tab focus", async () => {
  const { providerPanel } = await import("../src/ui/provider-panel");
  const { stripTerminalSequences } = await import("@earendil-works/pi-tui");
  for (const rows of [24, 30, 65]) {
    let panel: any;
    let selected: string | undefined;
    const abort = new AbortController();
    const ctx: any = {
      ui: {
        custom(factory: any) {
          return new Promise<void>((done) => {
            panel = factory(
              { terminal: { rows }, requestRender() {} },
              { fg: (_role: string, text: string) => text, bold: (text: string) => text },
              {},
              done,
            );
          });
        },
      },
    };
    const task = providerPanel(
      ctx,
      () => ({
        title: "Provider: fixture",
        models: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, label: `Model ${i}` })),
        actions: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, label: `Action ${i}` })),
      }),
      async (id) => {
        selected = id;
        return false;
      },
      abort.signal,
    );
    try {
      const lines = panel.render(80).map(stripTerminalSequences);
      assert(lines.length <= rows - 2, `Dialog exceeds ${rows} terminal rows: ${lines.length}`);
      const result = panel.handleMouse({
        type: "press",
        button: "left",
        x: 3,
        y: lines.findIndex((line: string) => line.includes("Action 0")),
        screenX: 3,
        screenY: 1,
        width: 80,
        height: lines.length,
        shift: false,
        alt: false,
        ctrl: false,
      });
      assert.equal(result.focusTarget, panel);
      const cursors = panel
        .render(80)
        .map(stripTerminalSequences)
        .filter((line: string) => line.includes("→"));
      assert.equal(cursors.length, 1);
      assert.match(cursors[0], /Action 0/);
      panel.handleInput("\t");
      panel.handleInput("\r");
      await task;
      assert.equal(selected, "m0");
    } finally {
      abort.abort();
      await task;
    }
  }
});
