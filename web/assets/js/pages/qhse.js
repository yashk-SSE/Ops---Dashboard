// QHSE V3 (D-113): "Are installs safe and right first time, and who repeats mistakes?"  (D-71, D-82, docs/metrics/qhse.md)
// Site audited = task 046; closure TAT = 046 -> 051; open aging = days since audit; punch points / severity / risk flag as Q-5424.
// Physical-audit punch points by default; "+ IC audit fails" also counts failed IC-audit items (D-82).
//  1. Cluster table (BAU / Expansion folds): audited vs LMTD, % ZT, % ZT + High, open Z+H, open > 30 days, closure P50, repeat ICs / vendors.
//  2. Trend: sites audited (bars) vs sites with ZT + High (line).  3. Split: punch points by severity or component.
//  4. Open Z+H sites by days since audit.  5. Lists: open sites, open punch points, repeat ICs, repeat vendors.  6. Month on month.
import { el, dataTable, segmented, projectList } from "../ui.js";
import { label, fmtDay, bucketOf, matcher, monthBounds, monthLabel, monthsBetween } from "../data.js";
import { fmtInt, pct, tatSummary } from "../stats.js";
import * as M from "../metrics.js";
import { momTables, block, tierTable, openList, daySpanOf, daySpanSwitch } from "../layout.js";
import { comboChart } from "../charts.js";
import { qhseSiteList } from "../lists.js";

const SEVS = ["Zero Tolerance", "High", "Medium", "Low", "(blank)"];
const SKIP = new Set(["", "—", "Not mapped"]);
const box = (kids) => el("div", { class: "card" }, kids);
const pctTxt = (p) => (p == null ? "–" : `${p < 10 ? p.toFixed(1) : Math.round(p)}%`);
const dTxt = (v) => (v == null ? "–" : `${Math.round(v)} d`);

export function render(main, { data, state, setState, ctx }) {
  const f = data.qhse, c = f.ci, pc = f.ppci, asOf = data.meta.as_of_day, last = ctx.last;
  const match = matcher(f, state.filters, c);
  const keepIdx = []; f.facts.forEach((r, i) => { if (match(r)) keepIdx.push(i); });
  const rows = keepIdx.map((i) => f.facts[i]);
  const base = state.qhseBase === "installed" ? "installed" : "audited";
  const withIC = state.qhsePP === "all";
  const colZT = withIC ? c.zt_all : c.zt, colZH = withIC ? c.zh_all : c.zh, colPP = withIC ? c.n_pp_all : c.n_pp;
  const inR = M.inRange, cl = (x) => label(f, "cluster", x[c.cluster]);
  const list = qhseSiteList(f);
  const openSites = (title, xs) => openList({ title, sub: `${fmtInt(xs.length)} sites`, cols: list.cols, rows: xs.map(list.row), noun: "sites", filename: `${title.replace(/\W+/g, "_").toLowerCase()}.csv` });
  const btn = (xs, title) => (xs.length ? el("button", { type: "button", class: "link-btn", text: fmtInt(xs.length), onclick: (e) => { e.stopPropagation(); openSites(title, xs); } }) : el("span", { class: "count", text: "0" }));
  const audited = (rs, r) => rs.filter((x) => inR(x[c.audit_day], r));
  const baseRows = (rs, r) => (base === "installed" ? rs.filter((x) => inR(x[c.install_day], r) && x[c.audit_day] != null) : audited(rs, r));
  const rectified = (rs, r) => rs.filter((x) => inR(x[c.rect_day], r) && x[c.closure_tat] != null).map((x) => x[c.closure_tat]);
  const ageOf = (x) => (x[c.audit_day] == null ? null : asOf - x[c.audit_day]);
  const openZH = (x) => x[c.open_mech] > 0 || x[c.open_nonmech] > 0;
  // repeat offenders: same IC / vendor in the same cluster with 2+ ZT sites in the trailing 30 days
  const repeat = (dimKey) => {
    const g = new Map();
    for (const x of rows) {
      if (!x[colZT] || x[c.audit_day] == null || x[c.audit_day] < last - 29 || x[c.audit_day] > last) continue;
      const name = label(f, dimKey, x[c[dimKey]]); if (!name || name === "Not mapped" || name === "—") continue;
      const k = `${name}|${cl(x)}`; if (!g.has(k)) g.set(k, []); g.get(k).push(x);
    }
    return [...g.entries()].filter(([, xs]) => xs.length >= 2).map(([k, xs]) => ({ name: k.split("|")[0], cluster: k.split("|")[1], zt: xs.length, sites: xs.map((x) => x[c.sseid]).join(", ") }));
  };
  const icRep = repeat("ic"), venRep = repeat("vendor");

  // ---------------- 1 · cluster table
  const clusters = [...new Set(rows.map(cl))].filter((k) => !SKIP.has(k));
  const cRow = (name) => {
    const rs = rows.filter((x) => cl(x) === name), aud = audited(rs, ctx.cur), b = baseRows(rs, ctx.cur);
    const zt = b.filter((x) => x[colZT]), zh = b.filter((x) => x[colZH]), open = rs.filter(openZH), old = open.filter((x) => ageOf(x) > 30);
    return { name, aud, nA: aud.length, lm: audited(rs, ctx.prevSame).length, nB: b.length, zt, pZT: b.length ? pct(zt.length, b.length) : null, zh, pZH: b.length ? pct(zh.length, b.length) : null,
      open, nOpen: open.length, old, nOld: old.length, p50: tatSummary(rectified(rs, ctx.cur)).p50,
      ic: icRep.filter((r) => r.cluster === name).length, ven: venRep.filter((r) => r.cluster === name).length };
  };
  const cRows = clusters.map(cRow).filter((r) => r.nA || r.nOpen);
  const zTone = (p) => (p == null ? "flat" : p >= 10 ? "bad" : p >= 5 ? "warn" : "good");
  const cols = [
    { key: "name", label: "Cluster" },
    { key: "nA", label: "Sites audited MTD", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.aud, `${r.name} · sites audited ${ctx.curText}`)) },
    { key: "dl", label: "vs LMTD", num: true, fmt: (v, r) => { const d = M.delta(r.nA, r.lm, "count", "up"); return d ? el("span", { class: `delta ${d.tone}`, "data-tip": `LMTD ${fmtInt(r.lm)}`, text: `${d.arrow} ${d.text}` }) : "–"; } },
    { key: "pZT", label: "% with ZT", num: true, tip: `Sites ${base === "installed" ? "installed (and audited)" : "audited"} this month with a Zero Tolerance point${withIC ? " (incl. IC audit fails)" : " (physical audit)"}`,
      fmt: (v, r) => (v == null ? "–" : el("span", { class: "split-cell" }, [el("span", { class: `pill ${zTone(v)}`, text: pctTxt(v) }), r.footer ? null : el("small", {}, [btn(r.zt, `${r.name} · sites with ZT`)])])) },
    { key: "pZH", label: "% with ZT + High", num: true, fmt: (v, r) => (v == null ? "–" : el("span", { class: "split-cell" }, [pctTxt(v), r.footer ? null : el("small", {}, [btn(r.zh, `${r.name} · sites with ZT or High`)])])) },
    { key: "nOpen", label: "Open Z+H sites", num: true, tip: "Sites with an open Zero Tolerance or High punch point (live)", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.open, `${r.name} · open Z+H sites`)) },
    { key: "nOld", label: "> 30 days open", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.old, `${r.name} · Z+H open more than 30 days`)) },
    { key: "p50", label: "Closure P50", num: true, tip: "Audit (046) → rectification (051), sites rectified this month", fmt: dTxt },
    { key: "ic", label: "ICs 2+ ZT", num: true, tip: "ICs with 2+ ZT sites in this cluster in the last 30 days", fmt: fmtInt },
    { key: "ven", label: "Vendors 2+ ZT", num: true, fmt: fmtInt },
  ];
  const totalOf = (rs, name) => {
    const names = new Set(rs.map((r) => r.name)), sub = rows.filter((x) => names.has(cl(x))), b = baseRows(sub, ctx.cur), s = (k) => rs.reduce((a, r) => a + r[k], 0);
    return { footer: true, name, nA: s("nA"), lm: s("lm"), pZT: b.length ? pct(b.filter((x) => x[colZT]).length, b.length) : null, pZH: b.length ? pct(b.filter((x) => x[colZH]).length, b.length) : null,
      nOpen: s("nOpen"), nOld: s("nOld"), p50: tatSummary(rectified(sub, ctx.cur)).p50, ic: s("ic"), ven: s("ven") };
  };
  const sumParts = (t) => [el("span", {}, ["Audited ", el("b", { text: fmtInt(t.nA) })]), el("span", {}, ["ZT ", el("b", { text: pctTxt(t.pZT) })]), el("span", {}, ["Open Z+H ", el("b", { text: fmtInt(t.nOpen) })])];
  const allT = totalOf(cRows, "All clusters");
  main.append(block(1, "Quality by cluster", `${ctx.curText} · ${ctx.curRange} · open points live · click a count for its sites`,
    el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start", gap: "10px" } }, [
      el("span", { class: "rank-label", text: "% base" }), segmented([["audited", "Sites audited"], ["installed", "Sites installed"]], base, (v) => setState({ qhseBase: v }), "% base"),
      el("span", { class: "rank-label", text: "Punch points" }), segmented([["physical", "Physical audit"], ["all", "+ IC audit fails"]], withIC ? "all" : "physical", (v) => setState({ qhsePP: v }), "Punch points counted")]),
    el("div", { class: "count", style: { margin: "0 0 8px" }, text: `All clusters: ${fmtInt(allT.nA)} sites audited · ${pctTxt(allT.pZT)} with ZT · ${pctTxt(allT.pZH)} with ZT + High · ${fmtInt(allT.nOpen)} sites with open Z+H (${fmtInt(allT.nOld)} over 30 days) · ${icRep.length} ICs and ${venRep.length} vendors with 2+ ZT in 30 days` }),
    tierTable({ rows: cRows, cols, totalOf, sumParts, tier: state.tier, onTier: (v) => setState({ tier: v }), sortKey: "nA", sortDir: -1 })));

  // ---------------- 2 · trend
  const grain = ["mom", "wow", "dod"].includes(state.qhseGrain) ? state.qhseGrain : "wow";
  const aDay = new Map(), zDay = new Map();
  for (const x of rows) { const d = x[c.audit_day]; if (d == null) continue; aDay.set(d, (aDay.get(d) || 0) + 1); if (x[colZH]) zDay.set(d, (zDay.get(d) || 0) + 1); }
  const labels = [], as = [], zs = [];
  const addRange = (lbl, a, b) => { let n = 0, z = 0; for (let d = a; d <= b; d++) { n += aDay.get(d) || 0; z += zDay.get(d) || 0; } labels.push(lbl); as.push(n); zs.push(z); };
  if (grain === "dod") for (let d = last - (daySpanOf(state) - 1); d <= last; d++) addRange(fmtDay(d).slice(0, 6), d, d);
  else if (grain === "wow") for (let w = 11; w >= 0; w--) { const b = last - 7 * w, a = b - 6; addRange(`${fmtDay(a).slice(0, 6)}–${fmtDay(b).slice(0, 6)}`, a, b); }
  else for (const k of monthsBetween(data.meta.windows.YTD[0], last)) { const [a, b] = monthBounds(k); addRange(monthLabel(k) + (b > last ? " (MTD)" : ""), a, Math.min(b, last)); }
  main.append(block(2, "Audits and ZT + High over time", `Bars = sites audited, dashed line = sites audited with a ZT or High point${withIC ? " (incl. IC audit fails)" : ""}`,
    box([el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["mom", "Month on month"], ["wow", "Week on week"], ["dod", "Day on day"]], grain, (v) => setState({ qhseGrain: v }), "Grain"), grain === "dod" ? daySpanSwitch(state, setState) : null]),
      comboChart(labels, { label: "Sites audited", data: as, color: "--series-1" }, { label: "Sites with ZT + High", data: zs, color: "--series-2" }, { yFormat: (v) => fmtInt(v), height: 290 })])));

  // ---------------- 3 · split: punch points on sites audited this month, by severity or component
  const keep = new Set(keepIdx), audIdx = new Set(keepIdx.filter((i) => inR(f.facts[i][c.audit_day], ctx.cur)));
  const ppAll = f.pps.filter((p) => keep.has(p[pc.site]) && (withIC || label(f, "source", p[pc.source]) === "physical"));
  const ppCur = ppAll.filter((p) => audIdx.has(p[pc.site]));
  const by = state.qhseSplit === "component" ? "component" : "severity";
  const catOf0 = (p) => label(f, by, p[pc[by]]) || "(blank)";
  const counts = new Map(); for (const p of ppCur) counts.set(catOf0(p), (counts.get(catOf0(p)) || 0) + 1);
  const cats = by === "severity" ? SEVS.filter((s) => counts.has(s)) : [...[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k]) => k), ...(counts.size > 7 ? ["Other"] : [])];
  const catOf = (p) => (cats.includes(catOf0(p)) ? catOf0(p) : "Other");
  const siteCl = (p) => cl(f.facts[p[pc.site]]);
  const sRow = (name, ps) => { const r = { name, n: ps.length }; for (const k of cats) r[`c_${k}`] = ps.filter((p) => catOf(p) === k).length; return r; };
  const sRows = clusters.map((n) => sRow(n, ppCur.filter((p) => siteCl(p) === n))).filter((r) => r.n);
  const sTot = { ...sRow("All clusters", ppCur), footer: true };
  const sCell = (k) => (v, r) => (!v ? el("span", { class: "count", text: "·" }) : el("span", { class: "split-cell" }, [fmtInt(v), el("small", { text: pctTxt(pct(v, r.n)) })]));
  main.append(block(3, "What the punch points are", `Punch points on sites audited in ${ctx.curText} (${fmtInt(ppCur.length)})${withIC ? " incl. IC audit fails" : ", physical audit"} · count and share of the cluster's points`,
    box([el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["severity", "Severity"], ["component", "Component"]], by, (v) => setState({ qhseSplit: v }), "Split")]),
      dataTable([{ key: "name", label: "Cluster" }, { key: "n", label: "Punch points", num: true, fmt: fmtInt }, ...cats.map((k) => ({ key: `c_${k}`, label: k, num: true, fmt: sCell(k) }))], sRows, { sortKey: "n", sortDir: -1, maxHeight: 480, footer: sTot })])));

  // ---------------- 4 · open Z+H sites by days since audit
  const buckets = f.aging_buckets, bl = buckets.map((x) => x[2]);
  const openAll = rows.filter(openZH);
  const aRow = (name, xs) => { const r = { name, n: xs.length, by: {} }; for (const b of bl) { r.by[b] = xs.filter((x) => ageOf(x) != null && bucketOf(ageOf(x), buckets) === b); r[`b_${b}`] = r.by[b].length; } return r; };
  const aRows = clusters.map((n) => aRow(n, openAll.filter((x) => cl(x) === n))).filter((r) => r.n);
  const aTot = { ...aRow("All clusters", openAll), footer: true };
  const aCell = (b) => (v, r) => { const xs = r.by[b]; if (!xs.length) return el("span", { class: "count", text: "·" }); return r.footer ? fmtInt(xs.length) : btn(xs, `${r.name} · open Z+H, ${b} since audit`); };
  main.append(block(4, "Open Z+H: how long since audit", `${fmtInt(openAll.length)} sites with an open Zero Tolerance or High point · live · days since the audit`,
    box(dataTable([{ key: "name", label: "Cluster" }, { key: "n", label: "Open Z+H sites", num: true, fmt: fmtInt }, ...bl.map((b) => ({ key: `b_${b}`, label: b, num: true, fmt: aCell(b) }))], aRows, { sortKey: "n", sortDir: -1, maxHeight: 480, footer: aTot }))));

  // ---------------- 5 · lists
  const which = ["sites", "pps", "ic", "ven"].includes(state.qhseList) ? state.qhseList : "sites";
  const facts = f.facts;
  const ppRows = ppAll.filter((p) => label(f, "status", p[pc.status]) === "Open").map((p) => { const s = facts[p[pc.site]]; return {
    sseid: s[c.sseid], cluster: cl(s), cell: label(f, "cell", s[c.cell]), lane: label(f, "lane", s[c.lane]), flag: label(f, "flag", p[pc.flag]), severity: label(f, "severity", p[pc.severity]),
    code: label(f, "code", p[pc.code]), component: label(f, "component", p[pc.component]), issue: label(f, "issue", p[pc.issue]), audited: s[c.audit_day], days: ageOf(s), ic: label(f, "ic", s[c.ic]), vendor: label(f, "vendor", s[c.vendor]) }; });
  const repCols = (who) => [{ key: "name", label: who }, { key: "cluster", label: "Cluster" }, { key: "zt", label: "ZT sites (30 d)", num: true }, { key: "sites", label: "SSE IDs" }];
  const listNode = which === "sites" ? projectList(list.cols, openAll.map(list.row), { searchKeys: list.cols.filter((x) => !x.num).map((x) => x.key), sortKey: "audit", sortDir: 1, filename: "qhse_open_zh_sites.csv", noun: "sites" })
    : which === "pps" ? projectList([{ key: "sseid", label: "SSE ID" }, { key: "cluster", label: "Cluster" }, { key: "cell", label: "Cell" }, { key: "lane", label: "Lane" }, { key: "flag", label: "Risk type" }, { key: "severity", label: "Severity" },
      { key: "code", label: "PP code" }, { key: "component", label: "Component" }, { key: "issue", label: "Issue" }, { key: "audited", label: "Audited", fmt: fmtDay, csv: fmtDay }, { key: "days", label: "Days open", num: true }, { key: "ic", label: "IC" }, { key: "vendor", label: "Vendor" }],
      ppRows, { searchKeys: ["sseid", "cluster", "cell", "code", "ic", "vendor"], sortKey: "days", sortDir: -1, filename: "qhse_open_punch_points.csv", noun: "punch points" })
    : projectList(repCols(which === "ic" ? "IC" : "Vendor"), which === "ic" ? icRep : venRep, { searchKeys: ["name", "cluster", "sites"], sortKey: "zt", sortDir: -1, filename: which === "ic" ? "qhse_repeat_ics.csv" : "qhse_repeat_vendors.csv", noun: which === "ic" ? "ICs" : "vendors" });
  main.append(block(5, "Lists", "Open Z+H sites, open punch points, and ICs / vendors with 2+ ZT sites in the same cluster in the last 30 days (warning / training)",
    el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["sites", `Open Z+H sites (${fmtInt(openAll.length)})`], ["pps", `Open punch points (${fmtInt(ppRows.length)})`], ["ic", `Repeat ICs (${icRep.length})`], ["ven", `Repeat vendors (${venRep.length})`]], which, (v) => setState({ qhseList: v }), "List")]),
    box(listNode)));

  // ---------------- 6 · month on month
  const share = (col) => (rs, r) => { const b = baseRows(rs, r); return b.length ? pct(b.filter((x) => x[col]).length, b.length) : null; };
  const metrics = [
    { id: "audited", label: "Sites audited", src: "q", kind: "count", good: "up", value: (rs, r) => audited(rs, r).length, pick: audited },
    { id: "zt", label: "% sites with ZT", src: "q", kind: "pct", good: "down", value: share(colZT), base: (rs, r) => baseRows(rs, r).length },
    { id: "zh", label: "% sites with ZT + High", src: "q", kind: "pct", good: "down", value: share(colZH), base: (rs, r) => baseRows(rs, r).length },
    { id: "pps", label: "Punch points raised", src: "q", kind: "count", good: "down", value: (rs, r) => audited(rs, r).reduce((s, x) => s + x[colPP], 0) },
    { id: "close50", label: "Closure TAT P50", src: "q", kind: "days", good: "down", minBase: 15, value: (rs, r) => tatSummary(rectified(rs, r)).p50, base: (rs, r) => rectified(rs, r).length },
    { id: "close90", label: "Closure TAT P90", src: "q", kind: "days", good: "down", minBase: 15, value: (rs, r) => tatSummary(rectified(rs, r)).p90, base: (rs, r) => rectified(rs, r).length },
  ];
  main.append(block(6, "Month on month", "Month to date and full months, last 6 months", momTables(metrics, ctx, { q: { file: f, ci: c, rows, list } }, { state, setState })));
}
