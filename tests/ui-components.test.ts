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
