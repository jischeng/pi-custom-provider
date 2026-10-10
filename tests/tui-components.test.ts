import test from "node:test";
import assert from "node:assert/strict";
import { SettingsList } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { settingsPanel } from "../src/extension/tui/components";

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
  // Actions render first, then fields: move down to Reasoning, toggle it, then Save.
  component.handleInput("\x1b[B");
  component.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  component.handleInput("\x1b[A");
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

test("the terminal adapter shows Pi's cancellable loader for network work only", async () => {
  const { BorderedLoader } = await import("@earendil-works/pi-coding-agent");
  const { Type } = await import("typebox");
  const { createTuiOperations } = await import("../src/extension/tui/operations");
  const components: any[] = [];
  const ctx: any = {
    ui: {
      setStatus() {},
      custom(factory: any) {
        return new Promise<void>((done) => {
          components.push(factory({ requestRender() {} }, { fg: (_role: string, text: string) => text }, {}, done));
        });
      },
    },
  };
  const waiting = (effects: any) => ({
    name: "wait",
    title: "Wait",
    description: "Wait",
    inputSchema: Type.Object({}),
    resultSchema: Type.Null(),
    effects,
    allowedCallers: ["user_client"] as ("user_client" | "model_tool")[],
    execute: (_args: any, context: any) =>
      new Promise((_resolve: any, reject: any) => {
        context.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), {
          once: true,
        });
      }),
  });
  const client = createTuiOperations([waiting(["network"]), { ...waiting(["config_write"]), name: "write" }], ctx);
  assert(!("execute" in client.describe("wait")));
  const controller = new AbortController();
  const result = client.invoke("wait", {}, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert(components[0] instanceof BorderedLoader);
  components[0].handleInput("\x1b");
  assert.equal((await result).status, "cancelled");

  // A write is applied in place: it must not swap the screen with a loader.
  const quick = new AbortController();
  const write = client.invoke("write", {}, quick.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(components.length, 1);
  quick.abort();
  assert.equal((await write).status, "cancelled");
});

test("panel rows never depend on a theme colour role, so a mismatched theme cannot hide them", async () => {
  const { providerPanel } = await import("../src/extension/tui/provider-panel");
  const { stripTerminalSequences } = await import("@earendil-works/pi-tui");
  let panel: any;
  const ctx: any = {
    ui: {
      custom(factory: any) {
        return new Promise<void>((done) => {
          panel = factory(
            { terminal: { rows: 30 }, requestRender() {} },
            // A theme whose "text" colour is unreadable, like the light theme on a dark terminal.
            { fg: (role: string, text: string) => (role === "text" ? "INVISIBLE" : text), bold: (t: string) => t },
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
        {
          heading: "Actions",
          items: [
            { id: "$create", label: "Create provider" },
            { id: "$done", label: "Close" },
          ],
        },
        { heading: "Providers", items: [{ id: "deepseek", label: "deepseek" }] },
      ],
    }),
    async () => false,
    abort.signal,
  );
  try {
    // Moving into the second section leaves the first section's remembered row inactive.
    panel.handleInput("\x1b[B");
    panel.handleInput("\x1b[B");
    const lines = panel.render(80).map(stripTerminalSequences);
    assert(lines.some((line: string) => line.includes("Close")));
    assert(lines.every((line: string) => !line.includes("INVISIBLE")));
    assert.equal(lines.filter((line: string) => line.includes("→")).length, 1);
  } finally {
    abort.abort();
    await task;
  }
});

test("grouped native provider controls fit short terminals and navigate continuously across sections with arrows and mouse", async () => {
  const { providerPanel } = await import("../src/extension/tui/provider-panel");
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
        sections: [
          {
            heading: "Provider",
            items: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, label: `Setting ${i}` })),
          },
          {
            heading: "Models",
            items: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, label: `Model ${i}` })),
          },
          {
            heading: "Actions",
            items: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, label: `Action ${i}` })),
          },
        ],
      }),
      async (id) => {
        selected = id;
        return false;
      },
      abort.signal,
    );
    try {
      const lines = panel.render(80).map(stripTerminalSequences);
      // No section is folded: every item renders, with no "(n/m)" scroll indicator.
      assert(lines.every((line: string) => !/\(\d+\/\d+\)/.test(line)));
      assert(lines.some((line: string) => line.includes("Model 19")));
      assert(lines.some((line: string) => line.includes("Action 8")));
      assert(lines.some((line: string) => line.includes("Setting 4")));
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
      // Up from the first action reaches the last model, then Down returns to the action.
      panel.handleInput("\x1b[A");
      assert.match(
        panel
          .render(80)
          .map(stripTerminalSequences)
          .find((line: string) => line.includes("→")),
        /Model 19/,
      );
      panel.handleInput("\x1b[B");
      assert.match(
        panel
          .render(80)
          .map(stripTerminalSequences)
          .find((line: string) => line.includes("→")),
        /Action 0/,
      );
      panel.handleInput("\r");
      await task;
      assert.equal(selected, "a0");
    } finally {
      abort.abort();
      await task;
    }
  }
});
