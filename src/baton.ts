import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseRunId } from "./time.ts";
import type { Baton } from "./types.ts";

export interface BatonRead {
  baton: Baton | null;
  corrupted: boolean;
}

/** A corrupted baton counts as no baton: the broker still knows where the money is. */
export function readBaton(path: string): BatonRead {
  if (!existsSync(path)) return { baton: null, corrupted: false };
  return parseBaton(readFileSync(path, "utf8"));
}

export function parseBaton(text: string): BatonRead {
  try {
    const b = JSON.parse(text);
    if (b?.version !== 1 || typeof b.runId !== "string" || !parseRunId(b.runId) || typeof b.planNext !== "string") {
      return { baton: null, corrupted: true };
    }
    return { baton: b as Baton, corrupted: false };
  } catch {
    return { baton: null, corrupted: true };
  }
}

/** temp file + rename: a reader sees either the old baton or the new one, never half of it. */
export function writeAtomic(path: string, data: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function writeBaton(path: string, historyDir: string, b: Baton) {
  const data = JSON.stringify(b, null, 2);
  writeAtomic(join(historyDir, `${b.runId}.json`), data);
  writeAtomic(path, data);
}
