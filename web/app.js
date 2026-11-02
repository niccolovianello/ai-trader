import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, doc, documentId, getFirestore, limit, onSnapshot, orderBy, query } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

const $ = (id) => document.getElementById(id);
const show = (id) => ["signin", "denied", "setup", "app"].forEach((s) => ($(s).hidden = s !== id));

const money = new Intl.NumberFormat("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd = (n) => (n == null ? "—" : `${money.format(n).replace("-", "−")} $`);
const pct = (r) => `${(r * 100).toFixed(1).replace(".", ",").replace("-", "−")}%`;
const run = (id) => (id ? `${id.slice(0, 10)} ${id.slice(11, 13)}:${id.slice(13, 15)}` : "—");

/** Every value from Firestore goes through text nodes, never innerHTML. */
function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function table(target, head, rows) {
  const t = $(target);
  t.replaceChildren();
  const tr = el("tr");
  head.forEach((h) => tr.append(el("th", h)));
  t.append(tr);
  if (!rows.length) {
    const r = el("tr"), td = el("td", "nessuna riga", "muted");
    td.colSpan = head.length;
    r.append(td);
    t.append(r);
  }
  for (const cells of rows) {
    const r = el("tr");
    cells.forEach((c) => r.append(el("td", c)));
    t.append(r);
  }
}

function renderBaton(b, lock) {
  $("meta").textContent = `Ultima sveglia ${run(b.runId)} · ${b.slotName} · ${b.status === "ok" ? "ok" : "errore"} · cervello ${b.brain}` +
    ` · lock: ${lock ? `run ${lock.runId}${new Date(lock.expiresAt) > new Date() ? " in corso" : " scaduto (sveglia interrotta)"}` : "nessuno"}`;
  $("equity").textContent = usd(b.equity);
  $("pnl").textContent = usd(b.dayPnl);
  $("next").textContent = run(b.nextRun);
  table("positions", ["Titolo", "Az.", "Carico", "Valore", "Dal carico"],
    (b.positions ?? []).map((p) => [p.symbol, String(p.qty), p.avgEntryPrice ? usd(p.avgEntryPrice) : "—", p.marketValue ? usd(p.marketValue) : "—", pct(p.unrealizedPlPct)]));

  const d = $("decision");
  d.replaceChildren();
  const ordered = (b.orders ?? []).map((o) => `${o.side === "buy" ? "comprato" : "venduto"} ${o.qty} ${o.symbol} (${o.outcome}) — ${o.why}`);
  d.append(el("p", `Ordini: ${ordered.join("; ") || "nessuno"}`));
  if (b.rejected?.length) d.append(el("p", `Rifiutati dalla gabbia: ${b.rejected.map((r) => `${r.side} ${r.qty} ${r.symbol} (${r.reason})`).join("; ")}`));
  d.append(el("p", `Perché: ${b.reasoning}`));
  d.append(el("p", `Prossima mossa: ${b.planNext}`));
  for (const a of b.alerts ?? []) d.append(el("p", `⚠ ${a}`, "bad"));
}

function renderHistory(list) {
  const points = list.filter((b) => b.equity != null).map((b) => b.equity);
  const c = $("curve");
  c.replaceChildren();
  if (points.length < 2) c.append(el("p", "La curva compare dopo due sveglie.", "muted"));
  else {
    const min = Math.min(...points), max = Math.max(...points), span = max - min || 1;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 600 140");
    svg.setAttribute("class", "curve");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "curva dell'equity");
    const line = document.createElementNS(ns, "polyline");
    line.setAttribute("points", points.map((v, i) => `${(i / (points.length - 1)) * 600},${130 - ((v - min) / span) * 120}`).join(" "));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "2");
    svg.append(line);
    c.append(svg, el("p", `${usd(min)} – ${usd(max)}`, "muted"));
  }
  table("history", ["Sveglia", "Nome", "", "Ordini", "Perché"], [...list].reverse().map((b) => [
    run(b.runId), b.slotName, b.status === "ok" ? "✅" : "❌",
    (b.orders ?? []).map((o) => `${o.side} ${o.qty} ${o.symbol} (${o.outcome})`).join("; ") || "—", b.reasoning,
  ]));
}

if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
  show("setup");
} else {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  let unsub = [];

  $("login").onclick = () => signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => ($("signin-error").textContent = e.message));
  $("logout").onclick = () => signOut(auth);

  onAuthStateChanged(auth, (user) => {
    unsub.forEach((u) => u());
    unsub = [];
    $("who").textContent = user?.email ?? "";
    $("logout").hidden = !user;
    if (!user) return show("signin");

    const denied = (e) => (e.code === "permission-denied" ? show("denied") : console.error(e));
    let baton = null, lock = null;
    const draw = () => baton && renderBaton(baton, lock);
    unsub.push(
      onSnapshot(doc(db, "trader", "baton"), (s) => {
        show("app");
        baton = s.exists() ? JSON.parse(s.data().json) : null;
        if (!baton) $("meta").textContent = "Nessuna sveglia ancora.";
        draw();
      }, denied),
      onSnapshot(doc(db, "trader", "lock"), (s) => { lock = s.exists() ? s.data() : null; draw(); }, denied),
      onSnapshot(query(collection(db, "history"), orderBy(documentId(), "desc"), limit(200)),
        (s) => renderHistory(s.docs.map((d) => JSON.parse(d.data().json)).reverse()), denied),
    );
  });
}
