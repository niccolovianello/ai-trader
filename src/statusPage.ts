import { ALPACA_DASHBOARD_URL, CLOUD } from "./config.ts";
import { percent, usd } from "./format.ts";
import { buildRuntime, type Flags } from "./runtime.ts";
import { nextRunAfter } from "./slots.ts";
import type { Store } from "./store/types.ts";
import { localParts, prettyRun, runIdOf } from "./time.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function sparkline(values: number[]): string {
  if (values.length < 2) return "<p class=muted>La curva compare dopo due sveglie.</p>";
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 600).toFixed(1)},${(110 - ((v - min) / span) * 100).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 600 120" class=curve role=img aria-label="curva dell'equity"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2"/></svg>
  <p class=muted>${usd(min)} – ${usd(max)}</p>`;
}

/** Read-only page on the scheduler's port. Keys are never read here, only the broker results. */
export function startStatusPage(store: Store, flags: Flags, port: number) {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch() {
      const now = new Date();
      const [{ baton }, lock, hist] = await Promise.all([store.readBaton(), store.readLock(now), store.history(CLOUD.historyLimit)]);
      const p = localParts(now);
      const next1 = nextRunAfter(runIdOf(p.date, p.hhmm));
      const next2 = next1 ? nextRunAfter(next1) : null;

      let account = "<p class=muted>non disponibile</p>";
      try {
        const rt = await buildRuntime(flags, "status-page", () => now);
        const [a, ps] = await Promise.all([rt.broker.getAccount(), rt.broker.getPositions()]);
        account = `<p class=big>${usd(a.equity)}</p><p>liquidità ${usd(a.cash)} · P&amp;L giorno ${usd(a.equity - a.lastEquity)} · broker ${rt.broker.kind}</p>
          <table><tr><th>Titolo</th><th>Az.</th><th>Valore</th><th>Dal carico</th></tr>${ps
            .map((x) => `<tr><td>${esc(x.symbol)}</td><td>${x.qty}</td><td>${usd(x.marketValue)}</td><td>${percent(x.unrealizedPlPct)}</td></tr>`)
            .join("") || "<tr><td colspan=4 class=muted>nessuna posizione</td></tr>"}</table>`;
      } catch (e) {
        account = `<p class=muted>non disponibile: ${esc((e as Error).message)}</p>`;
      }

      const rows = [...hist].reverse().map((b) => `<tr><td>${esc(prettyRun(b.runId))}</td><td>${esc(b.slotName)}</td><td>${b.status === "ok" ? "✅" : "❌"}</td>
        <td>${esc(b.orders.map((o) => `${o.side} ${o.qty} ${o.symbol} (${o.outcome})`).join("; ") || "—")}</td><td>${esc(b.reasoning)}</td></tr>`).join("");

      const html = `<!doctype html><html lang=it><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Trader paper</title><meta http-equiv=refresh content=60>
<style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e2dc;--accent:#2a6f4e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecece8;--muted:#9a9a93;--line:#2c2c2a;--accent:#6cc79a}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:28px 0 8px}
.muted{color:var(--muted)}.big{font-size:32px;font-weight:600;margin:0}.curve{width:100%;height:120px;color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.wrap{overflow-x:auto}.tag a{color:inherit}.tag{display:inline-block;padding:2px 8px;border-radius:99px;border:1px solid var(--line);font-size:12px}
</style></head><body><main>
<h1>Trader paper <span class=tag>${flags.fake ? "finto" : `<a href="${ALPACA_DASHBOARD_URL}" target=_blank rel=noopener>Alpaca paper ↗</a>`}</span></h1>
<p class=muted>Sola lettura · dati da ${esc(store.kind)} · aggiornata ${esc(now.toLocaleString("it-IT", { timeZone: "Europe/Rome" }))} · lock: ${lock ? `run ${esc(lock.lock.runId)} ${lock.alive ? "in corso" : "interrotta"}` : "nessuno"}</p>
<h2>Conto</h2>${account}
<h2>Curva</h2>${sparkline(hist.filter((b) => b.equity !== null).map((b) => b.equity!))}
<h2>Prossime sveglie</h2><p>${[next1, next2].filter(Boolean).map((r) => esc(prettyRun(r!))).join(" · ")}</p>
<h2>Ultima decisione</h2>${baton ? `<p><b>${esc(prettyRun(baton.runId))} · ${esc(baton.slotName)}</b></p><p>${esc(baton.reasoning)}</p><p><b>Prossima mossa:</b> ${esc(baton.planNext)}</p>` : "<p class=muted>nessun testimone</p>"}
<h2>Storico</h2><div class=wrap><table><tr><th>Sveglia</th><th>Nome</th><th></th><th>Ordini</th><th>Perché</th></tr>${rows || "<tr><td colspan=5 class=muted>vuoto</td></tr>"}</table></div>
</main></body></html>`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
}
