import { join } from "node:path";

// The ONLY broker endpoint this program talks to. Do not change it: it is what keeps real money out.
export const ALPACA_PAPER_URL = "https://paper-api.alpaca.markets";
export const ALPACA_DATA_URL = "https://data.alpaca.markets";

export const TIMEZONE = "Europe/Rome";

export type SlotName = "briefing" | "apertura" | "metà seduta" | "chiusura";
export interface Slot {
  hhmm: string; // Rome time, e.g. "1540"
  name: SlotName;
  ordersAllowed: boolean;
  weekend: boolean; // also runs on Saturday/Sunday
}

// US market is 15:30–22:00 Rome time.
export const SLOTS: Slot[] = [
  { hhmm: "0900", name: "briefing", ordersAllowed: false, weekend: true },
  { hhmm: "1540", name: "apertura", ordersAllowed: true, weekend: false },
  { hhmm: "1830", name: "metà seduta", ordersAllowed: true, weekend: false },
  { hhmm: "2140", name: "chiusura", ordersAllowed: true, weekend: false },
];

// A slot more than this late is considered missed, not run.
export const MISSED_AFTER_MINUTES = 60;
export const SCHEDULER_TICK_MS = 30_000;
export const STATUS_PORT = 8787;

// The cage. The model never sees these numbers; the code enforces them.
export const CAGE = {
  universe: ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "GLD", "TLT"],
  maxPositions: 5,
  maxWeightPerSymbol: 0.2,
  stopLossPct: -0.03,
};

export const BROKER = {
  timeoutMs: 10_000,
  attempts: 3,
  retryDelayMs: 1_000,
  recentOrdersHours: 48,
};

export const BRAIN = {
  timeoutMs: 180_000,
  model: "", // empty = Claude Code default for your plan
};

export const CLOUD = {
  // Longer than any run (the Actions job is killed at 10 min), so a live run never loses its lock.
  leaseMs: 15 * 60_000,
  historyLimit: 200,
};

export interface Paths {
  root: string;
  state: string;
  baton: string;
  history: string;
  lock: string;
  logs: string;
  fakeBroker: string;
}

/** Fake runs get their own state and logs, so a test never looks like a real run to the real trader. */
export function makePaths(root: string, fake = false): Paths {
  const state = join(root, "state", ...(fake ? ["fake"] : []));
  return {
    root,
    state,
    baton: join(state, "baton.json"),
    history: join(state, "history"),
    lock: join(state, "run.lock"),
    logs: join(root, "logs", ...(fake ? ["fake"] : [])),
    fakeBroker: join(state, "fake-broker.json"),
  };
}

export const PROJECT_ROOT = join(import.meta.dir, "..");
