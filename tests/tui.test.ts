import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { API_CHOICES } from "../src/pi-catalog";
import { repo } from "./rpc-helper";
test("real Pi native terminal controls: create, edit, discard and delete", { timeout: 90000 }, async () => {
  const { stdout } = await promisify(execFile)(
    "python3",
    [
      `${repo}/tests/tui-smoke.py`,
      JSON.stringify({
        node: process.execPath,
        cli: fileURLToPath(new URL("cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))),
        repo,
        apiIndex: API_CHOICES.indexOf("openai-completions"),
      }),
    ],
    { timeout: 85000, maxBuffer: 1024 * 1024 },
  );
  assert.match(stdout, /passed/);
});
