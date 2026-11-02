import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readBaton, writeBaton } from "../baton.ts";
import type { Paths } from "../config.ts";
import { acquireLock, isStale, type LockInfo, readLock, releaseLock } from "../lock.ts";
import type { Baton } from "../types.ts";
import type { Store } from "./types.ts";

/** Local files under state/: the original single-machine setup. */
export class FileStore implements Store {
  readonly kind = "file" as const;
  constructor(private readonly paths: Paths) {}

  async readBaton() {
    return readBaton(this.paths.baton);
  }

  async writeBaton(b: Baton) {
    writeBaton(this.paths.baton, this.paths.history, b);
  }

  async history(limit: number): Promise<Baton[]> {
    if (!existsSync(this.paths.history)) return [];
    return readdirSync(this.paths.history)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .slice(-limit)
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(this.paths.history, f), "utf8")) as Baton];
        } catch {
          return [];
        }
      });
  }

  async acquireLock(info: LockInfo, now: Date) {
    return acquireLock(this.paths.lock, info, now);
  }

  async releaseLock(info: LockInfo) {
    releaseLock(this.paths.lock, info.pid);
  }

  async readLock(now: Date) {
    if (!existsSync(this.paths.lock)) return null;
    const lock = readLock(this.paths.lock) ?? { runId: "illeggibile", pid: 0, startedAt: "" };
    return { lock, alive: !isStale(lock, now) };
  }
}
