import type { BatonRead } from "../baton.ts";
import type { LockInfo, LockResult } from "../lock.ts";
import type { Baton } from "../types.ts";

/** Where the baton, its history and the run lock live: local files, or Firestore when running in the cloud. */
export interface Store {
  readonly kind: "file" | "firestore";
  readBaton(): Promise<BatonRead>;
  /** Atomic: readers see the old baton or the new one, and the history copy goes with it. */
  writeBaton(b: Baton): Promise<void>;
  history(limit: number): Promise<Baton[]>;
  acquireLock(info: LockInfo, now: Date): Promise<LockResult>;
  releaseLock(info: LockInfo): Promise<void>;
  /** The current lock and whether its owner still counts as running. */
  readLock(now: Date): Promise<{ lock: LockInfo; alive: boolean } | null>;
}
