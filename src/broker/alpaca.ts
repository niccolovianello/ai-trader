import { ALPACA_DATA_URL, ALPACA_PAPER_URL, BROKER } from "../config.ts";
import type { Account, BrokerOrder, MarketClock, OrderRequest, Position } from "../types.ts";
import { type Broker, BrokerUnreachableError, DuplicateOrderError } from "./types.ts";

class HttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

function toOrder(o: any): BrokerOrder {
  return {
    id: o.id,
    clientOrderId: o.client_order_id,
    symbol: o.symbol,
    side: o.side,
    qty: num(o.qty),
    status: o.status,
    filledQty: num(o.filled_qty),
    filledAvgPrice: o.filled_avg_price == null ? null : Number(o.filled_avg_price),
    submittedAt: o.submitted_at,
  };
}

export class AlpacaPaperBroker implements Broker {
  readonly kind = "alpaca-paper" as const;
  private readonly headers: Record<string, string>;

  constructor(
    keyId: string,
    secret: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly retryDelayMs = BROKER.retryDelayMs,
  ) {
    if (!keyId || !secret) throw new Error("Chiavi Alpaca mancanti: copia secrets.example.ts in secrets.ts e compilalo.");
    this.headers = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret, "content-type": "application/json" };
  }

  /** One HTTP call, no retries. Network errors and timeouts become BrokerUnreachableError. */
  private async call(url: string, init: RequestInit = {}): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { ...init, headers: this.headers, signal: AbortSignal.timeout(BROKER.timeoutMs) });
    } catch (e) {
      throw new BrokerUnreachableError(`Alpaca non risponde (${(e as Error).name}: ${(e as Error).message})`);
    }
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text);
    return text ? JSON.parse(text) : null;
  }

  /** Reads are safe to retry: network errors and 5xx/429 get BROKER.attempts tries. */
  private async get(path: string, base = ALPACA_PAPER_URL): Promise<any> {
    let last: unknown;
    for (let i = 0; i < BROKER.attempts; i++) {
      try {
        return await this.call(base + path);
      } catch (e) {
        last = e;
        const retryable = e instanceof BrokerUnreachableError || (e instanceof HttpError && (e.status >= 500 || e.status === 429));
        if (!retryable) throw e;
        if (i < BROKER.attempts - 1) await Bun.sleep(this.retryDelayMs * (i + 1));
      }
    }
    if (last instanceof BrokerUnreachableError) throw last;
    throw new BrokerUnreachableError(`Alpaca non risponde dopo ${BROKER.attempts} tentativi: ${(last as Error).message}`);
  }

  async getAccount(): Promise<Account> {
    const a = await this.get("/v2/account");
    return { equity: num(a.equity), lastEquity: num(a.last_equity), cash: num(a.cash) };
  }

  async getPositions(): Promise<Position[]> {
    const ps: any[] = await this.get("/v2/positions");
    return ps.map((p) => ({
      symbol: p.symbol,
      qty: num(p.qty),
      avgEntryPrice: num(p.avg_entry_price),
      currentPrice: num(p.current_price),
      marketValue: num(p.market_value),
      unrealizedPlPct: num(p.unrealized_plpc),
    }));
  }

  async getOrdersSince(since: Date): Promise<BrokerOrder[]> {
    const os: any[] = await this.get(`/v2/orders?status=all&limit=500&direction=desc&after=${encodeURIComponent(since.toISOString())}`);
    return os.map(toOrder);
  }

  async getClock(): Promise<MarketClock> {
    const c = await this.get("/v2/clock");
    return { isOpen: !!c.is_open, nextOpen: c.next_open, nextClose: c.next_close };
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null> {
    try {
      return toOrder(await this.get(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`));
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  async getLatestPrices(symbols: string[]): Promise<Record<string, number>> {
    if (symbols.length === 0) return {};
    const r = await this.get(`/v2/stocks/trades/latest?feed=iex&symbols=${symbols.map(encodeURIComponent).join(",")}`, ALPACA_DATA_URL);
    const out: Record<string, number> = {};
    for (const [s, t] of Object.entries<any>(r?.trades ?? {})) if (t?.p) out[s] = Number(t.p);
    return out;
  }

  async submitOrder(req: OrderRequest): Promise<BrokerOrder> {
    try {
      const o = await this.call(ALPACA_PAPER_URL + "/v2/orders", {
        method: "POST",
        body: JSON.stringify({
          symbol: req.symbol,
          qty: String(req.qty),
          side: req.side,
          type: "market",
          time_in_force: "day",
          client_order_id: req.clientOrderId,
        }),
      });
      return toOrder(o);
    } catch (e) {
      if (e instanceof HttpError && e.status === 422 && /client_order_id/i.test(e.body)) {
        throw new DuplicateOrderError(`ordine ${req.clientOrderId} già presente sul broker`);
      }
      throw e;
    }
  }
}
