import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { readBaton } from "../src/baton.ts";
import { FAKE_DECISION } from "../src/llm.ts";
import { DAY, deadPid, harness } from "./helpers.ts";

const ordersOn = (h: ReturnType<typeof harness>) => h.broker.read().orders;
const all = (h: ReturnType<typeof harness>) => h.notifier.sent.join("\n");

describe("idempotenza degli ordini", () => {
  test("stessa sveglia lanciata due volte → un solo ordine per titolo", async () => {
    const h = harness();
    expect((await h.run("1540")).status).toBe("done");
    expect((await h.run("1540")).status).toBe("already-done");
    expect(ordersOn(h).map((o) => o.clientOrderId)).toEqual([
      `${DAY}-1540-SPY-buy`, `${DAY}-1540-QQQ-buy`, `${DAY}-1540-GLD-buy`,
    ]);
  });

  test("--force rifà la sveglia ma gli id impediscono i doppioni", async () => {
    const h = harness();
    await h.run("1540");
    const r = await h.run("1540", { force: true });
    expect(r.status).toBe("done");
    expect(ordersOn(h)).toHaveLength(3);
    expect(r.baton!.orders.every((o) => o.outcome === "già presente")).toBe(true);
  });
});

describe("sveglie saltate", () => {
  test("testimone delle 09:00 e poi niente fino alle 21:40 → segnala 15:40 e 18:30", async () => {
    const h = harness();
    await h.run("0900");
    const r = await h.run("2140");
    const alert = h.notifier.sent.find((m) => m.includes("Sveglie saltate"))!;
    expect(alert).toContain(`${DAY} 15:40`);
    expect(alert).toContain(`${DAY} 18:30`);
    expect(alert).not.toContain("21:40");
    expect(r.baton!.alerts.some((a) => a.includes("Sveglie saltate"))).toBe(true);
  });

  test("nessun allarme se la sveglia prima è quella giusta", async () => {
    const h = harness();
    await h.run("0900");
    await h.run("1540");
    expect(all(h)).not.toContain("saltate");
  });
});

describe("la gabbia dentro la sveglia", () => {
  test("titolo fuori universo e 40% del conto → rifiutati, nessun ordine", async () => {
    const h = harness();
    const r = await h.run("1540", {
      brain: () => ({ ...FAKE_DECISION, orders: [{ symbol: "TSLA", side: "buy", qty: 1, why: "x" }, { symbol: "SPY", side: "buy", qty: 60, why: "x" }] }),
    });
    expect(ordersOn(h)).toHaveLength(0);
    expect(r.baton!.rejected.map((x) => x.symbol)).toEqual(["TSLA", "SPY"]);
    expect(all(h)).toContain("Rifiutati dalla gabbia");
  });

  test("posizione a -4% → la gabbia la vende anche se il modello dice di tenere", async () => {
    const h = harness({ state: { positions: { NVDA: { qty: 30, avgEntryPrice: 200 } }, prices: { NVDA: 192, SPY: 670 } } });
    const r = await h.run("1830", { brain: () => ({ orders: [], reasoning: "Tengo NVDA, la tesi regge.", planNext: "p" }) });
    expect(ordersOn(h)).toEqual([expect.objectContaining({ symbol: "NVDA", side: "sell", qty: 30 })]);
    expect(r.baton!.orders[0]).toMatchObject({ forced: true, outcome: "inviato" });
    expect(all(h)).toContain("venduto 30 NVDA (stop loss: −4,0% dal carico)");
  });

  test("il briefing non manda ordini ma scrive il piano", async () => {
    const h = harness();
    const r = await h.run("0900");
    expect(ordersOn(h)).toHaveLength(0);
    expect(r.baton!.planNext).toBe(FAKE_DECISION.planNext);
    expect(r.baton!.nextRun).toBe(`${DAY}-1540`);
  });
});

describe("testimone", () => {
  test("testimone corrotto → vale come nessun testimone, la sveglia va avanti col broker", async () => {
    const h = harness();
    writeFileSync(h.paths.baton, '{"version":1,"runId":"2026-10-05-09');
    const r = await h.run("1540");
    expect(r.status).toBe("done");
    expect(ordersOn(h)).toHaveLength(3);
    expect(readBaton(h.paths.baton).baton!.runId).toBe(`${DAY}-1540`);
  });

  test("il testimone ha una copia nello storico", async () => {
    const h = harness();
    await h.run("1540");
    expect(existsSync(`${h.paths.history}/${DAY}-1540.json`)).toBe(true);
  });

  test("la sveglia dopo riceve il testimone della sveglia prima", async () => {
    const h = harness();
    await h.run("0900");
    let seen: string | undefined;
    await h.run("1540", { brain: (i) => { seen = i.baton?.planNext; return FAKE_DECISION; } });
    expect(seen).toBe(FAKE_DECISION.planNext);
  });
});

describe("cervello", () => {
  test("se il cervello cade, la sveglia finisce lo stesso, applica solo lo stop e lo dice", async () => {
    const h = harness({ state: { positions: { NVDA: { qty: 30, avgEntryPrice: 200 } }, prices: { NVDA: 190 } } });
    const r = await h.run("1830", { brain: () => { throw new Error("timeout"); } });
    expect(r.status).toBe("done");
    expect(r.baton!.brain).toBe("non disponibile");
    expect(ordersOn(h).map((o) => `${o.side} ${o.symbol}`)).toEqual(["sell NVDA"]);
    expect(all(h)).toContain("Cervello non disponibile: applico solo lo stop loss");
  });

  test("JSON troncato → cervello non disponibile, nessun ordine nuovo", async () => {
    const h = harness();
    const r = await h.run("1540", { brain: () => '{"orders":[{"symbol":"SPY","side":"buy","qty":20' });
    expect(r.baton!.brain).toBe("non disponibile");
    expect(ordersOn(h)).toHaveLength(0);
  });

  test("campo mancante → cervello non disponibile", async () => {
    const h = harness();
    const r = await h.run("1540", { brain: () => ({ orders: [{ symbol: "SPY", side: "buy", qty: 1, why: "" }], planNext: "x" }) });
    expect(r.baton!.brain).toBe("non disponibile");
    expect(ordersOn(h)).toHaveLength(0);
  });

  test("quantità negativa → rifiutato solo quell'ordine", async () => {
    const h = harness();
    const r = await h.run("1540", {
      brain: () => ({ ...FAKE_DECISION, orders: [{ symbol: "SPY", side: "buy", qty: -20, why: "x" }, { symbol: "GLD", side: "buy", qty: 5, why: "x" }] }),
    });
    expect(ordersOn(h).map((o) => o.symbol)).toEqual(["GLD"]);
    expect(r.baton!.rejected[0]!.reason).toContain("quantità non valida");
  });
});

describe("broker", () => {
  test("risposta persa dopo l'invio → l'ordine si ricontrolla per id e risulta inviato", async () => {
    const h = harness({ faults: { loseSubmitResponse: true } });
    const r = await h.run("1540");
    expect(ordersOn(h)).toHaveLength(3);
    expect(r.baton!.orders.every((o) => o.outcome === "inviato")).toBe(true);
    h.broker.faults = {};
    await h.run("1540", { force: true });
    expect(ordersOn(h)).toHaveLength(3);
  });

  test("risposta persa e broker irraggiungibile anche dopo → esito sconosciuto con allarme", async () => {
    const h = harness({ faults: { loseSubmitResponse: true } });
    const r = await h.run("1540", {
      brain: () => { h.broker.faults.lookupUnreachable = true; return FAKE_DECISION; },
    });
    expect(r.baton!.orders.every((o) => o.outcome === "esito sconosciuto")).toBe(true);
    expect(all(h)).toContain("esito sconosciuto");
  });

  test("broker giù → la sveglia fallisce pulita: testimone di errore, ❌, lock rilasciato", async () => {
    const h = harness({ faults: { unreachable: true } });
    const r = await h.run("1540");
    expect(r.status).toBe("error");
    expect(readBaton(h.paths.baton).baton!.status).toBe("error");
    expect(all(h)).toContain("❌ Sveglia fallita");
    expect(existsSync(h.paths.lock)).toBe(false);
  });
});

describe("orologio", () => {
  test("la sveglia delle 21:40 parte alle 22:05 → mercato chiuso, nessun ordine", async () => {
    const h = harness();
    const r = await h.run("2140", { at: "2205" });
    expect(ordersOn(h)).toHaveLength(0);
    expect(r.baton!.rejected.every((x) => x.reason === "mercato chiuso")).toBe(true);
  });

  test("il mercato chiude mentre il cervello pensa → il controllo prima di ogni invio lo ferma", async () => {
    const h = harness();
    const r = await h.run("2140", {
      at: "2159",
      brain: () => { h.clock.now = new Date(h.clock.now.getTime() + 6 * 60_000); return FAKE_DECISION; },
    });
    expect(ordersOn(h)).toHaveLength(0);
    expect(r.baton!.orders.every((o) => o.outcome === "mercato chiuso")).toBe(true);
  });
});

describe("lucchetto", () => {
  test("lock di una sveglia morta → riconcilia, avvisa, lavora", async () => {
    const h = harness();
    await h.run("1540"); // 3 orders on the broker
    writeFileSync(h.paths.lock, JSON.stringify({ runId: `${DAY}-1830`, pid: await deadPid(), startedAt: h.clock.now.toISOString() }));
    const r = await h.run("1830", { brain: () => ({ orders: [], reasoning: "tengo", planNext: "p" }) });
    expect(r.status).toBe("done");
    expect(all(h)).toContain(`Sveglia precedente interrotta (run ${DAY}-1830)`);
    expect(existsSync(h.paths.lock)).toBe(false);
  });

  test("lock di una sveglia viva → esco senza fare niente", async () => {
    const h = harness();
    writeFileSync(h.paths.lock, JSON.stringify({ runId: `${DAY}-1540`, pid: process.pid, startedAt: h.clock.now.toISOString() }));
    const r = await h.run("1540", { pid: process.pid + 1 });
    expect(r.status).toBe("busy");
    expect(ordersOn(h)).toHaveLength(0);
    expect(existsSync(h.paths.lock)).toBe(true);
  });
});

describe("messaggi", () => {
  test("ogni messaggio porta l'id della sveglia; il resoconto ha tutte le righe", async () => {
    const h = harness();
    await h.run("1540");
    expect(h.notifier.sent.every((m) => m.includes(`· run ${DAY}-1540`))).toBe(true);
    const done = h.notifier.sent.at(-1)!;
    for (const k of ["✅ Fatto · apertura", "Ordini: comprato 20 SPY", "Perché:", "Prossima mossa:", "P&L giorno:", "Prossima sveglia: 2026-10-05 18:30"]) {
      expect(done).toContain(k);
    }
  });
});
