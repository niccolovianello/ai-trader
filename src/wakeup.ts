import { applyCage } from "./cage.ts";
import { BROKER, CAGE, type Slot } from "./config.ts";
import { type Broker, BrokerUnreachableError, DuplicateOrderError } from "./broker/types.ts";
import { usd } from "./format.ts";
import type { Brain } from "./llm.ts";
import type { LockInfo, LockResult } from "./lock.ts";
import type { Logger } from "./log.ts";
import type { Notifier } from "./notify.ts";
import { reconcile } from "./reconcile.ts";
import { nextRunAfter, runIdsBetween } from "./slots.ts";
import type { Store } from "./store/types.ts";
import { prettyRun, runIdOf } from "./time.ts";
import type { Account, Baton, CagedOrder, Decision, Position, SubmittedOrder } from "./types.ts";

export interface WakeupDeps {
  store: Store;
  broker: Broker;
  brain: Brain;
  notifier: Notifier;
  log: Logger;
  now: () => Date;
  pid?: number;
  /** Waits between fill checks; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

export interface WakeupOptions {
  date: string; // YYYY-MM-DD, Rome
  slot: Slot;
  force?: boolean;
}

export interface WakeupResult {
  status: "done" | "already-done" | "busy" | "error";
  runId: string;
  baton?: Baton;
}

export const orderIdOf = (runId: string, symbol: string, side: string) => `${runId}-${symbol}-${side}`;

export async function wakeup(deps: WakeupDeps, opts: WakeupOptions): Promise<WakeupResult> {
  const { store, broker, brain, notifier, log } = deps;
  const pid = deps.pid ?? process.pid;
  const runId = runIdOf(opts.date, opts.slot.hhmm);
  const tag = `· run ${runId}`;

  const me: LockInfo = { runId, pid, startedAt: deps.now().toISOString(), holder: crypto.randomUUID() };
  let lock: LockResult;
  try {
    lock = await store.acquireLock(me, deps.now());
  } catch (e) {
    const cause = `stato (${store.kind}) non raggiungibile: ${(e as Error).message}`;
    log.line("errore", cause);
    await notifier.send(`❌ Sveglia non partita · ${opts.slot.name}\nCausa: ${cause}\nNessun ordine inviato.\n${tag}`);
    return { status: "error", runId };
  }
  if (!lock.ok) {
    log.line("lucchetto", `occupato da run ${lock.holder?.runId ?? "?"} (pid ${lock.holder?.pid ?? "?"}): esco senza fare niente`);
    return { status: "busy", runId };
  }

  const alerts: string[] = [];
  const alert = async (text: string) => {
    alerts.push(text);
    log.line("allarme", text);
    await notifier.send(`⚠ ${text}\n${tag}`);
  };

  try {
    // 1. A lock left behind means the previous run died halfway: ask the broker what really went out.
    if (lock.stale) {
      try {
        const r = await reconcile(broker, lock.stale, deps.now());
        await alert(`Sveglia precedente interrotta (run ${r.runId}). Sul broker: ${r.summary}.`);
      } catch (e) {
        await alert(`Sveglia precedente interrotta (run ${lock.stale.runId}), riconciliazione impossibile: ${(e as Error).message}`);
      }
    }

    // 2. The baton: the previous run's intentions.
    const { baton: prev, corrupted } = await store.readBaton();
    if (corrupted) log.line("testimone", "illeggibile: vale come nessun testimone, riparto dal broker");
    if (prev && prev.runId >= runId && !opts.force) {
      log.line("sveglia", `${runId} già fatta (ultimo testimone ${prev.runId}): niente da fare. Usa --force per rifarla.`);
      return { status: "already-done", runId, baton: prev };
    }
    const missed = prev ? runIdsBetween(prev.runId, runId) : [];
    if (missed.length) {
      await alert(`Sveglie saltate (macchina spenta o offline): ${missed.map(prettyRun).join(", ")}. Non le recupero: un ordine di ore fa non ha più senso.`);
    }

    log.line("sveglia", `${runId} · ${opts.slot.name} · cervello: ${brain.kind} · broker: ${broker.kind}`);
    await notifier.send(`▶ Sveglia ${prettyRun(runId)} · ${opts.slot.name}\n${tag}`);

    // 3. The broker: the truth about the money.
    let account: Account, positions: Position[], marketOpen: boolean;
    let recent;
    try {
      [account, positions, recent, { isOpen: marketOpen }] = await Promise.all([
        broker.getAccount(),
        broker.getPositions(),
        broker.getOrdersSince(new Date(deps.now().getTime() - BROKER.recentOrdersHours * 3600_000)),
        broker.getClock(),
      ]);
    } catch (e) {
      return await fail(deps, opts, runId, prev, alerts, `broker non disponibile: ${(e as Error).message}`);
    }
    log.line("broker", `equity ${usd(account.equity)} · ${positions.length} posizioni · ${recent.length} ordini 48h · mercato ${marketOpen ? "aperto" : "chiuso"}`);

    // Latest prices for the whole universe: the brain sizes orders on them, the cage checks weights.
    const prices: Record<string, number> = {};
    try {
      Object.assign(prices, await broker.getLatestPrices(CAGE.universe));
    } catch (e) {
      log.line("broker", `prezzi non disponibili: ${(e as Error).message}`);
    }
    for (const p of positions) prices[p.symbol] ??= p.currentPrice;

    // 4. The brain proposes.
    let decision: Decision | null = null;
    let brainState: Baton["brain"] = brain.kind === "finto" ? "finto" : "ok";
    try {
      decision = await brain.decide({
        runId, slotName: opts.slot.name, ordersAllowed: opts.slot.ordersAllowed, marketOpen,
        baton: prev, account, positions, recentOrders: recent, prices,
      });
      log.line("cervello", `${decision.orders.length} ordini proposti · ${decision.reasoning.slice(0, 100)}`);
    } catch (e) {
      brainState = "non disponibile";
      await alert(`Cervello non disponibile: applico solo lo stop loss. (${(e as Error).message})`);
    }

    // 5. The cage disposes.
    const caged = applyCage({ decision, positions, account, prices, ordersAllowed: opts.slot.ordersAllowed, marketOpen });
    log.line("gabbia", [
      ...caged.accepted.map((o) => `ok ${o.side} ${o.qty} ${o.symbol}${o.forced ? " (stop)" : ""}`),
      ...caged.rejected.map((r) => `no ${r.order.side} ${r.order.qty} ${r.order.symbol}: ${r.reason}`),
    ].join(" · ") || "nessun ordine");

    // 6. Send, each with a deterministic id so the broker itself refuses a duplicate.
    const sent: SubmittedOrder[] = [];
    for (const o of caged.accepted) sent.push(await submit(deps, runId, o, alert));
    await waitForFills(deps, sent);

    // 7. The new baton, written atomically.
    let after = account;
    try {
      after = await broker.getAccount();
    } catch {}
    let afterPositions = positions;
    try {
      afterPositions = await broker.getPositions();
    } catch {}
    const reasoning = decision?.reasoning ?? "Cervello non disponibile: applico solo lo stop loss.";
    const planNext = decision?.planNext ?? prev?.planNext ?? "Ricontrollare conto e posizioni.";
    const baton: Baton = {
      version: 1,
      runId,
      slot: opts.slot.hhmm,
      slotName: opts.slot.name,
      runAt: deps.now().toISOString(),
      status: "ok",
      brain: brainState,
      orders: sent,
      rejected: caged.rejected.map((r) => ({ symbol: r.order.symbol, side: r.order.side, qty: r.order.qty, reason: r.reason })),
      reasoning,
      planNext,
      equity: after.equity,
      dayPnl: after.equity - after.lastEquity,
      positions: afterPositions.map((p) => ({ symbol: p.symbol, qty: p.qty, avgEntryPrice: p.avgEntryPrice, marketValue: p.marketValue, unrealizedPlPct: p.unrealizedPlPct })),
      alerts,
      nextRun: nextRunAfter(runId),
    };
    await store.writeBaton(baton);
    log.line("testimone", `scritto · prossima sveglia ${baton.nextRun ? prettyRun(baton.nextRun) : "?"}`);

    // 8. Report.
    await notifier.send(report(baton, caged.deferredStops));
    return { status: "done", runId, baton };
  } catch (e) {
    return await fail(deps, opts, runId, (await store.readBaton().catch(() => ({ baton: null }))).baton, alerts, `errore imprevisto: ${(e as Error).message}`);
  } finally {
    await store.releaseLock(me).catch((e) => log.line("lucchetto", `rilascio fallito: ${(e as Error).message}`));
  }
}

/** Alpaca statuses of an order that can still fill. */
const OPEN_STATUSES = new Set(["pending_new", "accepted", "new", "partially_filled", "accepted_for_bidding", "calculated"]);

/**
 * A market order is usually filled a second after it is sent, but the positions are read right after: wait a little,
 * so the baton (and the dashboard) shows what was bought. Updates each order's status; never fails the wakeup.
 */
async function waitForFills(deps: WakeupDeps, sent: SubmittedOrder[]) {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  let open = sent.filter((o) => o.outcome === "inviato" && o.status && OPEN_STATUSES.has(o.status));
  for (let waited = 0; open.length && waited < BROKER.fillWaitMs; waited += BROKER.fillPollMs) {
    await sleep(BROKER.fillPollMs);
    try {
      for (const o of open) {
        const found = await deps.broker.getOrderByClientId(o.clientOrderId);
        if (found) o.status = found.status;
      }
    } catch (e) {
      deps.log.line("ordine", `controllo esecuzione fallito (${(e as Error).message}): salvo le posizioni come sono`);
      return;
    }
    open = open.filter((o) => OPEN_STATUSES.has(o.status!));
  }
  if (open.length) deps.log.line("ordine", `ancora da eseguire dopo ${BROKER.fillWaitMs / 1000}s: ${open.map((o) => `${o.clientOrderId} (${o.status})`).join(", ")}`);
}

async function submit(
  deps: WakeupDeps,
  runId: string,
  o: CagedOrder,
  alert: (t: string) => Promise<void>,
): Promise<SubmittedOrder> {
  const { broker, log } = deps;
  const clientOrderId = orderIdOf(runId, o.symbol, o.side);
  const rec: SubmittedOrder = { clientOrderId, symbol: o.symbol, side: o.side, qty: o.qty, why: o.why, forced: !!o.forced, outcome: "non partito" };

  // The market can close while the brain is thinking: check again right before each order.
  try {
    if (!(await broker.getClock()).isOpen) {
      log.line("ordine", `${clientOrderId}: mercato chiuso nel frattempo, non inviato`);
      return { ...rec, outcome: "mercato chiuso" };
    }
  } catch (e) {
    log.line("ordine", `${clientOrderId}: orologio non disponibile, non inviato (${(e as Error).message})`);
    return { ...rec, error: (e as Error).message };
  }

  try {
    const existing = await broker.getOrderByClientId(clientOrderId);
    if (existing) {
      log.line("ordine", `${clientOrderId}: già presente sul broker (${existing.status}), non lo rimando`);
      return { ...rec, outcome: "già presente", status: existing.status };
    }
  } catch (e) {
    // Not fatal: the deterministic id still makes the broker refuse a duplicate.
    log.line("ordine", `${clientOrderId}: controllo preventivo fallito (${(e as Error).message}), invio comunque`);
  }

  try {
    const r = await broker.submitOrder({ symbol: o.symbol, side: o.side, qty: o.qty, clientOrderId });
    log.line("ordine", `inviato ${clientOrderId} · ${o.qty} az. · ${r.status}`);
    return { ...rec, outcome: "inviato", status: r.status };
  } catch (e) {
    if (e instanceof DuplicateOrderError) {
      log.line("ordine", `${clientOrderId}: il broker l'aveva già, rifiutato come doppione`);
      return { ...rec, outcome: "già presente" };
    }
    if (!(e instanceof BrokerUnreachableError)) {
      log.line("ordine", `${clientOrderId}: rifiutato dal broker: ${(e as Error).message}`);
      return { ...rec, error: (e as Error).message };
    }
    // The request may have arrived even though the answer was lost: ask the broker by id.
    try {
      const found = await broker.getOrderByClientId(clientOrderId);
      if (found) {
        log.line("ordine", `${clientOrderId}: risposta persa ma l'ordine è arrivato (${found.status})`);
        return { ...rec, outcome: "inviato", status: found.status };
      }
      log.line("ordine", `${clientOrderId}: non arrivato al broker (${(e as Error).message})`);
      return { ...rec, error: (e as Error).message };
    } catch (e2) {
      await alert(`Ordine dall'esito sconosciuto: ${o.side} ${o.qty} ${o.symbol} (${clientOrderId}). Controllalo su Alpaca.`);
      return { ...rec, outcome: "esito sconosciuto", error: (e2 as Error).message };
    }
  }
}

async function fail(
  deps: WakeupDeps,
  opts: WakeupOptions,
  runId: string,
  prev: Baton | null,
  alerts: string[],
  cause: string,
): Promise<WakeupResult> {
  deps.log.line("errore", cause);
  const baton: Baton = {
    version: 1,
    runId,
    slot: opts.slot.hhmm,
    slotName: opts.slot.name,
    runAt: deps.now().toISOString(),
    status: "error",
    brain: "non disponibile",
    orders: [],
    rejected: [],
    reasoning: `Sveglia fallita: ${cause}`,
    planNext: prev?.planNext ?? "Ricontrollare conto e posizioni.",
    equity: prev?.equity ?? null,
    dayPnl: null,
    positions: prev?.positions ?? [],
    alerts: [...alerts, cause],
    nextRun: nextRunAfter(runId),
  };
  try {
    await deps.store.writeBaton(baton);
  } catch (e) {
    deps.log.line("errore", `testimone non scritto: ${(e as Error).message}`);
  }
  await deps.notifier.send(`❌ Sveglia fallita · ${opts.slot.name}\nCausa: ${cause}\nNessun ordine inviato.\n· run ${runId}`);
  return { status: "error", runId, baton };
}

function describe(o: SubmittedOrder) {
  return `${o.side === "buy" ? "comprato" : "venduto"} ${o.qty} ${o.symbol} (${o.why})`;
}

export function report(b: Baton, deferredStops: string[] = []): string {
  const ok = b.orders.filter((o) => o.outcome === "inviato");
  const dup = b.orders.filter((o) => o.outcome === "già presente");
  const notSent = b.orders.filter((o) => o.outcome !== "inviato" && o.outcome !== "già presente");
  const lines = [`✅ Fatto · ${b.slotName}`, `Ordini: ${ok.length ? ok.map(describe).join("; ") : "nessuno"}`];
  if (dup.length) lines.push(`Già sul broker, non rimandati: ${dup.map((o) => `${o.side} ${o.qty} ${o.symbol}`).join("; ")}`);
  if (notSent.length) lines.push(`Non partiti: ${notSent.map((o) => `${o.side} ${o.qty} ${o.symbol} (${o.outcome}${o.error ? `: ${o.error}` : ""})`).join("; ")}`);
  if (b.rejected.length) lines.push(`Rifiutati dalla gabbia: ${b.rejected.map((r) => `${r.side} ${r.qty} ${r.symbol} (${r.reason})`).join("; ")}`);
  if (deferredStops.length) lines.push(`Stop loss scattato ma nessun ordine possibile ora: ${deferredStops.join(", ")}. Si vende alla prossima sveglia a mercato aperto.`);
  lines.push(`Perché: ${b.reasoning}`);
  lines.push(`Prossima mossa: ${b.planNext}`);
  if (b.equity !== null) lines.push(`P&L giorno: ${usd(b.dayPnl ?? 0)} · conto ${usd(b.equity)}`);
  if (b.nextRun) lines.push(`Prossima sveglia: ${prettyRun(b.nextRun)}`);
  lines.push(`· run ${b.runId}`);
  return lines.join("\n");
}
