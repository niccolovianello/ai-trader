import { CAGE } from "./config.ts";
import { percent } from "./format.ts";
import type { Account, CagedOrder, Decision, Position, ProposedOrder, RejectedOrder } from "./types.ts";

export interface CageInput {
  decision: Decision | null; // null = brain unavailable: only the stop loss runs
  positions: Position[];
  account: Account;
  prices: Record<string, number>;
  ordersAllowed: boolean; // false for the briefing slot
  marketOpen: boolean;
}

export interface CageResult {
  accepted: CagedOrder[]; // forced stop-loss sells first, then model sells, then model buys
  rejected: RejectedOrder[];
  /** Stop loss triggered but no order can go out now (briefing / market closed). */
  deferredStops: string[];
}

/** The model proposes, the code disposes. Pure function: no I/O. */
export function applyCage(input: CageInput, cage = CAGE): CageResult {
  const proposed = input.decision?.orders ?? [];
  const rejected: RejectedOrder[] = [];
  const triggered = input.positions.filter((p) => p.qty > 0 && p.unrealizedPlPct <= cage.stopLossPct);

  if (!input.ordersAllowed || !input.marketOpen) {
    const reason = !input.ordersAllowed ? "nessun ordine nel briefing" : "mercato chiuso";
    return {
      accepted: [],
      rejected: proposed.map((order) => ({ order, reason })),
      deferredStops: triggered.map((p) => p.symbol),
    };
  }

  const accepted: CagedOrder[] = triggered.map((p) => ({
    symbol: p.symbol,
    side: "sell",
    qty: p.qty,
    why: `stop loss: ${percent(p.unrealizedPlPct)} dal carico`,
    forced: true,
  }));
  const stopped = new Set(triggered.map((p) => p.symbol));
  const held = new Map(input.positions.filter((p) => !stopped.has(p.symbol)).map((p) => [p.symbol, p.qty]));
  const seen = new Set<string>();
  let cash = input.account.cash;

  const reject = (order: ProposedOrder, reason: string) => rejected.push({ order, reason });
  const ordered = [...proposed.filter((o) => o.side === "sell"), ...proposed.filter((o) => o.side === "buy")];

  for (const o of ordered) {
    const key = `${o.symbol}-${o.side}`;
    if (!cage.universe.includes(o.symbol)) { reject(o, "fuori dall'universo ammesso"); continue; }
    if (!Number.isInteger(o.qty) || o.qty <= 0) { reject(o, `quantità non valida (${o.qty}): solo azioni intere positive`); continue; }
    if (seen.has(key)) { reject(o, "doppione nella stessa sveglia"); continue; }
    if (stopped.has(o.symbol)) { reject(o, "stop loss attivo su questo titolo"); continue; }
    seen.add(key);

    if (o.side === "sell") {
      const h = held.get(o.symbol) ?? 0;
      if (o.qty > h) { reject(o, `niente short: in portafoglio ${h} az.`); continue; }
      h - o.qty > 0 ? held.set(o.symbol, h - o.qty) : held.delete(o.symbol);
      accepted.push(o);
      continue;
    }

    const price = input.prices[o.symbol];
    if (!price) { reject(o, "prezzo non disponibile"); continue; }
    const h = held.get(o.symbol) ?? 0;
    if (h === 0 && held.size >= cage.maxPositions) { reject(o, `massimo ${cage.maxPositions} titoli in portafoglio`); continue; }
    const weight = ((h + o.qty) * price) / input.account.equity;
    if (weight > cage.maxWeightPerSymbol) {
      reject(o, `oltre il ${percent(cage.maxWeightPerSymbol)} del conto per titolo: ${h + o.qty} azioni sarebbero il ${percent(weight)}`);
      continue;
    }
    const cost = o.qty * price;
    if (cost > cash) { reject(o, "niente leva: liquidità insufficiente"); continue; }
    cash -= cost;
    held.set(o.symbol, h + o.qty);
    accepted.push(o);
  }

  return { accepted, rejected, deferredStops: [] };
}
