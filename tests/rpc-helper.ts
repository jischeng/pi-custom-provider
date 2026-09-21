import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
export const repo = path.resolve(import.meta.dirname, "..");
export async function rpc(bridge = true, extra: string[] = [], initialConfig?: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-rpc-"));
  for (const dir of ["home", "agent", "cwd"]) fs.mkdirSync(path.join(root, dir));
  if (initialConfig !== undefined)
    fs.writeFileSync(path.join(root, "agent/models.json"), JSON.stringify(initialConfig));
  const cli = bridge
    ? path.join(repo, "bin/pi-extension-rpc.mjs")
    : fileURLToPath(new URL("cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const args = [
    cli,
    ...(!bridge ? ["--mode", "rpc"] : []),
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-tools",
    "--provider-catalog-url",
    "off",
    "-e",
    path.join(repo, "src/index.ts"),
    ...extra,
  ];
  const child = spawn(process.execPath, args, {
    cwd: path.join(root, "cwd"),
    env: {
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      PI_CODING_AGENT_DIR: path.join(root, "agent"),
      PI_OFFLINE: "1",
      LANG: "en_US.UTF-8",
      TERM: "dumb",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: any[] = [];
  let error = "",
    buf = "",
    serial = 0;
  const decoder = new StringDecoder("utf8");
  child.stdout.on("data", (data) => {
    buf += decoder.write(data);
    let index;
    while ((index = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, index);
      buf = buf.slice(index + 1);
      try {
        if (line.trim()) events.push(JSON.parse(line));
      } catch {
        error += "INVALID JSONL:" + line;
      }
    }
  });
  child.stderr.on("data", (data) => {
    error += data.toString();
  });
  const send = (request: any) => child.stdin.write(JSON.stringify(request) + "\n");
  async function wait(predicate: (event: any) => boolean, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = events.find(predicate);
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`Pi exited ${child.exitCode}: ${error}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`RPC timeout: ${error}\n${JSON.stringify(events.slice(-3))}`);
  }
  async function command(type: string, args: any = {}) {
    const id = `r${++serial}`;
    send({ id, type, ...args });
    return wait((e) => e.id === id && e.type === "response");
  }
  async function invoke(operation: string, args: any) {
    const response = await command("invoke_extension_operation", {
      operation,
      arguments: args,
      requestId: `request${++serial}`,
    });
    if (!response.success) throw new Error(JSON.stringify(response));
    const id = response.data.operationId;
    return (await wait((e) => e.type === "extension_operation_result" && e.operationId === id)).result;
  }
  return {
    root,
    child,
    events,
    send,
    wait,
    command,
    invoke,
    get stderr() {
      return error;
    },
    async close() {
      child.stdin.end();
      await Promise.race([
        new Promise<void>((r) => child.once("exit", () => r())),
        new Promise<void>((r) =>
          setTimeout(() => {
            child.kill("SIGTERM");
            r();
          }, 3000).unref(),
        ),
      ]);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
