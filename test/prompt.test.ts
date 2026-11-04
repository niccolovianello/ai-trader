import { describe, expect, test } from "bun:test";
import { buildPrompt, type BrainInput } from "../src/llm.ts";
import type { Baton } from "../src/types.ts";

function baton(over: Partial<Baton> = {}): Baton {
  return {
    version: 1,
    runId: "2026-11-04-1540",
    slot: "1540",
    slotName: "apertura",
    runAt: "2026-11-04T14:40:50.000Z",
    status: "ok",
    brain: "ok",
    orders: [],
    rejected: [],
    reasoning: "Compro SPY.",
    planNext: "Controllare SPY.",
    equity: 100_000,
    dayPnl: 0,
    positions: [],
    alerts: [],
    nextRun: null,
    ...over,
  };
}

function input(b: Baton | null): BrainInput {
  return {
    runId: "2026-11-04-1830",
    slotName: "metà seduta",
    ordersAllowed: true,
    marketOpen: true,
    baton: b,
    account: { equity: 100_000, lastEquity: 100_000, cash: 70_000 },
    positions: [],
    recentOrders: [],
    prices: { SPY: 760 },
  };
}

describe("prompt", () => {
  test("mostra al cervello gli ordini rifiutati dalla sveglia precedente, con il motivo", () => {
    const reason = "oltre il 20,0% del conto per titolo: 30 azioni sarebbero il 22,9%";
    const p = buildPrompt(input(baton({ rejected: [{ symbol: "SPY", side: "buy", qty: 30, reason }] })));
    expect(p).toContain("Rifiutati");
    expect(p).toContain(`buy 30 SPY → ${reason}`);
  });

  test("nessuna riga sui rifiuti se non ce ne sono, o se il testimone è vecchio e non ha il campo", () => {
    expect(buildPrompt(input(baton()))).not.toContain("Rifiutati");
    const old = baton();
    delete (old as Partial<Baton>).rejected;
    expect(buildPrompt(input(old))).not.toContain("Rifiutati");
    expect(buildPrompt(input(null))).not.toContain("Rifiutati");
  });
});
