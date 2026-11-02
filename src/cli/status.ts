// bun run status [--fake] — lock, last baton, next wakeup, account.
import { PROJECT_ROOT } from "../config.ts";
import { percent, usd } from "../format.ts";
import { loadKeys } from "../keys.ts";
import { buildRuntime, buildStore, parseFlags, projectPaths } from "../runtime.ts";
import { nextRunAfter } from "../slots.ts";
import { localParts, prettyRun, runIdOf } from "../time.ts";

const flags = parseFlags(process.argv.slice(2));
const now = new Date();
const store = buildStore(projectPaths(flags), await loadKeys(PROJECT_ROOT), flags.fake);
console.log(`stato           ${store.kind}`);

const l = await store.readLock(now);
console.log(`lock            ${!l ? "nessuno" : `run ${l.lock.runId} · ${l.alive ? "in corso" : "MORTA A METÀ (la prossima sveglia riconcilia)"}`}`);

const { baton, corrupted } = await store.readBaton();
if (corrupted) console.log("testimone       illeggibile (vale come nessuno)");
else if (!baton) console.log("testimone       nessuno");
else {
  console.log(`testimone       run ${baton.runId} · ${baton.slotName} · ${baton.status} · cervello ${baton.brain}`);
  console.log(`  ordini        ${baton.orders.map((o) => `${o.side} ${o.qty} ${o.symbol} (${o.outcome})`).join("; ") || "nessuno"}`);
  console.log(`  prossima mossa ${baton.planNext}`);
}

const p = localParts(now);
const next = nextRunAfter(baton && baton.runId > runIdOf(p.date, p.hhmm) ? baton.runId : runIdOf(p.date, p.hhmm));
console.log(`prossima       ${next ? prettyRun(next) : "?"}`);

try {
  const rt = await buildRuntime(flags, "status", () => now);
  const [a, ps, c] = await Promise.all([rt.broker.getAccount(), rt.broker.getPositions(), rt.broker.getClock()]);
  console.log(`conto (${rt.broker.kind})  equity ${usd(a.equity)} · liquidità ${usd(a.cash)} · P&L giorno ${usd(a.equity - a.lastEquity)} · mercato ${c.isOpen ? "aperto" : "chiuso"}`);
  for (const x of ps) console.log(`  ${x.symbol.padEnd(5)} ${String(x.qty).padStart(5)} az. · ${usd(x.marketValue)} · ${percent(x.unrealizedPlPct)}`);
} catch (e) {
  console.log(`conto           non disponibile: ${(e as Error).message}`);
}
