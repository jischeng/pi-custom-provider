import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { checkAbort } from "../operations/errors";

/** Shared cross-process lock and atomic replacement for configuration and credential stores. */
export async function withLockedFile<T>(
  file: string,
  signal: AbortSignal | undefined,
  mutate: (raw: string | undefined) => Promise<{ result: T; next?: string }>,
  onCommit?: () => void,
) {
  checkAbort(signal);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(file, {
    realpath: false,
    stale: 60_000,
    retries: { retries: 50, minTimeout: 20, maxTimeout: 100 },
  });
  try {
    checkAbort(signal);
    let raw: string | undefined;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    const { result, next } = await mutate(raw);
    if (next !== undefined) {
      checkAbort(signal);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const fd = fs.openSync(temporary, "wx", 0o600);
        try {
          fs.writeFileSync(fd, next);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(temporary, file);
        onCommit?.();
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    }
    return result;
  } finally {
    // A lock-cleanup failure cannot turn an already committed rename into a reported rollback.
    // proper-lockfile's stale-lock recovery makes a remaining lock recoverable.
    await release().catch(() => {});
  }
}
