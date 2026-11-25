// NBFC cases V1 (D-122): "Where are NBFC loans waiting before payment ready, and with which lender?"
// Population: projects in the NBFC payment lane (D-38). Payment ready (RFD) = the lender's RFD when recorded, else OMS task E004A / E004
// (D-84): the same rule as HOTO -> Installation and the TAT page. Lender steps = first entry into each stage of the latest finalized EMI
// application (EMI log, from Dec 2025; the EMI portal covers most NBFC handovers from Jun 2026). EMI-team tags are set by hand.
//  1. Cluster table (All / BAU / Expansion): NBFC HOTOs, RFD vs LMTD, HOTO -> RFD P50 / P75 / P90, waiting for RFD (live), late, disbursed.
//  2. Trend: RFD (bars) vs NBFC HOTOs (dashed), month / week / day.
//  3. Where they wait: cluster x lender step, or EMI-team tag (with the sub-reasons).
//  4. Lenders: volumes, HOTO -> RFD and the steps in between (approval -> e-NACH -> RFD -> disbursed).
//  5. Month on month.  6. Waiting list.
import { el, dataTable, segmented, projectList } from "../ui.js";
import { label, matcher, monthBounds, monthLabel, monthKey, fmtDay } from "../data.js";
import { fmtInt, tatSummary } from "../stats.js";
import * as M from "../metrics.js";
import { momTables, block, tierTable, openList, stageMatrix, daySpanOf, daySpanSwitch } from "../layout.js";
import { comboChart } from "../charts.js";
import { nbfcList } from "../lists.js";

const SKIP = new Set(["", "—", "Not mapped"]);
const box = (kids) => el("div", { class: "card" }, kids);
const pctTxt = (p) => (p == null ? "–" : `${Math.round(p)}%`);
const dTxt = (v) => (v == null ? "–" : `${Math.round(v)} d`);
const tone = (p) => (p == null ? "flat" : p > 25 ? "bad" : p > 10 ? "warn" : "good");
const MIN_N = 10;  // a step TAT on fewer projects shows as "–"

export function render(main, { data, state, setState, ctx }) {
  const f = data.nbfc;
  if (!f) { main.append(el("div", { class: "card count", text: "NBFC data is not published yet. It appears after the next refresh." })); return; }
  const c = f.ci, asOf = data.meta.as_of_day, last = ctx.last, inR = M.inRange, R = M.stuckShort(ctx);
  const m = matcher(f, state.filters, c);
  const filtered = f.facts.filter(m);
  const rows = filtered.filter((x) => !state.hideCancelled || x[c.later_cancelled] === 0);
  const cl = (x) => label(f, "cluster", x[c.cluster]), lender = (x) => label(f, "lender", x[c.lender]);
  const step = (x) => label(f, "step", x[c.step]), tag = (x) => label(f, "tag", x[c.tag]), tag2 = (x) => label(f, "tag2", x[c.tag2]);
  const portalFrom = monthBounds((f.portal_from || "2026-06-01").slice(0, 7))[0];
  const portalOk = (r) => r && r[1] >= portalFrom;

  // ---------------- definitions
  const hotos = (rs, r) => rs.filter((x) => inR(x[c.hoto_day], r));
  const rfds = (rs, r) => rs.filter((x) => inR(x[c.rfd_day], r));
  const tatOf = (a, b) => (rs, r) => rs.filter((x) => inR(x[c[b]], r) && x[c[a]] != null && x[c[b]] >= x[c[a]]).map((x) => x[c[b]] - x[c[a]]);
  const h2r = tatOf("hoto_day", "rfd_day"), a2e = tatOf("approved_day", "enach_day"), e2r = tatOf("enach_day", "rfd_day"), r2d = tatOf("rfd_day", "disbursed_day");
  const disb = (rs, r) => rs.filter((x) => inR(x[c.disbursed_day], r));
  // India yardstick (D-107 / D-111): HOTO -> RFD of every NBFC project made payment ready in the last 6 full months, whatever the filters
  const win = [ctx.cols.at(0).range[0], ctx.cols.at(-1).range[1]];
  const limit = M.stuckLimit(h2r(f.facts, win), ctx);
  // waiting = live: handed over, not payment ready, not installed (a few install before the RFD is recorded)
  const holdOn = !!state.stageHold;
  const okState = (s) => s === "active" || (holdOn && s === "on-hold");
  const waiting = filtered.filter((x) => okState(label(f, "state", x[c.state])) && x[c.rfd_day] == null && x[c.installed_day] == null && x[c.hoto_day] != null);
  const since = (x) => asOf - x[c.hoto_day];
  const late = (x) => limit != null && since(x) > limit;

  const list = nbfcList(f, asOf);
  const lateCols = [...list.cols, { key: "late", label: "Late", tip: `More than ${dTxt(limit)} since HOTO (${R} of HOTO → RFD, India, last 6 months)` }];
  const lateRow = (x) => ({ ...list.row(x), late: late(x) ? "Late" : "" });
  const openRows = (title, xs) => openList({ title, sub: `${fmtInt(xs.length)} projects`, cols: lateCols, rows: [...xs].sort((a, b) => since(b) - since(a)).map(lateRow), filename: `${title.replace(/\W+/g, "_").toLowerCase()}.csv` });
  const btn = (xs, title) => (xs.length ? el("button", { type: "button", class: "link-btn", text: fmtInt(xs.length), onclick: (e) => { e.stopPropagation(); openRows(title, xs); } }) : el("span", { class: "count", text: "0" }));

  // ---------------- 1 · cluster table
  const clusters = [...new Set(rows.map(cl).concat(waiting.map(cl)))].filter((k) => !SKIP.has(k));
  const cRow = (name) => {
    const rs = rows.filter((x) => cl(x) === name), w = waiting.filter((x) => cl(x) === name), lt = w.filter(late);
    const t = tatSummary(h2r(rs, ctx.cur)), r = rfds(rs, ctx.cur), d = disb(rs, ctx.cur);
    return { name, h: hotos(rs, ctx.cur), nH: hotos(rs, ctx.cur).length, r, nR: r.length, lm: rfds(rs, ctx.prevSame).length, p50: t.p50, p75: t.p75, p90: t.p90,
      w, nW: w.length, lt, nL: lt.length, d, nD: portalOk(ctx.cur) ? d.length : null };
  };
  const cRows = clusters.map(cRow).filter((r) => r.nH || r.nR || r.nW);
  const cols = [
    { key: "name", label: "Cluster" },
    { key: "nH", label: "NBFC HOTOs MTD", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.h, `${r.name} · NBFC HOTOs ${ctx.curText}`)) },
    { key: "nR", label: "Payment ready MTD", num: true, tip: "Lender RFD when recorded, else OMS task E004A (D-84)", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.r, `${r.name} · payment ready ${ctx.curText}`)) },
    { key: "dl", label: "vs LMTD", num: true, fmt: (v, r) => { const d = M.delta(r.nR, r.lm, "count", "up"); return d ? el("span", { class: `delta ${d.tone}`, "data-tip": `LMTD ${fmtInt(r.lm)}`, text: `${d.arrow} ${d.text}` }) : "–"; } },
    { key: "p50", label: "HOTO → RFD P50", num: true, tip: "Projects made payment ready this month: days from HOTO", fmt: dTxt },
    { key: "p75", label: "P75", num: true, fmt: dTxt },
    { key: "p90", label: "P90", num: true, fmt: dTxt },
    { key: "nW", label: "Waiting for RFD", num: true, tip: "Active, handed over, not payment ready, not installed (live)", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.w, `${r.name} · waiting for RFD`)) },
    { key: "nL", label: `Past ${R}`, num: true, tip: `Waiting more than ${dTxt(limit)} since HOTO (${R} of HOTO → RFD, India, last 6 months)`, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.lt, `${r.name} · waiting past ${R}`)) },
    { key: "pL", label: "Share late", num: true, fmt: (v, r) => { const p = r.nW ? (100 * r.nL) / r.nW : null; return p == null ? "–" : el("span", { class: `pill ${tone(p)}`, text: pctTxt(p) }); } },
    { key: "nD", label: "Disbursed MTD", num: true, tip: "Lender disbursal this month (EMI portal, from Jun 2026)", fmt: (v, r) => (v == null ? "–" : r.footer ? fmtInt(v) : btn(r.d, `${r.name} · disbursed ${ctx.curText}`)) },
  ];
  const totalOf = (rs, name) => {
    const names = new Set(rs.map((r) => r.name)), sub = rows.filter((x) => names.has(cl(x))), s = (k) => rs.reduce((a, r) => a + (r[k] || 0), 0);
    const t = tatSummary(h2r(sub, ctx.cur));
    return { footer: true, name, nH: s("nH"), nR: s("nR"), lm: s("lm"), p50: t.p50, p75: t.p75, p90: t.p90, nW: s("nW"), nL: s("nL"), nD: portalOk(ctx.cur) ? s("nD") : null };
  };
  const sumParts = (t) => [el("span", {}, ["Payment ready ", el("b", { text: fmtInt(t.nR) })]), el("span", {}, ["Waiting ", el("b", { text: fmtInt(t.nW) })]),
    el("span", { class: `pill ${tone(t.nW ? (100 * t.nL) / t.nW : null)}`, text: `${pctTxt(t.nW ? (100 * t.nL) / t.nW : null)} late` })];
  const allT = totalOf(cRows, "All clusters");
  main.append(block(1, "NBFC cases by cluster", `${ctx.curText} · ${ctx.curRange} · payment ready = lender RFD, else OMS E004A · waiting live · click a count for its projects`,
    el("div", { class: "count", style: { margin: "0 0 8px" }, text: `All clusters: ${fmtInt(allT.nH)} NBFC HOTOs · ${fmtInt(allT.nR)} made payment ready · HOTO → RFD P50 ${dTxt(allT.p50)}, P90 ${dTxt(allT.p90)} · ${fmtInt(allT.nW)} waiting, ${fmtInt(allT.nL)} past ${dTxt(limit)} (${R}, India)` }),
    tierTable({ rows: cRows, cols, totalOf, sumParts, tier: state.tier, onTier: (v) => setState({ tier: v }), sortKey: "nW", sortDir: -1 })));

  // ---------------- 2 · trend: payment ready vs NBFC HOTOs
  const grain = ["mom", "wow", "dod"].includes(state.nbfcGrain) ? state.nbfcGrain : "mom";
  const byDay = (field) => { const mp = new Map(); for (const x of rows) { const d = x[c[field]]; if (d != null) mp.set(d, (mp.get(d) || 0) + 1); } return mp; };
  const rDay = byDay("rfd_day"), hDay = byDay("hoto_day");
  const labels = [], rs = [], hs = [];
  const add = (lbl, a, b) => { let r1 = 0, h1 = 0; for (let d = a; d <= b; d++) { r1 += rDay.get(d) || 0; h1 += hDay.get(d) || 0; } labels.push(lbl); rs.push(r1); hs.push(h1); };
  if (grain === "dod") for (let d = last - (daySpanOf(state) - 1); d <= last; d++) add(fmtDay(d).slice(0, 6), d, d);
  else if (grain === "wow") for (let w = 11; w >= 0; w--) { const b = last - 7 * w, a = b - 6; add(`${fmtDay(a).slice(0, 6)}–${fmtDay(b).slice(0, 6)}`, a, b); }
  else for (const k of M.trendMonths(data.meta)) { const [a, b] = monthBounds(k); if (a > last) continue; add(monthLabel(k) + (b > last ? " (MTD)" : ""), a, Math.min(b, last)); }
  main.append(block(2, "Payment ready vs handed over", "Bars = NBFC projects made payment ready, dashed line = NBFC HOTOs · when the bars sit below the line, the wait for RFD grows",
    box([el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["mom", "Month on month"], ["wow", "Week on week"], ["dod", "Day on day"]], grain, (v) => setState({ nbfcGrain: v }), "Grain"), grain === "dod" ? daySpanSwitch(state, setState) : null]),
      comboChart(labels, { label: "Payment ready", data: rs, color: "--series-1" }, { label: "NBFC HOTOs", data: hs, color: "--series-2" }, { yFormat: (v) => fmtInt(v), height: 290 })])));

  // ---------------- 3 · where they wait: cluster x lender step / EMI tag
  const view = state.nbfcView === "tag" ? "tag" : "step";
  const tagOrder = ["PAP Pending", "Link request to Lender", "Links received", "PAP Done", "TFR Received - RFD Pending", "Feasibility Letter pending for RFD", "RFD Check in process Lender",
    "Hard Approval pending", "Under review - EMI manager", "EMI Team Yet to pick up", "Discom dependency", "Design Approval Pending", "Payment mode change", "Non Loan process issue",
    "Project On Hold / Seeking Cancelation", "No tag"];
  const tagged = waiting.filter((x) => tag(x) !== "No tag").length;
  const reasonRows = (() => {
    const mp = new Map();
    for (const x of waiting) { if (tag(x) === "No tag") continue; const k = `${tag(x)}\u0000${tag2(x)}`; if (!mp.has(k)) mp.set(k, []); mp.get(k).push(x); }
    return [...mp].map(([k, xs]) => { const [t1, t2] = k.split("\u0000"); return { tag: t1, sub: t2 === "—" ? "(no sub-reason)" : t2, xs, n: xs.length, nL: xs.filter(late).length }; })
      .sort((a, b) => b.n - a.n).slice(0, 15);
  })();
  main.append(block(3, "Where NBFC cases wait", `${fmtInt(waiting.length)} waiting for RFD (${holdOn ? "active + on-hold" : "active"}) · live · late = more than ${dTxt(limit)} since HOTO (${R}) · ${view === "tag" ? `EMI-team tags are set by hand: ${fmtInt(tagged)} of ${fmtInt(waiting.length)} waiting projects carry one` : "lender step = the EMI application's current stage"}`,
    el("div", { class: "card-actions", style: { marginBottom: "10px", justifyContent: "flex-start", gap: "10px" } }, [
      segmented([["step", "Lender step"], ["tag", "EMI-team tag"]], view, (v) => setState({ nbfcView: v }), "View"),
      segmented([["active", "Active"], ["hold", "Active + on-hold"]], holdOn ? "hold" : "active", (v) => setState({ stageHold: v === "hold" }), "Projects")]),
    box(stageMatrix({ items: waiting, groupOf: cl, stageOf: view === "tag" ? tag : step, order: view === "tag" ? tagOrder : f.steps, late, onCell: (xs, title) => openRows(title, xs), lateWord: `past ${R}` })),
    view === "tag" ? box([el("div", { class: "card-sub", style: { marginBottom: "6px" }, text: "Top tag and sub-reason pairs among the waiting projects" }),
      dataTable([{ key: "tag", label: "EMI tag" }, { key: "sub", label: "Sub-reason" }, { key: "n", label: "Waiting", num: true, fmt: (v, r) => btn(r.xs, `${r.tag} · ${r.sub}`) },
        { key: "nL", label: `Past ${R}`, num: true, fmt: fmtInt }], reasonRows, { sortKey: "n", sortDir: -1, maxHeight: 420 })]) : null));

  // ---------------- 4 · lenders
  const lenders = [...new Set(rows.filter((x) => x[c.hoto_day] >= win[0]).map(lender).concat(waiting.map(lender)))];
  const mid = (xs) => (xs.length >= MIN_N ? tatSummary(xs).p50 : null);
  const lRow = (name) => {
    const rs2 = rows.filter((x) => lender(x) === name), w = waiting.filter((x) => lender(x) === name);
    const t = h2r(rs2, ctx.cur);
    return { name, nH: hotos(rs2, ctx.cur).length, nR: rfds(rs2, ctx.cur).length, p50: mid(t), p90: t.length >= MIN_N ? tatSummary(t).p90 : null,
      a2e: mid(a2e(rs2, ctx.cur)), e2r: mid(e2r(rs2, ctx.cur)), r2d: mid(r2d(rs2, ctx.cur)), w, nW: w.length, nL: w.filter(late).length };
  };
  const lRows = lenders.map(lRow).filter((r) => r.nH || r.nR || r.nW);
  const lTot = (() => { const t = h2r(rows, ctx.cur); return { footer: true, name: "All lenders", nH: hotos(rows, ctx.cur).length, nR: rfds(rows, ctx.cur).length, p50: mid(t),
    p90: t.length >= MIN_N ? tatSummary(t).p90 : null, a2e: mid(a2e(rows, ctx.cur)), e2r: mid(e2r(rows, ctx.cur)), r2d: mid(r2d(rows, ctx.cur)), nW: waiting.length, nL: waiting.filter(late).length }; })();
  main.append(block(4, "Lenders: volume and speed", `${ctx.curText} · steps finished this month, P50 days (blank under ${MIN_N} projects) · approval mostly lands about a day before HOTO · lender steps from the EMI portal (most NBFC handovers from Jun 2026)`,
    box(dataTable([{ key: "name", label: "Lender" }, { key: "nH", label: "NBFC HOTOs MTD", num: true, fmt: fmtInt }, { key: "nR", label: "Payment ready MTD", num: true, fmt: fmtInt },
      { key: "p50", label: "HOTO → RFD P50", num: true, fmt: dTxt }, { key: "p90", label: "P90", num: true, fmt: dTxt },
      { key: "a2e", label: "Approved → e-NACH done", num: true, tip: "P50 days, e-NACH completed this month", fmt: dTxt },
      { key: "e2r", label: "e-NACH done → RFD", num: true, tip: "P50 days, payment ready this month", fmt: dTxt },
      { key: "r2d", label: "RFD → disbursed", num: true, tip: "P50 days, disbursed this month", fmt: dTxt },
      { key: "nW", label: "Waiting for RFD", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.w, `${r.name} · waiting for RFD`)) },
      { key: "nL", label: `Past ${R}`, num: true, fmt: fmtInt }], lRows, { sortKey: "nH", sortDir: -1, maxHeight: 420, footer: lTot }))));

  // ---------------- 5 · month on month (above the list, as asked)
  const p1f = data.p1, p1c = p1f.ci, p1rows = M.p1Rows(data, state);
  const nbfcOf = (x) => label(p1f, "payment_lane", x[p1c.payment_lane]) === "NBFC";
  const pOk = (v) => (rs3, r) => (portalOk(r) ? v(rs3, r) : null);
  const metrics = [
    { id: "hotos", label: "NBFC HOTOs", src: "n", kind: "count", good: "up", value: (rs3, r) => hotos(rs3, r).length, pick: hotos },
    { id: "share", label: "NBFC share of all HOTOs", src: "p", kind: "pct", good: "up", hint: "NBFC lane ÷ all HOTOs (HOTO → Installation data)",
      value: (rs3, r) => { const h = rs3.filter((x) => inR(x[p1c.hoto_day], r)); return h.length ? (100 * h.filter(nbfcOf).length) / h.length : null; }, base: (rs3, r) => rs3.filter((x) => inR(x[p1c.hoto_day], r)).length },
    { id: "rfd", label: "Payment ready (RFD)", src: "n", kind: "count", good: "up", value: (rs3, r) => rfds(rs3, r).length, pick: rfds },
    { id: "h2r50", label: "HOTO → RFD P50", src: "n", kind: "days", good: "down", value: (rs3, r) => tatSummary(h2r(rs3, r)).p50, base: (rs3, r) => h2r(rs3, r).length },
    { id: "h2r75", label: "HOTO → RFD P75", src: "n", kind: "days", good: "down", value: (rs3, r) => tatSummary(h2r(rs3, r)).p75, base: (rs3, r) => h2r(rs3, r).length },
    { id: "h2r90", label: "HOTO → RFD P90", src: "n", kind: "days", good: "down", value: (rs3, r) => tatSummary(h2r(rs3, r)).p90, base: (rs3, r) => h2r(rs3, r).length },
    { id: "a2e", label: "Approved → e-NACH done P50", src: "n", kind: "days", good: "down", hint: "EMI portal, from Jun 2026", value: pOk((rs3, r) => tatSummary(a2e(rs3, r)).p50), base: (rs3, r) => a2e(rs3, r).length },
    { id: "e2r", label: "e-NACH done → RFD P50", src: "n", kind: "days", good: "down", hint: "EMI portal, from Jun 2026", value: pOk((rs3, r) => tatSummary(e2r(rs3, r)).p50), base: (rs3, r) => e2r(rs3, r).length },
    { id: "disb", label: "Disbursed by the lender", src: "n", kind: "count", good: "up", hint: "EMI portal, from Jun 2026", value: pOk((rs3, r) => disb(rs3, r).length), pick: disb },
    { id: "r2d", label: "RFD → disbursed P50", src: "n", kind: "days", good: "down", hint: "EMI portal, from Jun 2026", value: pOk((rs3, r) => tatSummary(r2d(rs3, r)).p50), base: (rs3, r) => r2d(rs3, r).length },
    { id: "wait", label: "Waiting for RFD (now)", src: "n", kind: "now", good: "down", value: () => waiting.length },
  ];
  main.append(block(5, "Month on month", "Month to date and full months · HOTOs by HOTO date, payment ready and TATs by the date the step finished · portal steps from Jun 2026",
    momTables(metrics, ctx, { n: { file: f, ci: c, rows, list }, p: { file: p1f, ci: { ...p1c, lane: undefined }, rows: p1rows } }, { state, setState })));  // the share row stays all lanes: no lane switch on it

  // ---------------- 6 · waiting list
  main.append(block(6, "Waiting for RFD: project list", `${fmtInt(waiting.length)} projects · live · longest since HOTO first`,
    box(projectList(lateCols, [...waiting].sort((a, b) => since(b) - since(a)).map(lateRow), { searchKeys: lateCols.filter((x) => !x.num && !x.fmt).map((x) => x.key), sortKey: "days", sortDir: -1, filename: "nbfc_waiting_for_rfd.csv" }))));
}
