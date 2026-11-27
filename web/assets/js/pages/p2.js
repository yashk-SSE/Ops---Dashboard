// Install -> Commissioning V3 (D-112): "How fast do installs get commissioned, and what blocks them?"
//  1. Cluster table (BAU / Expansion folds): commissioned MTD vs LMTD, installs MTD, pending, days of backlog, past the limit
//     (global stuck rule, India-wide install -> commissioning), over 30 days, install -> commissioning P50 / P75 / P90.
//  2. Trend: commissioned (bars) vs installs (line), month / week / day.
//  3. Split: delay reason (CT reason or system tag) by cluster.
//  4. Cluster x current step (chain order).  5. Month on month (above the list, D-123).  6. Pending list.
// Definitions: docs/metrics/p2-install-to-commissioning.md (D-34, D-35, D-42, D-48), step order docs/metrics/stage-glossary.md.
import { el, dataTable, segmented, projectList } from "../ui.js";
import { label, fmtDay, monthBounds, monthLabel, monthsBetween } from "../data.js";
import { tatSummary, fmtInt } from "../stats.js";
import * as M from "../metrics.js";
import { momTables, block, tierTable, openList, stageMatrix, daySpanOf, daySpanSwitch, chartClusters } from "../layout.js";
import { comboChart } from "../charts.js";
import { p2FactList, p2PendingList } from "../lists.js";

const SUB_ORDER = ["Sanction / Feasibility", "NM Application", "DCR Certificate", "WCR Creation", "WCR Sign", "WCR Submission", "Meter Testing", "NOC Visit", "Release Order", "Meter Installation", "Commissioning"];
const SKIP = new Set(["", "—", "Not mapped"]);
const box = (kids) => el("div", { class: "card" }, kids);
const pctTxt = (p) => (p == null ? "–" : `${Math.round(p)}%`);
const dTxt = (v) => (v == null ? "–" : `${Math.round(v)} d`);

export function render(main, { data, state, setState, ctx }) {
  const f = data.p2, ci = f.ci, pci = f.pci;
  const rows = M.p2Rows(data, state), pend = M.p2Pending(data, state);
  const inR = M.inRange, last = ctx.last, asOf = data.meta.as_of_day, R = M.stuckShort(ctx);
  const cl = (x) => label(f, "cluster", x[ci.cluster]), clp = (x) => label(f, "cluster", x[pci.cluster]);
  const factList = p2FactList(f), pendList = p2PendingList(f);
  const openFacts = (title, xs) => openList({ title, sub: `${fmtInt(xs.length)} projects`, cols: factList.cols, rows: xs.map(factList.row), filename: `${title.replace(/\W+/g, "_").toLowerCase()}.csv` });
  const lateCols = [...pendList.cols, { key: "late", label: "Late", tip: `Pending longer than the install → commissioning limit (${R}, India)` }];
  const lateRow = (x) => ({ ...pendList.row(x), late: limit != null && x[pci.aging_days] > limit ? `Late (past ${R})` : "Not late" });
  const openPend = (title, xs) => openList({ title, sub: `${fmtInt(xs.length)} projects · live`, cols: lateCols, rows: [...xs].sort((a, b) => b[pci.aging_days] - a[pci.aging_days]).map(lateRow), filename: `${title.replace(/\W+/g, "_").toLowerCase()}.csv` });
  const btn = (xs, onClick) => (xs.length ? el("button", { type: "button", class: "link-btn", text: fmtInt(xs.length), onclick: (e) => { e.stopPropagation(); onClick(); } }) : el("span", { class: "count", text: "0" }));
  const limit = M.commStuckLimit(data, ctx);  // India-wide install -> commissioning limit by the stuck rule
  const closed = (rs, r) => rs.filter((x) => inR(x[ci.commissioned_day], r) && x[ci.tat_days] != null).map((x) => x[ci.tat_days]);

  // ---------------- 1 · cluster table
  const clusters = [...new Set([...rows.map(cl), ...pend.map(clp)])].filter((k) => !SKIP.has(k));
  const inst30 = (rs) => rs.filter((x) => x[ci.installed_day] != null && x[ci.installed_day] > asOf - 31 && x[ci.installed_day] <= asOf - 1).length;
  const cRow = (name) => {
    const rs = rows.filter((x) => cl(x) === name), ps = pend.filter((x) => clp(x) === name);
    const comm = rs.filter((x) => inR(x[ci.commissioned_day], ctx.cur)), lm = rs.filter((x) => inR(x[ci.commissioned_day], ctx.prevSame)).length;
    const inst = rs.filter((x) => inR(x[ci.installed_day], ctx.cur)), t = tatSummary(closed(rs, ctx.cur)), i30 = inst30(rs);
    const late = limit == null ? [] : ps.filter((x) => x[pci.aging_days] > limit), old = ps.filter((x) => x[pci.aging_days] > 30);
    return { name, comm, nC: comm.length, lm, inst, nI: inst.length, ps, nP: ps.length, backlog: i30 ? (ps.length / i30) * 30 : null, late, nL: late.length, old, nO: old.length, p50: t.p50, p75: t.p75, p90: t.p90 };
  };
  const cRows = clusters.map(cRow).filter((r) => r.nC || r.nP || r.nI);
  const cols = [
    { key: "name", label: "Cluster" },
    { key: "nC", label: "Commissioned MTD", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.comm, () => openFacts(`${r.name} · commissioned ${ctx.curText}`, r.comm))) },
    { key: "dl", label: "vs LMTD", num: true, tip: "Commissioned MTD vs the same days last month (no plan for commissioning yet; AOP when shared)", fmt: (v, r) => { const d = M.delta(r.nC, r.lm, "count", "up"); return d ? el("span", { class: `delta ${d.tone}`, "data-tip": `LMTD ${fmtInt(r.lm)}`, text: `${d.arrow} ${d.text}` }) : "–"; } },
    { key: "nI", label: "Installs MTD", num: true, tip: "Inflow into this stage", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.inst, () => openFacts(`${r.name} · installed ${ctx.curText}`, r.inst))) },
    { key: "nP", label: "Pending", num: true, tip: "Installed, not commissioned (live)", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.ps, () => openPend(`${r.name} · pending commissioning`, r.ps))) },
    { key: "backlog", label: "Days of backlog", num: true, tip: "Pending ÷ installs in the last 30 days × 30: days of installs waiting to be commissioned", fmt: (v) => (v == null ? "–" : v.toFixed(1)) },
    { key: "nL", label: `Past ${R}`, num: true, tip: `Pending longer than the install → commissioning ${R} (${limit == null ? "–" : Math.round(limit)} days, India, last 6 full months)`, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.late, () => openPend(`${r.name} · pending past ${R}`, r.late))) },
    { key: "nO", label: "> 30 days", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.old, () => openPend(`${r.name} · pending more than 30 days`, r.old))) },
    { key: "p50", label: "Install → comm. P50", num: true, tip: "Projects commissioned this month: days from installation", fmt: dTxt },
    { key: "p75", label: "P75", num: true, fmt: dTxt },
    { key: "p90", label: "P90", num: true, fmt: dTxt },
  ];
  const totalOf = (rs, name) => {
    const names = new Set(rs.map((r) => r.name)), sub = rows.filter((x) => names.has(cl(x))), t = tatSummary(closed(sub, ctx.cur)), s = (k) => rs.reduce((a, r) => a + r[k], 0), i30 = inst30(sub);
    return { footer: true, name, nC: s("nC"), lm: s("lm"), nI: s("nI"), nP: s("nP"), backlog: i30 ? (s("nP") / i30) * 30 : null, nL: s("nL"), nO: s("nO"), p50: t.p50, p75: t.p75, p90: t.p90 };
  };
  const sumParts = (t) => [el("span", {}, ["Commissioned ", el("b", { text: fmtInt(t.nC) })]), el("span", {}, ["Pending ", el("b", { text: fmtInt(t.nP) })]),
    el("span", {}, ["Backlog ", el("b", { text: t.backlog == null ? "–" : `${t.backlog.toFixed(1)} d` })]), el("span", {}, [`Past ${R} `, el("b", { text: fmtInt(t.nL) })])];
  const allT = totalOf(cRows, "All clusters");
  const dAll = M.delta(allT.nC, allT.lm, "count", "up");
  main.append(block(1, "Install → commissioning by cluster", `${ctx.curText} · ${ctx.curRange} · pending live · click a count for its projects`,
    el("div", { class: "count", style: { margin: "0 0 8px" }, text: `All clusters: ${fmtInt(allT.nC)} commissioned${dAll ? ` (${dAll.arrow} ${dAll.text} vs LMTD ${fmtInt(allT.lm)})` : ""} · ${fmtInt(allT.nP)} pending · ${allT.backlog == null ? "–" : allT.backlog.toFixed(1)} days of backlog · ${fmtInt(allT.nL)} past ${R} (${limit == null ? "–" : Math.round(limit)} d) · P50 ${dTxt(allT.p50)}` }),
    tierTable({ rows: cRows, cols, totalOf, sumParts, tier: state.tier, onTier: (v) => setState({ tier: v }), sortKey: "nP", sortDir: -1 })));

  // ---------------- 2 · trend: commissioned vs installs
  // D-125: the graph's own cluster picker (this graph only, inside the top-bar filters)
  const cp = chartClusters(state, setState, "p2", rows.map(cl));
  const gRows = rows.filter((x) => cp.keep(cl(x)));
  const grain = ["mom", "wow", "dod"].includes(state.p2Grain) ? state.p2Grain : "wow";
  const byDay = (field) => { const m = new Map(); for (const x of gRows) { const d = x[ci[field]]; if (d != null) m.set(d, (m.get(d) || 0) + 1); } return m; };
  const cDay = byDay("commissioned_day"), iDay = byDay("installed_day");
  const labels = [], cs = [], is = [];
  const addRange = (lbl, a, b) => { let c = 0, i = 0; for (let d = a; d <= b; d++) { c += cDay.get(d) || 0; i += iDay.get(d) || 0; } labels.push(lbl); cs.push(c); is.push(i); };
  if (grain === "dod") for (let d = last - (daySpanOf(state) - 1); d <= last; d++) addRange(fmtDay(d).slice(0, 6), d, d);
  else if (grain === "wow") for (let w = 11; w >= 0; w--) { const b = last - 7 * w, a = b - 6; addRange(`${fmtDay(a).slice(0, 6)}–${fmtDay(b).slice(0, 6)}`, a, b); }
  else for (const k of monthsBetween(data.meta.windows.YTD[0], last)) { const [a, b] = monthBounds(k); addRange(monthLabel(k) + (b > last ? " (MTD)" : ""), a, Math.min(b, last)); }
  main.append(block(2, "Commissioned vs installed over time", "Bars = commissioned, dashed line = installs (the inflow) · when the bars sit below the line, the backlog grows" + cp.note,
    box([el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["mom", "Month on month"], ["wow", "Week on week"], ["dod", "Day on day"]], grain, (v) => setState({ p2Grain: v }), "Grain"), grain === "dod" ? daySpanSwitch(state, setState) : null, cp.node]),
      comboChart(labels, { label: "Commissioned", data: cs, color: "--series-1" }, { label: "Installed", data: is, color: "--series-2" }, { yFormat: (v) => fmtInt(v), height: 290 })])));

  // ---------------- 3 · split: delay reason by cluster
  const reasonKey = state.p2Reason === "dependency" ? "dependency" : "ct_reason";
  const reasonOf = (x) => label(f, reasonKey, x[pci[reasonKey]]) || "–";
  const counts = new Map(); for (const x of pend) counts.set(reasonOf(x), (counts.get(reasonOf(x)) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k]) => k);
  const catOf = (x) => (top.includes(reasonOf(x)) ? reasonOf(x) : "Other");
  const cats = [...top, ...(counts.size > top.length ? ["Other"] : [])];
  const sRow = (name, xs) => { const r = { name, n: xs.length, by: {} }; for (const k of cats) { r.by[k] = xs.filter((x) => catOf(x) === k); r[`c_${k}`] = r.by[k].length; } return r; };
  const sRows = clusters.map((n) => sRow(n, pend.filter((x) => clp(x) === n))).filter((r) => r.n);
  const sTot = { ...sRow("All clusters", pend), footer: true };
  const sCell = (k) => (v, r) => { const xs = r.by[k], p = r.n ? (100 * xs.length) / r.n : null; if (!xs.length) return el("span", { class: "count", text: "·" });
    return el("span", { class: "split-cell" }, [r.footer ? fmtInt(xs.length) : btn(xs, () => openPend(`${r.name} · ${k}`, xs)), el("small", { text: pctTxt(p) })]); };
  main.append(block(3, "Why it waits", `${fmtInt(pend.length)} pending · delay reason on the project · count and share of the cluster's pending · ${reasonKey === "ct_reason" ? "CT reason = the Pan India sheet's sub-reason (interim copy)" : "system tag = the dependency on the current OMS task (tagged on a minority)"}`,
    box([el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["ct_reason", "CT reason"], ["dependency", "System tag"]], reasonKey, (v) => setState({ p2Reason: v }), "Reason")]),
      dataTable([{ key: "name", label: "Cluster" }, { key: "n", label: "Pending", num: true, fmt: fmtInt }, ...cats.map((k) => ({ key: `c_${k}`, label: k, num: true, fmt: sCell(k) }))], sRows, { sortKey: "n", sortDir: -1, maxHeight: 520, footer: sTot })])));

  // ---------------- 4 · cluster x current step
  const holdOn = !!state.stageHold;
  const pendSm = M.p2Pending(data, { ...state, hideCancelled: false }).filter((x) => { const s = label(f, "state", x[pci.state]); return s === "active" || (holdOn && s === "on-hold"); });
  main.append(block(4, "Where commissioning waits: cluster × current step", `${fmtInt(pendSm.length)} installed, not commissioned (${holdOn ? "active + on-hold" : "active"}) · live · late = more than ${limit == null ? "–" : Math.round(limit)} days since install (${R}, India; no step-level limit yet)`,
    el("div", { class: "card-actions", style: { marginBottom: "10px", justifyContent: "flex-start" } }, [segmented([["active", "Active"], ["hold", "Active + on-hold"]], holdOn ? "hold" : "active", (v) => setState({ stageHold: v === "hold" }), "Projects")]),
    box(stageMatrix({ items: pendSm, groupOf: (x) => label(f, "cluster", x[pci.cluster]), stageOf: (x) => label(f, "substage", x[pci.substage]),
      order: SUB_ORDER, late: (x) => limit != null && x[pci.aging_days] > limit, onCell: (xs, title) => openPend(title, xs), lateWord: `past ${R}` }))));

  // ---------------- 6 · pending list (shown below the month on month)
  const listBlock = block(6, "Pending commissioning: project list", `${fmtInt(pend.length)} projects · live · longest wait first${state.hideCancelled ? " · active only" : ""}`,
    box(projectList(pendList.cols, [...pend].sort((a, b) => b[pci.aging_days] - a[pci.aging_days]).map(pendList.row), { searchKeys: pendList.cols.filter((x) => !x.num).map((x) => x.key), sortKey: "days", sortDir: -1, filename: "pending_commissioning.csv" })));
  main.append(listBlock);  // the month on month goes in above it (D-123)

  // ---------------- 5 · month on month (inserted above the list, D-123)
  const tat = (key) => (rs, r) => tatSummary(closed(rs, r))[key], nClosed = (rs, r) => closed(rs, r).length;
  const metrics = [
    { id: "comm", label: "Commissioned", src: "f", kind: "count", good: "up", value: (rs, r) => rs.filter((x) => inR(x[ci.commissioned_day], r)).length, pick: (rs, r) => rs.filter((x) => inR(x[ci.commissioned_day], r)) },
    { id: "inst", label: "Installed (039B)", src: "f", kind: "count", good: "up", value: (rs, r) => rs.filter((x) => inR(x[ci.installed_day], r)).length, pick: (rs, r) => rs.filter((x) => inR(x[ci.installed_day], r)) },
    { id: "p50", label: "Install → commissioning P50", src: "f", kind: "days", good: "down", value: tat("p50"), base: nClosed },
    { id: "p75", label: "Install → commissioning P75", src: "f", kind: "days", good: "down", value: tat("p75"), base: nClosed },
    { id: "p90", label: "Install → commissioning P90", src: "f", kind: "days", good: "down", value: tat("p90"), base: nClosed },
  ];
  main.insertBefore(block(5, "Month on month", "Month to date and full months, last 6 months", momTables(metrics, ctx, { f: { file: f, ci, rows, list: factList } }, { state, setState })), listBlock);
}
