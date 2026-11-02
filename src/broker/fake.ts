import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { localParts } from "../time.ts";
import type { Account, BrokerOrder, MarketClock, OrderRequest, Position } from "../types.ts";
import { type Broker, BrokerUnreachableError, DuplicateOrderError } from "./types.ts";

export interface FakeState {
  cash: number;
  lastEquity: number;
  prices: Record<string, number>;
  positions: Record<string, { qty: number; avgEntryPrice: number }>;
  orders: BrokerOrder[];
}

export interface FakeFaults {
  /** Every call throws as if the network were down. */
  unreachable?: boolean;
  /** The order reaches the broker, but the response is lost. */
  loseSubmitResponse?: boolean;
  /** getOrderByClientId fails too (outcome becomes unknown). */
  lookupUnreachable?: boolean;
  /** SIGKILL this process right after N orders have been stored. For crash tests. */
  crashAfterSubmits?: number;
}

export const DEFAULT_PRICES: Record<string, number> = {
  SPY: 670, QQQ: 600, IWM: 245, AAPL: 255, MSFT: 520, NVDA: 185, GLD: 380, TLT: 90,
};

export function freshFakeState(): FakeState {
  return { cash: 100_000, lastEquity: 100_000, prices: { ...DEFAULT_PRICES }, positions: {}, orders: [] };
}

/** Same interface as Alpaca, persisted to a JSON file, fills market orders instantly. */
export class FakeBroker implements Broker {
  readonly kind = "finto" as const;
  private submits = 0;

  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
    public faults: FakeFaults = {},
  ) {}

  static seed(path: string, patch: Partial<FakeState> = {}) {
    write(path, { ...freshFakeState(), ...patch });
  }

  read(): FakeState {
    if (!existsSync(this.path)) return freshFakeState();
    return JSON.parse(readFileSync(this.path, "utf8"));
  }

  private down() {
    if (this.faults.unreachable) throw new BrokerUnreachableError("broker finto: rete giù");
  }

  async getAccount(): Promise<Account> {
    this.down();
    const s = this.read();
    const equity = s.cash + Object.entries(s.positions).reduce((t, [sym, p]) => t + p.qty * (s.prices[sym] ?? p.avgEntryPrice), 0);
    return { equity, lastEquity: s.lastEquity, cash: s.cash };
  }

  async getPositions(): Promise<Position[]> {
    this.down();
    const s = this.read();
    return Object.entries(s.positions).map(([symbol, p]) => {
      const price = s.prices[symbol] ?? p.avgEntryPrice;
      return {
        symbol,
        qty: p.qty,
        avgEntryPrice: p.avgEntryPrice,
        currentPrice: price,
        marketValue: p.qty * price,
        unrealizedPlPct: price / p.avgEntryPrice - 1,
      };
    });
  }

  async getOrdersSince(since: Date): Promise<BrokerOrder[]> {
    this.down();
    return this.read().orders.filter((o) => new Date(o.submittedAt) >= since);
  }

  async getClock(): Promise<MarketClock> {
    this.down();
    const { hhmm, weekday } = localParts(this.now());
    const isOpen = weekday >= 1 && weekday <= 5 && hhmm >= "1530" && hhmm < "2200";
    return { isOpen, nextOpen: "", nextClose: "" };
  }

  async getOrderByClientId(id: string): Promise<BrokerOrder | null> {
    this.down();
    if (this.faults.lookupUnreachable) throw new BrokerUnreachableError("broker finto: ricerca ordine fallita");
    return this.read().orders.find((o) => o.clientOrderId === id) ?? null;
  }

  async getLatestPrices(symbols: string[]): Promise<Record<string, number>> {
    this.down();
    const s = this.read();
    return Object.fromEntries(symbols.filter((x) => s.prices[x]).map((x) => [x, s.prices[x]!]));
  }

  async submitOrder(req: OrderRequest): Promise<BrokerOrder> {
    this.down();
    const s = this.read();
    if (s.orders.some((o) => o.clientOrderId === req.clientOrderId)) {
      throw new DuplicateOrderError(`ordine ${req.clientOrderId} già presente sul broker`);
    }
    const price = s.prices[req.symbol];
    if (!price) throw new Error(`broker finto: prezzo sconosciuto per ${req.symbol}`);
    const pos = s.positions[req.symbol] ?? { qty: 0, avgEntryPrice: price };
    if (req.side === "buy") {
      pos.avgEntryPrice = (pos.avgEntryPrice * pos.qty + price * req.qty) / (pos.qty + req.qty);
      pos.qty += req.qty;
      s.cash -= price * req.qty;
    } else {
      if (req.qty > pos.qty) throw new Error("broker finto: vendita allo scoperto non ammessa");
      pos.qty -= req.qty;
      s.cash += price * req.qty;
    }
    if (pos.qty > 0) s.positions[req.symbol] = pos;
    else delete s.positions[req.symbol];
    const order: BrokerOrder = {
      id: crypto.randomUUID(),
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: req.side,
      qty: req.qty,
      status: "filled",
      filledQty: req.qty,
      filledAvgPrice: price,
      submittedAt: this.now().toISOString(),
    };
    s.orders.push(order);
    write(this.path, s);
    this.submits++;
    if (this.faults.crashAfterSubmits && this.submits >= this.faults.crashAfterSubmits) {
      process.kill(process.pid, "SIGKILL");
    }
    if (this.faults.loseSubmitResponse) throw new BrokerUnreachableError("broker finto: risposta persa (timeout)");
    return order;
  }
}

function write(path: string, s: FakeState) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, path);
}
