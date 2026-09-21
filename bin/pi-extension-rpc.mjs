#!/usr/bin/env node
import { piCliPath } from "./pi-cli-path.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

// Pi's real CLI owns all native RPC commands. The extra IPC channel carries generic extension operations.
const protocol = "pi.extension-operations.v1";
const commands = new Set([
  "get_extension_operations",
  "invoke_extension_operation",
  "get_extension_operation",
  "cancel_extension_operation",
  "respond_extension_interaction",
]);
const cli = piCliPath;
const extension = fileURLToPath(new URL("../src/rpc/extension.ts", import.meta.url));
const child = spawn(process.execPath, [cli, "--mode", "rpc", "-e", extension, ...process.argv.slice(2)], {
  stdio: ["pipe", "pipe", "pipe", "ipc"],
});
const decoder = new StringDecoder("utf8");
let buffer = "",
  ready = false,
  ending = false;
const pending = [];
const startupTimer = setTimeout(() => {
  for (const request of pending.splice(0))
    output({
      type: "response",
      id: request.id,
      command: request.type,
      success: false,
      error: "Extension operations bridge did not start",
      errorDetails: { code: "UNSUPPORTED_CAPABILITY", retryable: true },
    });
  process.stderr.write("Extension operations bridge did not start within 30 seconds.\n");
  child.kill("SIGTERM");
}, 30000);
startupTimer.unref();
function output(value) {
  if (!process.stdout.write(JSON.stringify(value) + "\n")) {
    child.stdout.pause();
    process.stdin.pause();
    process.stdout.once("drain", () => {
      child.stdout.resume();
      process.stdin.resume();
    });
  }
}
const childDecoder = new StringDecoder("utf8");
let childBuffer = "";
child.stdout.on("data", (data) => {
  childBuffer += childDecoder.write(data);
  let index;
  while ((index = childBuffer.indexOf("\n")) >= 0) {
    const record = childBuffer.slice(0, index + 1);
    childBuffer = childBuffer.slice(index + 1);
    if (!process.stdout.write(record)) {
      child.stdout.pause();
      process.stdout.once("drain", () => child.stdout.resume());
    }
  }
});
child.stderr.pipe(process.stderr);
child.on("message", (message) => {
  if (message?.bridgeProtocol !== protocol) return;
  if (message.data.type === "extension_operations_ready") {
    ready = true;
    clearTimeout(startupTimer);
    for (const request of pending.splice(0)) child.send({ bridgeProtocol: protocol, request });
    if (ending) child.stdin.end();
  } else output(message.data);
});
function line(raw) {
  if (!raw.trim()) return;
  if (Buffer.byteLength(raw) > 1_048_576) {
    output({ type: "response", command: "parse", success: false, error: "Request exceeds 1 MiB" });
    return;
  }
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    output({ type: "response", command: "parse", success: false, error: "Invalid JSON" });
    return;
  }
  if (commands.has(request?.type)) {
    if (ready) child.send({ bridgeProtocol: protocol, request });
    else if (pending.length < 100) pending.push(request);
    else
      output({
        type: "response",
        id: request.id,
        command: request.type,
        success: false,
        error: "Bridge is starting; retry later",
      });
  } else if (!child.stdin.write(raw + "\n")) {
    process.stdin.pause();
    child.stdin.once("drain", () => process.stdin.resume());
  }
}
process.stdin.on("data", (data) => {
  buffer += decoder.write(data);
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    line(raw);
  }
  if (Buffer.byteLength(buffer) > 1_048_576) {
    output({ type: "response", command: "parse", success: false, error: "Request exceeds 1 MiB" });
    child.kill("SIGTERM");
  }
});
process.stdin.on("end", () => {
  buffer += decoder.end();
  if (buffer.trim()) line(buffer);
  ending = true;
  if (ready || !pending.length) child.stdin.end();
});
child.stdin.on("error", () => {});
child.on("error", () => {
  process.stderr.write("Unable to start Pi RPC.\n");
  process.exitCode = 1;
  process.stdin.destroy();
});
child.on("exit", (code, signal) => {
  clearTimeout(startupTimer);
  process.stdin.destroy();
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
