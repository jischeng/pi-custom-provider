import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
const piManifestUrl = new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCli = fileURLToPath(new URL(JSON.parse(readFileSync(piManifestUrl, "utf8")).bin.pi, piManifestUrl));
import { API_CHOICES } from "../src/domain/catalog";
import { repo } from "./rpc-helper";
test("real Pi native terminal controls: create, edit, discard and delete", { timeout: 90000 }, async () => {
  const { stdout } = await promisify(execFile)(
    "python3",
    [
      `${repo}/tests/tui-smoke.py`,
      JSON.stringify({
        node: process.execPath,
        cli: process.env.PI_TEST_CLI || piCli,
        repo,
        apiIndex: API_CHOICES.indexOf("openai-completions"),
      }),
    ],
    { timeout: 85000, maxBuffer: 1024 * 1024 },
  );
  assert.match(stdout, /passed/);
});
