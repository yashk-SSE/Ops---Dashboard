// # of HOTOs V3 (D-110). HOTO = project.sales_handover_datetime (E-02, OQ-61). MOP per cluster from the monthly Install Plan
// sheet (D-72). BAU vs Expansion = the 14 expansion clusters (D-77). 10-day buckets 1-10 / 11-20 / 21-end (G-03).
// No Needs action here: the page opens on the cluster table vs plan.
//  1. HOTOs vs plan by cluster: MOP this month, AOP FY27 so far (AOP pending), one list with an All / BAU / Expansion switch (D-116)
//  2. Actual vs target: month / week / day toggle
//  3. Cluster split: lane, payment, permits (counts and shares, no colouring)
//  4. 10-day view
// The cluster x stage view lives on HOTO -> Installation only (D-117).
// The old page (welcome-call mismatch, hidden by D-101) is kept in docs/archive/hotos_v2.js.
import { el, dataTable, segmented } from "../ui.js";
import { label, monthKey, monthBounds, monthLabel, monthsBetween, fmtDay, shiftMonth, activeFilterDims } from "../data.js";
import { fmtInt } from "../stats.js";
import * as M from "../metrics.js";
import { block, openList, tierTable, daySpanOf, daySpanSwitch } from "../layout.js";
import { comboChart } from "../charts.js";
import { p1FactList } from "../lists.js";

const PLAN_FILTERS = new Set(["region", "cluster"]);
const SKIP = new Set(["", "—", "Not mapped"]);
const box = (kids) => el("div", { class: "card" }, kids);
const tone = (p) => (p == null ? "flat" : p >= 90 ? "good" : p >= 75 ? "warn" : "bad");
const pctTxt = (p) => (p == null ? "–" : `${Math.round(p)}%`);

export function render(main, { data, state, setState, ctx }) {
  const f = data.p1, c = f.ci, pci = f.pci, inR = M.inRange, last = ctx.last;
  const rows = M.p1Rows(data, state);
  const cl = (x) => label(f, "cluster", x[c.cluster]);
  const list = p1FactList(f, (f.stages.find((s) => s.id === "F07") || f.stages.at(-1)).id);
  const openRows = (title, xs) => openList({ title, sub: `${fmtInt(xs.length)} HOTOs`, cols: list.cols, rows: xs.map(list.row), filename: `${title.replace(/\W+/g, "_").toLowerCase()}.csv` });
  const countBtn = (xs, title) => (xs.length ? el("button", { type: "button", class: "link-btn", text: fmtInt(xs.length), onclick: (e) => { e.stopPropagation(); openRows(title, xs); } }) : el("span", { class: "count", text: "0" }));

  // ---------------- MOP for the month (plan clusters; region / cluster filters only)
  const otherFilters = activeFilterDims(state.filters).filter((k) => !PLAN_FILTERS.has(k));
  const planMonth = (data.plan.months || {})[ctx.key];
  const mopOf = (name) => (planMonth && !otherFilters.length && planMonth.clusters[name] ? planMonth.clusters[name].hoto_mop || 0 : null);
  const clusters = [...new Set(rows.map(cl))].filter((k) => !SKIP.has(k));

  // ---------------- 1 · cluster tables: MOP (this month) and AOP (FY27 so far), BAU / Expansion folds
  const cur = rows.filter((x) => inR(x[c.hoto_day], ctx.cur)), prev = rows.filter((x) => inR(x[c.hoto_day], ctx.prevSame));
  const yday = rows.filter((x) => x[c.hoto_day] === last);
  const left = Math.max(1, ctx.days - ctx.dayN);
  const mopRow = (name) => {
    const xs = cur.filter((x) => cl(x) === name), mop = mopOf(name);
    const mtd = mop == null ? null : (mop * ctx.dayN) / ctx.days;
    return { name, xs, mop, mtd, act: xs.length, ach: mtd ? (100 * xs.length) / mtd : null, lm: prev.filter((x) => cl(x) === name).length,
      rr: xs.length / Math.max(1, ctx.dayN), need: mop == null ? null : Math.max(0, (mop - xs.length) / left), yday: yday.filter((x) => cl(x) === name).length };
  };
  const mopCols = [
    { key: "name", label: "Cluster" },
    { key: "mop", label: "MOP", num: true, fmt: (v) => (v == null ? "–" : fmtInt(v)) },
    { key: "mtd", label: "MOP MTD", num: true, tip: `Month's MOP × ${ctx.dayN}/${ctx.days} days`, fmt: (v) => (v == null ? "–" : fmtInt(Math.round(v))) },
    { key: "act", label: "HOTOs MTD", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : countBtn(r.xs, `${r.name} · HOTOs ${ctx.curText}`)) },
    { key: "ach", label: "Achieved MTD", num: true, tip: "HOTOs MTD ÷ MOP MTD", fmt: (v) => (v == null ? "–" : el("span", { class: `pill ${tone(v)}`, text: pctTxt(v) })) },
    { key: "lm", label: "LMTD", num: true, fmt: fmtInt },
    { key: "dl", label: "vs LMTD", num: true, fmt: (v, r) => { const d = M.delta(r.act, r.lm, "count", "up"); return d ? el("span", { class: `delta ${d.tone}`, text: `${d.arrow} ${d.text}` }) : "–"; } },
    { key: "rr", label: "Run rate / day", num: true, fmt: (v) => v.toFixed(1) },
    { key: "need", label: "Required Run Rate", num: true, tip: "(MOP − HOTOs MTD) ÷ days left in the month: HOTOs needed per day to reach the MOP", fmt: (v) => (v == null ? "–" : v.toFixed(1)) },
    { key: "yday", label: `Yesterday`, num: true, fmt: fmtInt },
  ];
  const totalOf = (rs, name) => {
    const t = { footer: true, name, act: rs.reduce((a, r) => a + r.act, 0), lm: rs.reduce((a, r) => a + r.lm, 0), yday: rs.reduce((a, r) => a + r.yday, 0) };
    const withMop = rs.filter((r) => r.mop != null);
    t.mop = withMop.length ? withMop.reduce((a, r) => a + r.mop, 0) : null; t.mtd = withMop.length ? withMop.reduce((a, r) => a + r.mtd, 0) : null;
    const actPlan = withMop.reduce((a, r) => a + r.act, 0);
    t.ach = t.mtd ? (100 * actPlan) / t.mtd : null; t.rr = t.act / Math.max(1, ctx.dayN); t.need = t.mop == null ? null : Math.max(0, (t.mop - actPlan) / left);
    return t;
  };
  const mopRows = clusters.map(mopRow);
  const mopSum = (t) => [el("span", {}, ["HOTOs ", el("b", { text: fmtInt(t.act) })]), t.mtd != null ? el("span", {}, ["MOP MTD ", el("b", { text: fmtInt(Math.round(t.mtd)) })]) : null,
    t.ach != null ? el("span", { class: `pill ${tone(t.ach)}`, text: `${pctTxt(t.ach)} achieved` }) : null];
  const allT = totalOf(mopRows, "All clusters");

  // AOP table: clusters by month, FY27 so far (AOP targets pending)
  const fyFrom = data.meta.windows.YTD[0], months = monthsBetween(fyFrom, last);
  const ytdRows = rows.filter((x) => inR(x[c.hoto_day], [fyFrom, last]));
  const aopRow = (name) => { const xs = ytdRows.filter((x) => cl(x) === name), r = { name, ytd: xs.length }; for (const k of months) r[k] = xs.filter((x) => monthKey(x[c.hoto_day]) === k).length; return r; };
  const aopCols = [{ key: "name", label: "Cluster" }, ...months.map((k) => ({ key: k, label: monthLabel(k), num: true, fmt: fmtInt })),
    { key: "ytd", label: "FY27 YTD", num: true, fmt: fmtInt }, { key: "aop", label: "AOP YTD", num: true, fmt: () => "–" }, { key: "aopPct", label: "Achieved YTD", num: true, fmt: () => "–" }];
  const aopTotal = (rs, name) => { const t = { footer: true, name, ytd: rs.reduce((a, r) => a + r.ytd, 0) }; for (const k of months) t[k] = rs.reduce((a, r) => a + r[k], 0); return t; };
  const aopRows = clusters.map(aopRow);
  const aopSum = (t) => [el("span", {}, ["FY27 YTD ", el("b", { text: fmtInt(t.ytd) })]), el("span", { class: "pill flat", text: "AOP sheet pending" })];

  const tab = state.hotoPlanTab === "aop" ? "aop" : "mop";
  const tableBox = tab === "mop"
    ? el("div", {}, [
      el("div", { class: "count", style: { margin: "0 0 8px" }, text: planMonth && !otherFilters.length ? `${ctx.curText} · ${ctx.curRange} · All clusters: ${fmtInt(allT.act)} HOTOs${allT.mtd != null ? ` · MOP MTD ${fmtInt(Math.round(allT.mtd))} (plan clusters) · ${pctTxt(allT.ach)} achieved` : ""}`
        : otherFilters.length ? "MOP is per cluster: clear the lane / payment / COM / SOH / ZOH / cell filters to compare with it." : `No MOP for ${ctx.curText}; actuals only.` }),
      tierTable({ rows: mopRows, cols: mopCols, totalOf, sumParts: mopSum, tier: state.tier, onTier: (v) => setState({ tier: v }), sortKey: "act", sortDir: -1 })])
    : el("div", {}, [
      el("div", { class: "count", style: { margin: "0 0 8px" }, text: `FY27 so far (${fmtDay(fyFrom)} – ${fmtDay(last)}) · AOP columns fill in once the AOP sheet is shared` }),
      tierTable({ rows: aopRows, cols: aopCols, totalOf: aopTotal, sumParts: aopSum, tier: state.tier, onTier: (v) => setState({ tier: v }), sortKey: "ytd", sortDir: -1 })]);
  main.append(block(1, "HOTOs vs plan by cluster", tab === "mop" ? "This month against the HOTO MOP · click a count for its HOTOs" : "FY27 so far, month on month, against the AOP",
    el("div", { class: "card-actions", style: { marginBottom: "10px", justifyContent: "flex-start" } }, [
      segmented([["mop", "MOP · this month"], ["aop", "AOP · FY27 so far"]], tab, (v) => setState({ hotoPlanTab: v }), "Plan")]),
    tableBox));

  // ---------------- 2 · actual vs target: month / week / day
  const grain = ["mom", "wow", "dod"].includes(state.hotoGrain) ? state.hotoGrain : "dod";
  const planClusters = planMonth && !otherFilters.length ? new Set(Object.keys(planMonth.clusters).filter((k) => clusters.includes(k))) : null;
  const scope = planClusters && planClusters.size ? (x) => planClusters.has(cl(x)) : () => true;
  const scoped = rows.filter(scope);
  const dayTarget = (d) => {  // MOP ÷ days in that month, plan clusters, months that have a MOP
    const k = monthKey(d), pm = (data.plan.months || {})[k];
    if (!pm || !planClusters) return null;
    const [a, b] = monthBounds(k), n = b - a + 1;
    return [...planClusters].reduce((s, name) => s + ((pm.clusters[name] || {}).hoto_mop || 0), 0) / n;
  };
  const byDay = new Map(); for (const x of scoped) { const d = x[c.hoto_day]; if (d != null) byDay.set(d, (byDay.get(d) || 0) + 1); }
  let labels = [], act = [], tgt = [];
  if (grain === "dod") {
    for (let d = last - (daySpanOf(state) - 1); d <= last; d++) { labels.push(fmtDay(d).slice(0, 6)); act.push(byDay.get(d) || 0); const t = dayTarget(d); tgt.push(t == null ? null : Math.round(t)); }
  } else if (grain === "wow") {
    // weeks ending on the last complete day, 12 weeks
    for (let w = 11; w >= 0; w--) {
      const b = last - 7 * w, a = b - 6; let s = 0, t = 0, has = false;
      for (let d = a; d <= b; d++) { s += byDay.get(d) || 0; const dt = dayTarget(d); if (dt != null) { t += dt; has = true; } }
      labels.push(`${fmtDay(a).slice(0, 6)}–${fmtDay(b).slice(0, 6)}`); act.push(s); tgt.push(has ? Math.round(t) : null);
    }
  } else {
    for (const k of months) {
      const [a, b] = monthBounds(k), to = Math.min(b, last); let s = 0, t = 0, has = false;
      for (let d = a; d <= to; d++) { s += byDay.get(d) || 0; const dt = dayTarget(d); if (dt != null) { t += dt; has = true; } }
      labels.push(monthLabel(k) + (to < b ? " (MTD)" : "")); act.push(s); tgt.push(has ? Math.round(t) : null);
    }
  }
  const tgtSum = tgt.filter((v) => v != null).length;
  main.append(block(2, "Actual vs target", `${planClusters && planClusters.size ? `${planClusters.size} plan clusters` : "All clusters"} · bars = HOTOs, dashed line = MOP (${grain === "dod" ? "per day" : grain === "wow" ? "per week" : "per month, to date for this month"}) · AOP line once the sheet is shared`,
    box([
      el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["mom", "Month on month"], ["wow", "Week on week"], ["dod", "Day on day"]], grain, (v) => setState({ hotoGrain: v }), "Grain"), grain === "dod" ? daySpanSwitch(state, setState) : null]),
      comboChart(labels, { label: "HOTOs", data: act, color: "--series-1" }, tgtSum ? { label: "MOP target", data: tgt, color: "--series-2" } : null, { yFormat: (v) => fmtInt(v), height: 290 }),
      tgtSum ? null : el("div", { class: "count", text: "No MOP for these periods yet (the Install Plan sheet is loaded month by month)." }),
    ])));

  // ---------------- 3 · cluster split: lane / payment / permits (this month's HOTOs)
  const split = ["lane", "payment", "permits"].includes(state.hotoSplit) ? state.hotoSplit : "lane";
  const catsOf = {
    lane: { cats: (data.meta.lanes || []).slice(), of: (x) => [label(f, "lane", x[c.lane])] },
    payment: { cats: ["DIRECT", "NBFC", "PSU"], of: (x) => [label(f, "payment_lane", x[c.payment_lane])] },
    permits: { cats: ["None", "LC", "NC", "PC"], of: (x) => { const p = c.permits != null ? label(f, "permits", x[c.permits]) : "None"; return p === "None" || !p ? ["None"] : p.split("+"); } },
  }[split];
  const catNames = { DIRECT: "Direct", NBFC: "NBFC", PSU: "PSU", None: "No permit change", LC: "Load change (LC)", NC: "Name change (NC)", PC: "Phase change (PC)" };
  const splitRow = (name, xs) => { const r = { name, n: xs.length, xs, by: {} }; for (const k of catsOf.cats) r.by[k] = xs.filter((x) => catsOf.of(x).includes(k)); return r; };
  const splitRows = clusters.map((name) => splitRow(name, cur.filter((x) => cl(x) === name))).filter((r) => r.n);
  const splitTot = splitRow("All clusters", cur); splitTot.footer = true;
  const splitCell = (k) => (v, r) => { const xs = r.by[k], p = r.n ? (100 * xs.length) / r.n : null; if (!xs.length) return el("span", { class: "count", text: "·" });
    return el("span", { class: "split-cell" }, [r.footer ? fmtInt(xs.length) : el("button", { type: "button", class: "link-btn", text: fmtInt(xs.length), onclick: (e) => { e.stopPropagation(); openRows(`${r.name} · ${catNames[k] || k}`, xs); } }), el("small", { text: pctTxt(p) })]); };
  const splitCols = [{ key: "name", label: "Cluster" }, { key: "n", label: "HOTOs", num: true, fmt: fmtInt },
    ...catsOf.cats.map((k) => ({ key: `c_${k}`, label: catNames[k] || k, num: true, fmt: splitCell(k) }))];
  splitRows.forEach((r) => catsOf.cats.forEach((k) => { r[`c_${k}`] = r.by[k].length; }));
  catsOf.cats.forEach((k) => { splitTot[`c_${k}`] = splitTot.by[k].length; });
  main.append(block(3, "Cluster split", `${ctx.curText} · ${ctx.curRange} · count and share of the cluster's HOTOs${split === "permits" ? " · a project with several permit changes counts in each" : ""}`,
    box([
      el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["lane", "Lane"], ["payment", "Payment"], ["permits", "Permits"]], split, (v) => setState({ hotoSplit: v }), "Split")]),
      dataTable(splitCols, splitRows, { sortKey: "n", sortDir: -1, maxHeight: 560, footer: splitTot }),
    ])));

  // ---------------- 4 · 10-day view
  const tenMonths = monthsBetween(monthBounds(shiftMonth(ctx.key, -6))[0], Math.min(monthBounds(ctx.key)[1], last));
  const bucketOf = (d, a) => (d - a < 10 ? 0 : d - a < 20 ? 1 : 2);
  const tenRows = tenMonths.map((k) => {
    const [a, b] = monthBounds(k), xs = rows.filter((x) => inR(x[c.hoto_day], [a, Math.min(b, last)]));
    const r = { month: monthLabel(k) + (b > last ? " (to date)" : ""), key: k, b: [[], [], []], total: xs.length };
    for (const x of xs) r.b[bucketOf(x[c.hoto_day], a)].push(x);
    const mop = (data.plan.months || {})[k] && planClusters ? [...planClusters].reduce((s, n) => s + (((data.plan.months[k].clusters[n]) || {}).hoto_mop || 0), 0) : null;
    r.mop = mop || null; return r;
  });
  const bCell = (i) => (v, r) => { const xs = r.b[i], p = r.total ? (100 * xs.length) / r.total : null;
    if (monthBounds(r.key)[0] + 10 * i > last) return el("span", { class: "count", text: "–" });  // bucket not started yet
    return el("span", { class: "split-cell" }, [
    el("button", { type: "button", class: "link-btn", text: fmtInt(xs.length), onclick: (e) => { e.stopPropagation(); openRows(`${r.month} · days ${["1–10", "11–20", "21–end"][i]}`, xs); } }), el("small", { text: pctTxt(p) })]); };
  main.append(block(4, "10-day view", "HOTOs in days 1–10, 11–20 and 21–month end · share of the month in grey · last 6 months and this month",
    box(dataTable([{ key: "month", label: "Month" }, { key: "b0", label: "Days 1–10", num: true, fmt: bCell(0) }, { key: "b1", label: "Days 11–20", num: true, fmt: bCell(1) },
      { key: "b2", label: "Days 21–end", num: true, fmt: bCell(2) }, { key: "total", label: "Month", num: true, fmt: fmtInt },
      { key: "mop", label: "MOP (plan clusters)", num: true, fmt: (v) => (v == null ? "–" : fmtInt(v)) }],
    tenRows.map((r) => ({ ...r, b0: r.b[0].length, b1: r.b[1].length, b2: r.b[2].length })).reverse(), { maxHeight: 420 }))));
}
