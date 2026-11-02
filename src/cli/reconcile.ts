// bun run reconcile [--fake] — by hand: what did the interrupted (or last) run really send?
import { reconcile } from "../reconcile.ts";
import { buildRuntime, parseFlags } from "../runtime.ts";

const flags = parseFlags(process.argv.slice(2));
const now = new Date();
const rt = await buildRuntime(flags, "reconcile", () => now);

const l = await rt.store.readLock(now);
const baton = (await rt.store.readBaton()).baton;
const target = l?.lock ?? (baton ? { runId: baton.runId, pid: 0, startedAt: baton.runAt } : null);
if (!target) {
  console.log("Nessun lock e nessun testimone: niente da riconciliare.");
  process.exit(0);
}

const r = await reconcile(rt.broker, target, now);
console.log(`${l ? (l.alive ? "Sveglia in corso" : "Sveglia interrotta") : "Ultima sveglia"} run ${r.runId}: ${r.summary}`);
if (l && !l.alive) console.log("Il lock resta: la prossima sveglia lo trova, riconcilia e lo sostituisce.");
