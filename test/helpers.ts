import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBroker, type FakeFaults, type FakeState } from "../src/broker/fake.ts";
import { makePaths, PROJECT_ROOT, SLOTS, type Slot } from "../src/config.ts";
import { FakeBrain, type BrainInput } from "../src/llm.ts";
import { nullLogger } from "../src/log.ts";
import { ConsoleNotifier } from "../src/notify.ts";
import { FileStore } from "../src/store/file.ts";
import { FirestoreStore } from "../src/store/firestore.ts";
import type { Store } from "../src/store/types.ts";
import { MemoryDocs } from "./memoryDocs.ts";
import { localToDate } from "../src/time.ts";
import { wakeup, type WakeupDeps } from "../src/wakeup.ts";

// A Monday, so all four slots exist and the fake market is open at 15:40.
export const DAY = "2026-10-05";
export const slot = (hhmm: string): Slot => SLOTS.find((s) => s.hhmm === hhmm)!;

export function tempRoot() {
  return mkdtempSync(join(tmpdir(), "trader-test-"));
}

export interface Harness {
  root: string;
  paths: ReturnType<typeof makePaths>;
  broker: FakeBroker;
  notifier: ConsoleNotifier;
  clock: { now: Date };
  store: Store;
  docs: MemoryDocs | null;
  run(hhmm: string, opts?: { at?: string; force?: boolean; brain?: (i: BrainInput) => unknown; pid?: number; date?: string }): ReturnType<typeof wakeup>;
}

export function harness(opts: { state?: Partial<FakeState>; faults?: FakeFaults; store?: "file" | "firestore" } = {}): Harness {
  const root = tempRoot();
  const paths = makePaths(root);
  FakeBroker.seed(paths.fakeBroker, opts.state);
  const clock = { now: localToDate(DAY, "1540") };
  const broker = new FakeBroker(paths.fakeBroker, () => clock.now, opts.faults);
  const notifier = new ConsoleNotifier(true);
  const docs = opts.store === "firestore" ? new MemoryDocs() : null;
  const store: Store = docs ? new FirestoreStore(docs) : new FileStore(paths);
  return {
    root, paths, broker, notifier, clock, store, docs,
    run(hhmm, o = {}) {
      const date = o.date ?? DAY;
      clock.now = localToDate(date, o.at ?? hhmm);
      const deps: WakeupDeps = {
        store, broker, notifier, log: nullLogger,
        brain: new FakeBrain(o.brain),
        now: () => clock.now,
        pid: o.pid,
      };
      return wakeup(deps, { date, slot: slot(hhmm), force: o.force });
    },
  };
}

/** Run the real CLI in a subprocess against a temp root. */
export function spawnOnce(root: string, args: string[], env: Record<string, string> = {}) {
  return Bun.spawn(["bun", join(PROJECT_ROOT, "src/cli/once.ts"), "--fake", ...args], {
    env: { ...process.env, TRADER_ROOT: root, FAKE_NOW: localToDate(DAY, "1540").toISOString(), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** A pid that certainly belongs to no running process. */
export async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]);
  await p.exited;
  return p.pid;
}
