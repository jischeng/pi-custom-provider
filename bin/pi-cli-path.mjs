import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Use the installed package's public CLI entry, including its bundled runtime.
const manifestUrl = new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent"));
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
export const piCliPath = fileURLToPath(new URL(manifest.bin.pi, manifestUrl));
