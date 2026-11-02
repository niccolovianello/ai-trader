import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LockInfo {
  runId: string;
  pid: number; // 0 when the holder is not a local process (cloud lease)
  startedAt: string;
  holder?: string; // cloud lease: unique id of the run that owns it
}

export type LockResult =
  | { ok: true; stale: LockInfo | null } // stale = the lock of a run that died halfway
  | { ok: false; holder: LockInfo | null };

// No run lasts this long (brain timeout is 3 min); guards against a recycled pid.
const MAX_LOCK_AGE_MS = 30 * 60_000;

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(path: string): LockInfo | null {
  try {
    const l = JSON.parse(readFileSync(path, "utf8"));
    return typeof l?.pid === "number" && typeof l?.runId === "string" ? l : null;
  } catch {
    return null;
  }
}

export function isStale(l: LockInfo | null, now: Date): boolean {
  if (!l) return true; // unreadable lock: its writer died before finishing
  return !isAlive(l.pid) || now.getTime() - new Date(l.startedAt).getTime() > MAX_LOCK_AGE_MS;
}

/** Writes the full content first, then hard-links it into place: creation is atomic and fails if the lock exists. */
function tryCreate(path: string, info: LockInfo): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${info.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(info));
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    unlinkSync(tmp);
  }
}

/**
 * Take the run lock. If a dead run left its lock behind, only one process may take it over:
 * the takeover itself is guarded by a second exclusive file, so two runs finding the same
 * stale lock cannot both proceed.
 */
export function acquireLock(path: string, info: LockInfo, now = new Date()): LockResult {
  if (tryCreate(path, info)) return { ok: true, stale: null };

  const holder = readLock(path);
  if (!isStale(holder, now)) return { ok: false, holder };

  const takeover = `${path}.takeover`;
  const tk = { ...info, runId: `takeover:${info.runId}` };
  if (!tryCreate(takeover, tk)) {
    const t = readLock(takeover);
    // A takeover whose owner died is cleared; this run steps back and the next one proceeds.
    if (isStale(t, now)) unlinkSafe(takeover);
    return { ok: false, holder };
  }
  try {
    const again = readLock(path);
    if (existsSync(path) && !isStale(again, now)) return { ok: false, holder: again };
    unlinkSafe(path);
    if (!tryCreate(path, info)) return { ok: false, holder: readLock(path) };
    return { ok: true, stale: holder ?? { runId: "sconosciuta", pid: 0, startedAt: "" } };
  } finally {
    unlinkSafe(takeover);
  }
}

export function releaseLock(path: string, pid = process.pid) {
  const l = readLock(path);
  if (l && l.pid === pid) unlinkSafe(path);
}

function unlinkSafe(p: string) {
  try {
    unlinkSync(p);
  } catch {}
}
