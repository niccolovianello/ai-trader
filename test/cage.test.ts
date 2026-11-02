import { describe, expect, test } from "bun:test";
import { applyCage, type CageInput } from "../src/cage.ts";
import type { Position, ProposedOrder } from "../src/types.ts";

const PRICES = { SPY: 670, QQQ: 600, NVDA: 185, GLD: 380, AAPL: 255, MSFT: 520, IWM: 245, TLT: 90 };

function pos(symbol: string, qty: number, entry: number, now: number): Position {
  return { symbol, qty, avgEntryPrice: entry, currentPrice: now, marketValue: qty * now, unrealizedPlPct: now / entry - 1 };
}

function input(orders: ProposedOrder[], over: Partial<CageInput> = {}): CageInput {
  return {
    decision: { orders, reasoning: "r", planNext: "p" },
    positions: [],
    account: { equity: 100_000, lastEquity: 100_000, cash: 100_000 },
    prices: PRICES,
    ordersAllowed: true,
    marketOpen: true,
    ...over,
  };
}

const buy = (symbol: string, qty: number): ProposedOrder => ({ symbol, side: "buy", qty, why: "test" });
const sell = (symbol: string, qty: number): ProposedOrder => ({ symbol, side: "sell", qty, why: "test" });

describe("gabbia", () => {
  test("accetta ordini dentro i limiti", () => {
    const r = applyCage(input([buy("SPY", 20), buy("QQQ", 10), buy("GLD", 25)]));
    expect(r.accepted.map((o) => o.symbol)).toEqual(["SPY", "QQQ", "GLD"]);
    expect(r.rejected).toHaveLength(0);
  });

  test("rifiuta un titolo fuori universo", () => {
    const r = applyCage(input([buy("TSLA", 1)]));
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]!.reason).toContain("universo");
  });

  test("rifiuta il 40% del conto su un titolo", () => {
    const r = applyCage(input([buy("SPY", 60)])); // 60 * 670 = 40.2%
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]!.reason).toContain("20,0%");
  });

  test("il 20% conta anche le azioni già in portafoglio (raddoppio NVDA)", () => {
    const positions = [pos("NVDA", 60, 185, 185)]; // 11.1%
    const r = applyCage(input([buy("NVDA", 60)], { positions })); // 120 * 185 = 22.2%
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/120 azioni sarebbero il 22,2%/);
  });

  test("massimo 5 titoli in portafoglio", () => {
    const positions = ["SPY", "QQQ", "GLD", "TLT", "IWM"].map((s) => pos(s, 1, PRICES[s as keyof typeof PRICES], PRICES[s as keyof typeof PRICES]));
    const r = applyCage(input([buy("AAPL", 1), buy("SPY", 1)], { positions }));
    expect(r.accepted.map((o) => o.symbol)).toEqual(["SPY"]);
    expect(r.rejected[0]!.reason).toContain("massimo 5");
  });

  test("una vendita completa libera un posto per un titolo nuovo", () => {
    const positions = ["SPY", "QQQ", "GLD", "TLT", "IWM"].map((s) => pos(s, 1, PRICES[s as keyof typeof PRICES], PRICES[s as keyof typeof PRICES]));
    const r = applyCage(input([buy("AAPL", 1), sell("TLT", 1)], { positions }));
    expect(r.accepted.map((o) => `${o.side}-${o.symbol}`)).toEqual(["sell-TLT", "buy-AAPL"]);
  });

  test("niente short: non si vende più di quanto si ha", () => {
    const r = applyCage(input([sell("SPY", 5)], { positions: [pos("SPY", 2, 670, 670)] }));
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]!.reason).toContain("short");
  });

  test("niente leva: non si compra oltre la liquidità", () => {
    const r = applyCage(input([buy("SPY", 25), buy("MSFT", 30)], { account: { equity: 100_000, lastEquity: 100_000, cash: 20_000 } }));
    expect(r.accepted.map((o) => o.symbol)).toEqual(["SPY"]);
    expect(r.rejected[0]!.reason).toContain("leva");
  });

  test("solo azioni intere e positive", () => {
    const r = applyCage(input([buy("SPY", 1.5), buy("QQQ", -3), buy("GLD", 0)]));
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected.map((x) => x.reason).every((s) => s.includes("quantità non valida"))).toBe(true);
  });

  test("nessun ordine nel briefing", () => {
    const r = applyCage(input([buy("SPY", 1)], { ordersAllowed: false }));
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]!.reason).toBe("nessun ordine nel briefing");
  });

  test("nessun ordine a mercato chiuso", () => {
    const r = applyCage(input([buy("SPY", 1)], { marketOpen: false }));
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]!.reason).toBe("mercato chiuso");
  });

  test("stop loss a -3% vende tutto anche se il modello dice di tenere", () => {
    const positions = [pos("NVDA", 30, 200, 192)]; // -4%
    const r = applyCage(input([], { positions }));
    expect(r.accepted).toEqual([expect.objectContaining({ symbol: "NVDA", side: "sell", qty: 30, forced: true })]);
  });

  test("stop loss gira anche senza cervello", () => {
    const positions = [pos("NVDA", 30, 200, 192)];
    const r = applyCage({ ...input([], { positions }), decision: null });
    expect(r.accepted[0]).toMatchObject({ symbol: "NVDA", forced: true });
  });

  test("a -2% lo stop non scatta", () => {
    const r = applyCage(input([], { positions: [pos("NVDA", 30, 200, 196)] }));
    expect(r.accepted).toHaveLength(0);
  });

  test("il modello non può ricomprare un titolo appena venduto dallo stop", () => {
    const r = applyCage(input([buy("NVDA", 5)], { positions: [pos("NVDA", 30, 200, 192)] }));
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected[0]!.reason).toContain("stop loss attivo");
  });

  test("doppione nella stessa decisione rifiutato", () => {
    const r = applyCage(input([buy("SPY", 1), buy("SPY", 2)]));
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected[0]!.reason).toContain("doppione");
  });
});
