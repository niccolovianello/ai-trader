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

const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** Monotone cubic through the points: smooth, but never bulges past a real value. */
function smoothPath(xy) {
  const n = xy.length;
  if (n < 3) return xy.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join("");
  const d = [], m = [];
  for (let i = 0; i < n - 1; i++) d.push((xy[i + 1][1] - xy[i][1]) / (xy[i + 1][0] - xy[i][0]));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]));
  m.push(d[n - 2]);
  let path = `M${xy[0][0]},${xy[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = xy[i], [x1, y1] = xy[i + 1], h = (x1 - x0) / 3;
    path += `C${x0 + h},${y0 + m[i] * h} ${x1 - h},${y1 - m[i + 1] * h} ${x1},${y1}`;
  }
  return path;
}

let curveData = [];
function renderCurve() {
  const c = $("curve");
  c.replaceChildren();
  const pts = curveData;
  if (pts.length < 2) return c.append(el("p", "La curva compare dopo due sveglie.", "muted"));

  const first = pts[0].equity, last = pts[pts.length - 1].equity, diff = last - first;
  const tone = diff >= 0 ? "up" : "down";
  c.className = `card curve-card ${tone}`;

  const head = el("div", null, "curve-head");
  head.append(el("p", `${diff >= 0 ? "+" : ""}${usd(diff)}`, "big delta"),
    el("p", `${diff >= 0 ? "▲" : "▼"} ${pct(diff / first)} dal ${run(pts[0].runId).slice(0, 10)} · ${pts.length} sveglie`, "muted"));
  c.append(head);

  const W = Math.max(c.clientWidth - 32, 260), H = 180, padX = 8, top = 14, bottom = 22;
  const values = pts.map((p) => p.equity);
  let min = Math.min(...values, first), max = Math.max(...values, first);
  const pad = (max - min || Math.abs(max) * 0.001 || 1) * 0.15;
  min -= pad; max += pad;
  const x = (i) => padX + (i / (pts.length - 1)) * (W - 2 * padX);
  const y = (v) => top + (1 - (v - min) / (max - min)) * (H - top - bottom);
  const xy = pts.map((p, i) => [+x(i).toFixed(1), +y(p.equity).toFixed(1)]);
  const line = smoothPath(xy);

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "curve", role: "img", "aria-label": "curva dell'equity" });
  const defs = svgEl("defs", {});
  const grad = svgEl("linearGradient", { id: "curve-fill", x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(svgEl("stop", { offset: "0%", "stop-color": "currentColor", "stop-opacity": 0.32 }),
    svgEl("stop", { offset: "100%", "stop-color": "currentColor", "stop-opacity": 0 }));
  defs.append(grad);
  const base = y(first);
  svg.append(defs,
    svgEl("path", { d: `${line}L${xy.at(-1)[0]},${H - bottom}L${xy[0][0]},${H - bottom}Z`, fill: "url(#curve-fill)" }),
    svgEl("line", { x1: 0, x2: W, y1: base, y2: base, class: "base" }),
    svgEl("text", { x: W - 2, y: base - 5, "text-anchor": "end", class: "label" }),
    svgEl("path", { d: line, class: "line" }));
  svg.lastChild.previousSibling.textContent = `partenza ${usd(first)}`;
  xy.forEach(([px, py]) => svg.append(svgEl("circle", { cx: px, cy: py, r: 2.5, class: "dot" })));
  const [lx, ly] = xy.at(-1);
  svg.append(svgEl("circle", { cx: lx, cy: ly, r: 5, class: "pulse" }), svgEl("circle", { cx: lx, cy: ly, r: 4.5, class: "last" }));

  const guide = svgEl("line", { y1: top, y2: H - bottom, class: "guide", visibility: "hidden" });
  const focus = svgEl("circle", { r: 5, class: "last", visibility: "hidden" });
  svg.append(guide, focus);
  const tip = el("div", null, "curve-tip");
  tip.hidden = true;
  const box = el("div", null, "curve-box");
  box.append(svg, tip);
  c.append(box);

  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const i = Math.round((((e.clientX - r.left) / r.width) * W - padX) / (W - 2 * padX) * (pts.length - 1));
    const k = Math.min(pts.length - 1, Math.max(0, i)), [px, py] = xy[k];
    for (const [a, v] of [["x1", px], ["x2", px]]) guide.setAttribute(a, v);
    focus.setAttribute("cx", px); focus.setAttribute("cy", py);
    guide.setAttribute("visibility", "visible"); focus.setAttribute("visibility", "visible");
    tip.replaceChildren(el("b", usd(pts[k].equity)), el("span", `${run(pts[k].runId)} · ${pts[k].slotName}`));
    tip.hidden = false;
    tip.style.left = `${(px / W) * 100}%`;
    tip.style.top = `${(py / H) * 100}%`;
    tip.classList.toggle("flip", px > W * 0.7);
  });
  svg.addEventListener("pointerleave", () => {
    tip.hidden = true;
    guide.setAttribute("visibility", "hidden"); focus.setAttribute("visibility", "hidden");
  });
}
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderCurve, 150); });

function renderHistory(list) {
  curveData = list.filter((b) => b.equity != null);
  renderCurve();
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
