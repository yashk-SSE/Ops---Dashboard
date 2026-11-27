// Order -> HOTO V1 (D-124): "How many orders, how fast do they reach HOTO, where do they wait, and how good is the first RM welcome call?"
// Order = a lead with an order date (lead.order_closure_datetime: when sales closed it, ~3 days before HOTO; the project's own order date is
// later, ~1 day before HOTO). HOTO = the project with the same SSE ID. Welcome call = RM verification checklist (task SC008, D-78 / D-91):
// GTG = approved on the first attempt; NGTG sections / reasons from that first attempt. Orders not yet handed over take the lead's place.
//  1. Cluster table (All / BAU / Expansion): orders vs LMTD, handed over, order -> HOTO P50 / P90, first-call GTG, calls per order,
//     waiting (live), late, over 90 days.
//  2. Trend: orders (bars) vs handed over (dashed), month / week / day.
//  3. Welcome call: first-call NGTG by checklist section, by cluster, and the top reasons.
//  4. Where orders wait: cluster x lead stage.  5. RMs.  6. Month on month (above the list).  7. Waiting list.
import { el, dataTable, segmented, projectList } from "../ui.js";
import { label, matcher, monthBounds, monthLabel, fmtDay } from "../data.js";
import { fmtInt, tatSummary } from "../stats.js";
import * as M from "../metrics.js";
import { momTables, block, tierTable, openList, stageMatrix, daySpanOf, daySpanSwitch, chartClusters } from "../layout.js";
import { comboChart } from "../charts.js";
import { orderList } from "../lists.js";

const SKIP = new Set(["", "—", "Not mapped", "Unknown"]);
const box = (kids) => el("div", { class: "card" }, kids);
const pctTxt = (p) => (p == null ? "–" : `${Math.round(p)}%`);
const dTxt = (v) => (v == null ? "–" : `${Math.round(v)} d`);
const tone = (p) => (p == null ? "flat" : p > 25 ? "bad" : p > 10 ? "warn" : "good");
const gtgTone = (p) => (p == null ? "flat" : p >= 90 ? "good" : p >= 80 ? "warn" : "bad");
const MIN_N = 10;
const OLD = 90;  // days since order: past this an order still not handed over is probably dropped

export function render(main, { data, state, setState, ctx }) {
  const f = data.orders;
  if (!f) { main.append(el("div", { class: "card count", text: "Order data is not published yet. It appears after the next refresh." })); return; }
  const c = f.ci, asOf = data.meta.as_of_day, last = ctx.last, inR = M.inRange, R = M.stuckShort(ctx);
  const filtered = f.facts.filter(matcher(f, state.filters, c));
  const status = (x) => label(f, "status", x[c.status]);
  const rows = filtered.filter((x) => !state.hideCancelled || status(x) !== "Dropped");
  const cl = (x) => label(f, "cluster", x[c.cluster]), stage = (x) => label(f, "stage", x[c.stage]), rmOf = (x) => label(f, "rm", x[c.rm]);

  // ---------------- definitions
  const orders = (rs, r) => rs.filter((x) => inR(x[c.order_day], r));
  const handed = (rs, r) => rs.filter((x) => inR(x[c.hoto_day], r));
  const tatOf = (a, b) => (rs, r) => rs.filter((x) => inR(x[c[b]], r) && x[c[a]] != null && x[c[b]] >= x[c[a]]).map((x) => x[c[b]] - x[c[a]]);
  const o2h = tatOf("order_day", "hoto_day"), o2t = tatOf("order_day", "sc008_day"), t2c = tatOf("sc008_day", "call_day");
  const calls = (rs, r) => rs.filter((x) => inR(x[c.call_day], r) && x[c.first_gtg] != null);
  const gtgPct = (cs) => (cs.length ? (100 * cs.filter((x) => x[c.first_gtg] === 1).length) / cs.length : null);
  const perOrder = (cs) => { const a = cs.map((x) => x[c.attempts]).filter((v) => v != null); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; };
  const win = [ctx.cols.at(0).range[0], ctx.cols.at(-1).range[1]];
  const limit = M.stuckLimit(o2h(f.facts, win), ctx);  // India, orders handed over in the last 6 full months (D-107 / D-111)
  const since = (x) => asOf - x[c.order_day];
  const late = (x) => limit != null && since(x) > limit;
  const old = (x) => since(x) > OLD;
  // waiting = not handed over, lead in a booking / verification / RM-call stage, ordered in the last 90 days; older ones are
  // kept apart (stale: probably dropped without being cancelled in the system) so they don't drown the live pipeline
  const waitAll = filtered.filter((x) => status(x) === "Waiting");
  const waiting = waitAll.filter((x) => !old(x)), stale = waitAll.filter(old);

  const list = orderList(f, asOf);
  const lateCols = [...list.cols, { key: "late", label: "Late", tip: `More than ${dTxt(limit)} since the order (${R} of order → HOTO, India, last 6 months)` }];
  const lateRow = (x) => ({ ...list.row(x), late: old(x) ? `Over ${OLD} days` : late(x) ? "Late" : "" });
  const openRows = (title, xs) => openList({ title, sub: `${fmtInt(xs.length)} orders`, cols: lateCols, rows: [...xs].sort((a, b) => a[c.order_day] - b[c.order_day]).map(lateRow), noun: "orders", filename: `${title.replace(/\W+/g, "_").toLowerCase()}.csv` });
  const btn = (xs, title) => (xs.length ? el("button", { type: "button", class: "link-btn", text: fmtInt(xs.length), onclick: (e) => { e.stopPropagation(); openRows(title, xs); } }) : el("span", { class: "count", text: "0" }));
  const pill = (p, n) => (p == null ? "–" : el("span", { class: `pill ${gtgTone(p)}`, "data-tip": `${fmtInt(n)} first calls`, text: pctTxt(p) }));

  // ---------------- 1 · cluster table
  const clusters = [...new Set(rows.map(cl).concat(waitAll.map(cl)))].filter((k) => !SKIP.has(k));
  const cRow = (name) => {
    const rs = rows.filter((x) => cl(x) === name), w = waiting.filter((x) => cl(x) === name), cs = calls(rs, ctx.cur), t = tatSummary(o2h(rs, ctx.cur));
    const o = orders(rs, ctx.cur), h = handed(rs, ctx.cur), lt = w.filter(late), od = stale.filter((x) => cl(x) === name);
    return { name, o, nO: o.length, lm: orders(rs, ctx.prevSame).length, h, nH: h.length, p50: t.p50, p90: t.p90, nC: cs.length, gtg: gtgPct(cs), att: perOrder(cs),
      w, nW: w.length, lt, nL: lt.length, od, nOld: od.length };
  };
  const cRows = clusters.map(cRow).filter((r) => r.nO || r.nH || r.nW || r.nOld);
  const cols = [
    { key: "name", label: "Cluster" },
    { key: "nO", label: "Orders MTD", num: true, tip: "Leads whose order was closed this month (lead order date)", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.o, `${r.name} · orders ${ctx.curText}`)) },
    { key: "dl", label: "vs LMTD", num: true, fmt: (v, r) => { const d = M.delta(r.nO, r.lm, "count", "up"); return d ? el("span", { class: `delta ${d.tone}`, "data-tip": `LMTD ${fmtInt(r.lm)}`, text: `${d.arrow} ${d.text}` }) : "–"; } },
    { key: "nH", label: "Handed over MTD", num: true, tip: "Orders that reached HOTO this month (any order month)", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.h, `${r.name} · handed over ${ctx.curText}`)) },
    { key: "p50", label: "Order → HOTO P50", num: true, tip: "Orders handed over this month: days from the order", fmt: dTxt },
    { key: "p90", label: "P90", num: true, fmt: dTxt },
    { key: "gtg", label: "First-call GTG", num: true, tip: "RM welcome calls first saved this month that were approved on the first attempt", fmt: (v, r) => pill(v, r.nC) },
    { key: "att", label: "Calls / order", num: true, tip: "RM checklist attempts per order, for first calls this month", fmt: (v) => (v == null ? "–" : v.toFixed(2)) },
    { key: "nW", label: "Waiting for HOTO", num: true, tip: `Order closed in the last ${OLD} days, not handed over, lead in a booking / verification / RM-call stage (live)`, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.w, `${r.name} · waiting for HOTO`)) },
    { key: "nL", label: `Past ${R}`, num: true, tip: `Waiting more than ${dTxt(limit)} since the order (${R} of order → HOTO, India, last 6 months)`, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.lt, `${r.name} · waiting past ${R}`)) },
    { key: "pL", label: "Share late", num: true, fmt: (v, r) => { const p = r.nW ? (100 * r.nL) / r.nW : null; return p == null ? "–" : el("span", { class: `pill ${tone(p)}`, text: pctTxt(p) }); } },
    { key: "nOld", label: `Over ${OLD} days`, num: true, tip: `Still open in a booking stage ${OLD}+ days after the order: probably dropped without being cancelled in the system (not in Waiting)`, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.od, `${r.name} · waiting over ${OLD} days`)) },
  ];
  const totalOf = (rs, name) => {
    const names = new Set(rs.map((r) => r.name)), sub = rows.filter((x) => names.has(cl(x))), s = (k) => rs.reduce((a, r) => a + (r[k] || 0), 0);
    const t = tatSummary(o2h(sub, ctx.cur)), cs = calls(sub, ctx.cur);
    return { footer: true, name, nO: s("nO"), lm: s("lm"), nH: s("nH"), p50: t.p50, p90: t.p90, nC: cs.length, gtg: gtgPct(cs), att: perOrder(cs), nW: s("nW"), nL: s("nL"), nOld: s("nOld") };
  };
  const sumParts = (t) => [el("span", {}, ["Orders ", el("b", { text: fmtInt(t.nO) })]), el("span", {}, ["Waiting ", el("b", { text: fmtInt(t.nW) })]),
    t.gtg == null ? null : el("span", { class: `pill ${gtgTone(t.gtg)}`, text: `${pctTxt(t.gtg)} first-call GTG` })];
  const allT = totalOf(cRows, "All clusters");
  main.append(block(1, "Orders by cluster", `${ctx.curText} · ${ctx.curRange} · order = lead order date · waiting live · click a count for its orders`,
    el("div", { class: "count", style: { margin: "0 0 8px" }, text: `All clusters: ${fmtInt(allT.nO)} orders · ${fmtInt(allT.nH)} handed over (order → HOTO P50 ${dTxt(allT.p50)}, P90 ${dTxt(allT.p90)}) · first-call GTG ${pctTxt(allT.gtg)} of ${fmtInt(allT.nC)} welcome calls · ${fmtInt(allT.nW)} waiting for HOTO (ordered in the last ${OLD} days), ${fmtInt(allT.nL)} past ${dTxt(limit)} · ${fmtInt(allT.nOld)} more still open after ${OLD}+ days (probably dropped)` }),
    tierTable({ rows: cRows, cols, totalOf, sumParts, tier: state.tier, onTier: (v) => setState({ tier: v }), sortKey: "nO", sortDir: -1 })));

  // ---------------- 2 · trend: orders vs handed over
  // D-125: the graph's own cluster picker (this graph only, inside the top-bar filters)
  const cp = chartClusters(state, setState, "order", rows.map(cl));
  const gRows = rows.filter((x) => cp.keep(cl(x)));
  const grain = ["mom", "wow", "dod"].includes(state.orderGrain) ? state.orderGrain : "mom";
  const byDay = (field) => { const mp = new Map(); for (const x of gRows) { const d = x[c[field]]; if (d != null) mp.set(d, (mp.get(d) || 0) + 1); } return mp; };
  const oDay = byDay("order_day"), hDay = byDay("hoto_day");
  const labels = [], os = [], hs = [];
  const add = (lbl, a, b) => { let o1 = 0, h1 = 0; for (let d = a; d <= b; d++) { o1 += oDay.get(d) || 0; h1 += hDay.get(d) || 0; } labels.push(lbl); os.push(o1); hs.push(h1); };
  if (grain === "dod") for (let d = last - (daySpanOf(state) - 1); d <= last; d++) add(fmtDay(d).slice(0, 6), d, d);
  else if (grain === "wow") for (let w = 11; w >= 0; w--) { const b = last - 7 * w, a = b - 6; add(`${fmtDay(a).slice(0, 6)}–${fmtDay(b).slice(0, 6)}`, a, b); }
  else for (const k of M.trendMonths(data.meta)) { const [a, b] = monthBounds(k); if (a > last) continue; add(monthLabel(k) + (b > last ? " (MTD)" : ""), a, Math.min(b, last)); }
  main.append(block(2, "Orders vs handed over", "Bars = orders closed, dashed line = orders handed over (HOTO) · when the line sits below the bars, the wait for HOTO grows" + cp.note,
    box([el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["mom", "Month on month"], ["wow", "Week on week"], ["dod", "Day on day"]], grain, (v) => setState({ orderGrain: v }), "Grain"), grain === "dod" ? daySpanSwitch(state, setState) : null, cp.node]),
      comboChart(labels, { label: "Orders", data: os, color: "--series-1" }, { label: "Handed over", data: hs, color: "--series-2" }, { yFormat: (v) => fmtInt(v), height: 290 })])));

  // ---------------- 3 · welcome call: first-call NGTG by section and reason
  const secs = f.rm_sections || [];
  const curCalls = calls(rows, ctx.cur), ngtg = curCalls.filter((x) => x[c.first_gtg] === 0);
  const hasSec = (x, i) => ((x[c.ngtg_bits] || 0) >> i) & 1;
  const usedSecs = secs.map((s, i) => [s, i]).filter(([, i]) => ngtg.some((x) => hasSec(x, i)));
  const sRow = (name, xs) => { const cs = xs, ng = cs.filter((x) => x[c.first_gtg] === 0), r = { name, n: cs.length, gtg: gtgPct(cs), ng, nNG: ng.length };
    for (const [, i] of usedSecs) { r.by = r.by || {}; r.by[i] = ng.filter((x) => hasSec(x, i)); r[`s${i}`] = r.by[i].length; } return r; };
  const callClusters = [...new Set(curCalls.map(cl))].filter((k) => !SKIP.has(k));
  const sRows = callClusters.map((n) => sRow(n, curCalls.filter((x) => cl(x) === n))).filter((r) => r.n);
  const sTot = { ...sRow("All clusters", curCalls), footer: true };
  const secCell = (i) => (v, r) => { const xs = (r.by || {})[i] || []; if (!xs.length) return el("span", { class: "count", text: "·" });
    return el("span", { class: "split-cell" }, [r.footer ? fmtInt(xs.length) : btn(xs, `${r.name} · first call NGTG on ${secs[i]}`), el("small", { text: pctTxt(r.nNG ? (100 * xs.length) / r.nNG : null) })]); };
  const reasonIdx = f.dims.reason || [];
  const rCount = new Map();
  for (const x of ngtg) for (const k of String(x[c.reasons] || "").split(",").filter(Boolean)) rCount.set(+k, (rCount.get(+k) || []).concat([x]));
  const rRows = [...rCount].map(([k, xs]) => ({ reason: reasonIdx[k], xs, n: xs.length, share: ngtg.length ? (100 * xs.length) / ngtg.length : null })).sort((a, b) => b.n - a.n).slice(0, 15);
  main.append(block(3, "Welcome call: why first calls are NGTG", `${ctx.curText} · ${fmtInt(curCalls.length)} RM welcome calls first saved this month, ${fmtInt(ngtg.length)} NGTG (${pctTxt(curCalls.length ? (100 * ngtg.length) / curCalls.length : null)}) · a call can fail on several sections · share = of the cluster's NGTG calls`,
    box(dataTable([{ key: "name", label: "Cluster" }, { key: "n", label: "First calls", num: true, fmt: fmtInt }, { key: "gtg", label: "GTG", num: true, fmt: (v, r) => pill(v, r.n) },
      { key: "nNG", label: "NGTG", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.ng, `${r.name} · first call NGTG`)) },
      ...usedSecs.map(([s, i]) => ({ key: `s${i}`, label: s, num: true, fmt: secCell(i) }))], sRows, { sortKey: "n", sortDir: -1, maxHeight: 520, footer: sTot })),
    box([el("div", { class: "card-sub", style: { marginBottom: "6px" }, text: "Top reasons the RM marked (fixed list; \"Others\" means the RM wrote a comment instead, which is not shown)" }),
      dataTable([{ key: "reason", label: "Section: reason" }, { key: "n", label: "NGTG calls", num: true, fmt: (v, r) => btn(r.xs, r.reason) }, { key: "share", label: "Share of NGTG", num: true, fmt: pctTxt }], rRows, { sortKey: "n", sortDir: -1, maxHeight: 420 })])));

  // ---------------- 4 · where orders wait: cluster x lead stage
  main.append(block(4, "Where orders wait", `${fmtInt(waiting.length)} orders not yet handed over, ordered in the last ${OLD} days · live · lead stage now · late = more than ${dTxt(limit)} since the order (${R}) · ${fmtInt(stale.length)} older ones left out (list below)`,
    box(stageMatrix({ items: waiting, groupOf: cl, stageOf: stage, order: f.wait_stages, late, onCell: (xs, title) => openRows(title, xs), what: "orders", lateWord: `past ${R}` }))));

  // ---------------- 5 · RMs
  const rms = [...new Set(curCalls.map(rmOf).concat(waiting.filter((x) => ["Pending RM Call", "RM Rejected"].includes(stage(x))).map(rmOf)))].filter((r) => r !== "No RM");
  const mid = (xs) => (xs.length >= MIN_N ? tatSummary(xs).p50 : null);
  const rmRow = (name) => { const rs = rows.filter((x) => rmOf(x) === name), cs = calls(rs, ctx.cur);
    const pend = waiting.filter((x) => rmOf(x) === name && stage(x) === "Pending RM Call"), rej = waiting.filter((x) => rmOf(x) === name && stage(x) === "RM Rejected");
    return { name, n: cs.length, gtg: gtgPct(cs), att: perOrder(cs), t2c: mid(t2c(rs, ctx.cur)), o2t: mid(o2t(rs, ctx.cur)), pend, nP: pend.length, rej, nR: rej.length }; };
  const rmRows = rms.map(rmRow).filter((r) => r.n || r.nP || r.nR);
  const rmTot = (() => { const cs = curCalls; const pend = waiting.filter((x) => stage(x) === "Pending RM Call"), rej = waiting.filter((x) => stage(x) === "RM Rejected");
    return { footer: true, name: "All RMs", n: cs.length, gtg: gtgPct(cs), att: perOrder(cs), t2c: mid(t2c(rows, ctx.cur)), o2t: mid(o2t(rows, ctx.cur)), nP: pend.length, nR: rej.length }; })();
  main.append(block(5, "RMs: welcome calls", `${ctx.curText} · first calls saved this month · P50 days (blank under ${MIN_N} calls) · waiting = live orders at Pending RM call / RM rejected with this RM`,
    box(dataTable([{ key: "name", label: "RM" }, { key: "n", label: "First calls MTD", num: true, fmt: fmtInt }, { key: "gtg", label: "First-call GTG", num: true, fmt: (v, r) => pill(v, r.n) },
      { key: "att", label: "Calls / order", num: true, fmt: (v) => (v == null ? "–" : v.toFixed(2)) },
      { key: "o2t", label: "Order → call task", num: true, tip: "P50 days from the order to the SC008 task being created", fmt: dTxt },
      { key: "t2c", label: "Call task → call done", num: true, tip: "P50 days from the SC008 task to the first checklist saved", fmt: dTxt },
      { key: "nP", label: "Pending RM call", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.pend, `${r.name} · pending RM call`)) },
      { key: "nR", label: "RM rejected", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.rej, `${r.name} · RM rejected`)) }], rmRows, { sortKey: "n", sortDir: -1, maxHeight: 520, footer: rmTot }))));

  // ---------------- 6 · month on month (above the list)
  const metrics = [
    { id: "orders", label: "Orders", src: "o", kind: "count", good: "up", value: (rs, r) => orders(rs, r).length, pick: orders },
    { id: "oa", label: "Opening Act share of orders", src: "o", kind: "pct", good: "up", value: (rs, r) => { const o = orders(rs, r); return o.length ? (100 * o.filter((x) => x[c.oa] === 1).length) / o.length : null; }, base: (rs, r) => orders(rs, r).length },
    { id: "handed", label: "Handed over (HOTO)", src: "o", kind: "count", good: "up", value: (rs, r) => handed(rs, r).length, pick: handed },
    { id: "o2h50", label: "Order → HOTO P50", src: "o", kind: "days", good: "down", value: (rs, r) => tatSummary(o2h(rs, r)).p50, base: (rs, r) => o2h(rs, r).length },
    { id: "o2h75", label: "Order → HOTO P75", src: "o", kind: "days", good: "down", value: (rs, r) => tatSummary(o2h(rs, r)).p75, base: (rs, r) => o2h(rs, r).length },
    { id: "o2h90", label: "Order → HOTO P90", src: "o", kind: "days", good: "down", value: (rs, r) => tatSummary(o2h(rs, r)).p90, base: (rs, r) => o2h(rs, r).length },
    { id: "o2t", label: "Order → welcome-call task P50", src: "o", kind: "days", good: "down", value: (rs, r) => tatSummary(o2t(rs, r)).p50, base: (rs, r) => o2t(rs, r).length },
    { id: "t2c", label: "Call task → first call saved P50", src: "o", kind: "days", good: "down", value: (rs, r) => tatSummary(t2c(rs, r)).p50, base: (rs, r) => t2c(rs, r).length },
    { id: "gtg", label: "First-call GTG", src: "o", kind: "pct", good: "up", value: (rs, r) => gtgPct(calls(rs, r)), base: (rs, r) => calls(rs, r).length },
    { id: "att", label: "Calls per order", src: "o", kind: "num", good: "down", value: (rs, r) => perOrder(calls(rs, r)) },
    { id: "drop", label: "Orders dropped before HOTO", src: "o", kind: "count", good: "down", hint: "By order month: cancelled or rejected before HOTO", value: (rs, r) => orders(rs, r).filter((x) => status(x) === "Dropped").length },
  ];
  // ---------------- 7 · waiting list (the month on month goes in above it)
  const which = state.orderList === "stale" ? "stale" : "wait", listRows = which === "stale" ? stale : waiting;
  const listBlock = block(7, which === "stale" ? `Open after ${OLD}+ days: order list` : "Waiting for HOTO: order list", `${fmtInt(listRows.length)} orders · live · oldest order first · SSE ID once the project exists`,
    el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["wait", `Waiting (${fmtInt(waiting.length)})`], ["stale", `Over ${OLD} days (${fmtInt(stale.length)})`]], which, (v) => setState({ orderList: v }), "List")]),
    box(projectList(lateCols, [...listRows].sort((a, b) => a[c.order_day] - b[c.order_day]).map(lateRow), { searchKeys: lateCols.filter((x) => !x.num && !x.fmt).map((x) => x.key), sortKey: "days", sortDir: -1, filename: which === "stale" ? "orders_open_over_90_days.csv" : "orders_waiting_for_hoto.csv", noun: "orders" })));
  main.append(listBlock);
  main.insertBefore(block(6, "Month on month", "Month to date and full months · orders by order date, HOTOs and TATs by the date the step finished · welcome calls from Jun 2026",
    momTables(metrics, ctx, { o: { file: f, ci: c, rows, list } }, { state, setState })), listBlock);
}
