import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
const piManifestUrl = new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCli = fileURLToPath(new URL(JSON.parse(readFileSync(piManifestUrl, "utf8")).bin.pi, piManifestUrl));
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
export const repo = path.resolve(import.meta.dirname, "..");
export const resultEntryType = "provider-manager/result";

/**
 * Runs unmodified Pi RPC. Management goes through Pi's own protocol only:
 * `get_commands` to discover, `prompt` to run `<command> <operation> <json>`,
 * `extension_ui_response` to answer prompts, and `get_entries` to read the result entry.
 * Completion is signalled by the command's notification, so no polling races a dialog.
 */
export async function rpc(
  extra: string[] = [],
  initialConfig?: unknown,
  commandName = "model-config",
  initialAuth?: unknown,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-rpc-"));
  for (const dir of ["home", "agent", "cwd"]) fs.mkdirSync(path.join(root, dir));
  if (initialConfig !== undefined)
    fs.writeFileSync(path.join(root, "agent/models.json"), JSON.stringify(initialConfig));
  if (initialAuth !== undefined) fs.writeFileSync(path.join(root, "agent/auth.json"), JSON.stringify(initialAuth));
  const args = [
    piCli,
    "--mode",
    "rpc",
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
  const notifyFor = (label: string) =>
    events.find((e) => e.type === "extension_ui_request" && e.method === "notify" && e.message?.startsWith(label));
  const leaf = async () => (await command("get_entries")).data?.leafId ?? null;
  async function readEntry<T>(find: (entry: any) => T | undefined, since: string | null = null): Promise<T> {
    const entries = await command("get_entries", since ? { since } : {});
    const hit = (entries.data?.entries ?? []).map(find).find(Boolean);
    if (!hit) throw new Error(`No matching session entry: ${error}`);
    return hit as T;
  }
  async function catalog(timeout = 20000) {
    const since = await leaf();
    await command("prompt", { message: `/${commandName} help` });
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const hit = events.find(
        (e) => e.type === "extension_ui_request" && e.method === "notify" && /read entry ".+"\.$/.test(e.message ?? ""),
      );
      if (hit) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    return readEntry(
      (entry: any) =>
        entry.type === "custom" && entry.customType === resultEntryType && entry.data?.kind === "catalog"
          ? entry.data.operations
          : undefined,
      since,
    );
  }
  /**
   * Runs one operation. Prompts are answered from `answers` in order; an undefined answer
   * cancels that prompt. Returns the result and how many prompts were shown.
   */
  async function run(operation: string, args: any, answers: (string | undefined)[] = []) {
    const pending = [...answers];
    const since = await leaf();
    // The prompt response only arrives after the command finishes, so start it and keep
    // answering extension UI requests meanwhile instead of awaiting it first.
    const finished = command("prompt", {
      message: `/${commandName} ${operation} ${JSON.stringify(args ?? {})}`,
    });
    let answered = 0;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const prompt = events
        .filter((e) => e.type === "extension_ui_request" && ["select", "input", "confirm"].includes(e.method))
        .at(answered);
      if (prompt) {
        answered++;
        const value = pending.shift();
        send(
          value === undefined
            ? { type: "extension_ui_response", id: prompt.id, cancelled: true }
            : prompt.method === "confirm"
              ? { type: "extension_ui_response", id: prompt.id, confirmed: value === "yes" }
              : { type: "extension_ui_response", id: prompt.id, value },
        );
        continue;
      }
      if (notifyFor(`${operation}: `)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const response = await finished;
    if (!response.success) throw new Error(JSON.stringify(response));
    const result = await readEntry(
      (entry: any) =>
        entry.type === "custom" &&
        entry.customType === resultEntryType &&
        entry.data?.kind === "result" &&
        entry.data.operation === operation
          ? entry.data.result
          : undefined,
      since,
    );
    return { result, prompts: answered };
  }
  const invoke = async (operation: string, args: any) => (await run(operation, args)).result;
  const invokeWithAnswers = (operation: string, args: any, answers: (string | undefined)[]) =>
    run(operation, args, answers);
  return {
    root,
    child,
    events,
    send,
    wait,
    command,
    catalog,
    invoke,
    invokeWithAnswers,
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
