import { parseBaton } from "../baton.ts";
import { CLOUD } from "../config.ts";
import type { LockInfo, LockResult } from "../lock.ts";
import type { Baton } from "../types.ts";
import type { Store } from "./types.ts";

export type Fields = Record<string, string>;
export interface Doc {
  fields: Fields;
  updateTime: string; // Firestore's version stamp, used as a compare-and-swap precondition
}

/** The handful of Firestore operations the store needs. Each one is atomic on the server. */
export interface DocClient {
  get(path: string): Promise<Doc | null>;
  /** false if the document already exists. */
  create(path: string, fields: Fields): Promise<boolean>;
  /** false if the document changed since `ifUpdateTime`. */
  replace(path: string, fields: Fields, ifUpdateTime: string): Promise<boolean>;
  delete(path: string, ifUpdateTime: string): Promise<boolean>;
  /** Several unconditional writes, all or nothing. */
  commit(writes: { path: string; fields: Fields }[]): Promise<void>;
  /** Newest first, by document id. */
  listDesc(collection: string, limit: number): Promise<Doc[]>;
}

const BATON = "trader/baton";
const LOCK = "trader/lock";

/**
 * Baton and history as JSON strings (the dashboard parses them), lock as a lease: in the cloud there is no
 * local pid to check, so a lock counts as alive until it expires.
 */
export class FirestoreStore implements Store {
  readonly kind = "firestore" as const;
  constructor(private readonly db: DocClient, private readonly leaseMs = CLOUD.leaseMs) {}

  async readBaton() {
    const d = await this.db.get(BATON);
    return d ? parseBaton(d.fields.json ?? "") : { baton: null, corrupted: false };
  }

  async writeBaton(b: Baton) {
    const fields = { runId: b.runId, json: JSON.stringify(b) };
    await this.db.commit([{ path: `history/${b.runId}`, fields }, { path: BATON, fields }]);
  }

  async history(limit: number): Promise<Baton[]> {
    const docs = await this.db.listDesc("history", limit);
    return docs.flatMap((d) => parseBaton(d.fields.json ?? "").baton ?? []).reverse();
  }

  private lockFields(info: LockInfo, now: Date): Fields {
    return {
      runId: info.runId,
      holder: info.holder ?? `pid-${info.pid}`,
      startedAt: info.startedAt,
      expiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
    };
  }

  private static toInfo(f: Fields): LockInfo | null {
    return f.runId && f.holder && f.expiresAt ? { runId: f.runId, pid: 0, startedAt: f.startedAt ?? "", holder: f.holder } : null;
  }

  async acquireLock(info: LockInfo, now: Date): Promise<LockResult> {
    const fields = this.lockFields(info, now);
    if (await this.db.create(LOCK, fields)) return { ok: true, stale: null };

    const cur = await this.db.get(LOCK);
    if (!cur) {
      // Released between our two calls: one more try, and whoever wins, wins.
      return (await this.db.create(LOCK, fields)) ? { ok: true, stale: null } : { ok: false, holder: null };
    }
    const holder = FirestoreStore.toInfo(cur.fields);
    // Our own create went through but its response was lost and retried.
    if (holder?.holder === fields.holder) return { ok: true, stale: null };
    if (holder && new Date(cur.fields.expiresAt!) > now) return { ok: false, holder };

    // Expired lease: its run died. Swap it out only if nobody else did first.
    if (!(await this.db.replace(LOCK, fields, cur.updateTime))) return { ok: false, holder };
    return { ok: true, stale: holder ?? { runId: "sconosciuta", pid: 0, startedAt: "" } };
  }

  async releaseLock(info: LockInfo) {
    const cur = await this.db.get(LOCK);
    if (cur && cur.fields.holder === (info.holder ?? `pid-${info.pid}`)) await this.db.delete(LOCK, cur.updateTime);
  }

  async readLock(now: Date) {
    const cur = await this.db.get(LOCK);
    if (!cur) return null;
    const lock = FirestoreStore.toInfo(cur.fields) ?? { runId: "illeggibile", pid: 0, startedAt: "" };
    return { lock, alive: !!cur.fields.expiresAt && new Date(cur.fields.expiresAt) > now };
  }
}
