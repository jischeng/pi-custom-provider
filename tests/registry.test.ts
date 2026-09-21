import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { OperationRegistry } from "../src/operations/registry";

test("completed results remain stable when an extension or event consumer mutates its objects", async () => {
  const source = { value: "original" };
  const registry = new OperationRegistry((event) => {
    if (event.type === "extension_operation_result") event.result.data.value = "event mutation";
  });
  registry.register("fixture", [
    {
      name: "read",
      title: "Read",
      description: "Read",
      inputSchema: Type.Object({}),
      resultSchema: Type.Object({ value: Type.String() }),
      effects: ["read"],
      allowedCallers: ["user_client"],
      cancellable: true,
      execute: async () => source,
    },
  ]);
  try {
    const task = registry.invoke("fixture/read", {});
    assert.equal((await task.done).data.value, "original");
    source.value = "later mutation";
    assert.equal(registry.get(task.snapshot.operationId).result?.data.value, "original");
  } finally {
    await registry.dispose();
  }
});

test("a long-running operation retains its result for thirty minutes after completion", async () => {
  let now = 0;
  const registry = new OperationRegistry(undefined, () => now);
  registry.register("fixture", [
    {
      name: "slow",
      title: "Slow",
      description: "Slow",
      inputSchema: Type.Object({}),
      resultSchema: Type.Null(),
      effects: ["read"],
      allowedCallers: ["user_client"],
      cancellable: true,
      execute: async () => {
        now = 31 * 60_000;
        return null;
      },
    },
  ]);
  try {
    const task = registry.invoke("fixture/slow", {});
    await task.done;
    assert.equal(registry.get(task.snapshot.operationId).state, "succeeded");
    now += 30 * 60_000 + 1;
    assert.throws(() => registry.get(task.snapshot.operationId), /expired/);
  } finally {
    await registry.dispose();
  }
});
