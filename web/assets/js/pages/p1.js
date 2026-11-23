// HOTO -> Installation V3 (D-111): "How fast do HOTOs become installs, and where do they wait?"
//  1. Cluster table (BAU / Expansion folds): HOTOs MTD, M0 / M1 conversion vs last month, HOTO -> install P50 / P75 / P90,
//     not installed, stuck (global stuck rule), over 90 days.
//  2. Trend: M0 / M1 / M2 conversion by month, or HOTO -> install P50 / P90 by month / week / day.
//  3. HOTO-day skew (Prasanna's TAT brief): share of HOTOs installed in the same month, by HOTO day of month.
//  4. Cluster x lane TAT with the network's best per lane (the brief's "art of the possible").
//  5. Cluster x stage (Pre-RTI / RTI / Post-RTI, or OMS status).  6. Not-installed list.  7. Month on month.
// Definitions: docs/metrics/p1-hoto-to-install.md, docs/metrics/stage-glossary.md, docs/dashboard/redesign-v3-pages-proposal.md.
import { el, dataTable, segmented, projectList } from "../ui.js";
import { label, fmtDay, monthKey, monthBounds, monthLabel, monthsBetween, shiftMonth } from "../data.js";
import { fmtInt, percentile } from "../stats.js";
import * as M from "../metrics.js";
import { momTables, block, tierTable, openList, stageMatrix, daySpanOf, daySpanSwitch } from "../layout.js";
import { lineChart } from "../charts.js";
import { p1FactList, p2FactList, p1PendingList } from "../lists.js";
import { pushModel } from "../push.js";

const SKIP = new Set(["", "—", "Not mapped"]);
const OMS_ORDER = ["Pending Onboarding", "Pending DEV Schedule", "DEV scheduled", "In 3D Design", "3D Design Approval", "3D Design & Installation guide verification",
  "Awaiting Client Design Approval", "Payment 1 Scheduled", "Payment 1 Confirmation", "EMI Dependancy System Task", "Payment 2 Scheduled", "Payment 2 Confirmation",
  "Pending PO Approval", "Pending Material Delivery Schedule", "Pending Material Delivery", "Pending Installation"];
const RTI_GROUPS = [
  { name: "Pre-RTI", stages: ["Design approval", "Bill correction done", "Sanction (permit)", "Payment ready (P1 collected / RFD)"] },
  { name: "RTI", stages: ["Payment 1 reflected", "ERP raised"] },
  { name: "Post-RTI", stages: ["Installation planned", "Installation done"] },
];
const SKEW = [[1, 7, "Days 1–7"], [8, 14, "8–14"], [15, 21, "15–21"], [22, 27, "22–27"], [28, 31, "28–31"]];
const MIN_LANE_N = 40;  // the brief: cells with 40+ installs carry a distribution
const pctTxt = (p) => (p == null ? "–" : `${Math.round(p)}%`);
const box = (kids) => el("div", { class: "card" }, kids);
const convTone = (p) => (p == null ? "flat" : p >= 50 ? "good" : p >= 25 ? "warn" : "bad");

export function render(main, { data, state, setState, ctx }) {
  const f = data.p1, ci = f.ci, pci = f.pci, stages = f.stages, p2 = data.p2;
  const rows = M.p1Rows(data, state), p2r = M.p2Rows(data, state);
  const install = stages.find((s) => s.id === "F07") || stages.at(-1);
  const inR = M.inRange, last = ctx.last, R = M.stuckShort(ctx);
  const cl = (x) => label(f, "cluster", x[ci.cluster]), cl2 = (x) => label(p2, "cluster", x[p2.ci.cluster]);
  const instDay = (x) => { const d = x[ci[install.id]]; return d != null && d >= 0 ? x[ci.hoto_day] + d : null; };
  const conv = (rs, r, k) => M.mConversion(rs, r, k, (x) => x[ci.hoto_day], instDay);
  const hotoList = p1FactList(f, install.id), pendList = p1PendingList(f);
  const openHotos = (title, xs) => openList({ title, sub: `${fmtInt(xs.length)} HOTOs`, cols: hotoList.cols, rows: xs.map(hotoList.row), filename: `${title.replace(/\W+/g, "_").toLowerCase()}.csv` });
  const lateCols = [...pendList.cols, { key: "late", label: "Late", tip: `Past its stage's limit in days from HOTO (stuck rule: ${R}, top bar)` }];
  const lateRow = (x) => ({ ...pendList.row(x), late: push.isStuck(x) ? `Late (past ${R})` : "Not late" });
  const openPend = (title, xs) => openList({ title, sub: `${fmtInt(xs.length)} projects · live · filter Late to see the late ones`, cols: lateCols, rows: [...xs].sort((a, b) => b[pci.days_since_hoto] - a[pci.days_since_hoto]).map(lateRow), filename: `${title.replace(/\W+/g, "_").toLowerCase()}.csv` });
  const btn = (n, onClick) => (n ? el("button", { type: "button", class: "link-btn", text: fmtInt(n), onclick: (e) => { e.stopPropagation(); onClick(); } }) : el("span", { class: "count", text: "0" }));

  // ---------------- 1 · cluster table
  const push = pushModel(data, state, ctx);  // active not-installed projects per cluster, with the stuck rule
  // clusters with HOTOs in the data, plus any cluster that only has old pending projects, so totals match the pipeline
  const clusters = [...new Set([...rows.map(cl), ...push.clusters])].filter((k) => !SKIP.has(k));
  const cRow = (name) => {
    const rs = rows.filter((x) => cl(x) === name), r2 = p2r.filter((x) => cl2(x) === name);
    const hotos = rs.filter((x) => inR(x[ci.hoto_day], ctx.cur));
    const m0 = conv(rs, ctx.cur, 0), m0lm = conv(rs, ctx.prevSame, 0), m1 = conv(rs, ctx.cur, 1), m1lm = conv(rs, ctx.prevSame, 1);
    const tat = M.hotoToInstall(data, r2, ctx.cur), pend = push.of(name), stuck = push.stuck(name), old = pend.filter((x) => x[pci.days_since_hoto] > 90);
    return { name, hotos, nH: hotos.length, m0: m0.pct, m0b: m0.base, m0lm: m0lm.pct, m1: m1.pct, m1lm: m1lm.pct, p50: tat.p50, p75: tat.p75, p90: tat.p90, nTat: tat.count,
      pend, nP: pend.length, stuck, nS: stuck.length, old, nO: old.length };
  };
  const cRows = clusters.map(cRow);
  const ptDelta = (cur, prev) => (cur == null || prev == null ? null : cur - prev);
  const convCell = (key, lmKey) => (v, r) => {
    if (v == null) return "–";
    const d = ptDelta(v, r[lmKey]);
    return el("span", { class: "split-cell", "data-tip": `${r.name}: ${v.toFixed(1)}% · same days last month ${r[lmKey] == null ? "–" : `${r[lmKey].toFixed(1)}%`}` }, [`${v.toFixed(1)}%`,
      d == null ? null : el("small", { class: d >= 0 ? "t-good" : "t-bad", text: `${d >= 0 ? "+" : ""}${d.toFixed(1)}` })]);
  };
  const dCell = (v) => (v == null ? "–" : `${Math.round(v)} d`);
  const cols = [
    { key: "name", label: "Cluster" },
    { key: "nH", label: "HOTOs MTD", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(v, () => openHotos(`${r.name} · HOTOs ${ctx.curText}`, r.hotos))) },
    { key: "m0", label: "M0 conversion", num: true, tip: "Share of this month's HOTOs installed in the same month (to the same day); small = points vs the same days last month", fmt: convCell("m0", "m0lm") },
    { key: "m1", label: "M1 conversion", num: true, tip: "Share of last month's HOTOs installed this month (to the same day); small = points vs the same days last month", fmt: convCell("m1", "m1lm") },
    { key: "p50", label: "HOTO → install P50", num: true, tip: "Projects installed this month: days from HOTO to installation", fmt: dCell },
    { key: "p75", label: "P75", num: true, fmt: dCell },
    { key: "p90", label: "P90", num: true, fmt: dCell },
    { key: "nP", label: "Not installed", num: true, tip: "Active projects handed over and not installed (live)", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(v, () => openPend(`${r.name} · not installed`, r.pend))) },
    { key: "nS", label: "Stuck", num: true, tip: `Active, past its stage's limit in days from HOTO (stuck rule: ${R})`, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(v, () => openPend(`${r.name} · stuck`, r.stuck))) },
    { key: "nO", label: "> 90 days", num: true, tip: "Active, handed over more than 90 days ago, not installed", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(v, () => openPend(`${r.name} · not installed > 90 days`, r.old))) },
  ];
  const totalOf = (rs, name) => {
    const names = new Set(rs.map((r) => r.name)), sub = rows.filter((x) => names.has(cl(x))), sub2 = p2r.filter((x) => names.has(cl2(x)));
    const m0 = conv(sub, ctx.cur, 0), m0lm = conv(sub, ctx.prevSame, 0), m1 = conv(sub, ctx.cur, 1), m1lm = conv(sub, ctx.prevSame, 1), tat = M.hotoToInstall(data, sub2, ctx.cur);
    const s = (k) => rs.reduce((a, r) => a + r[k], 0);
    return { footer: true, name, nH: s("nH"), m0: m0.pct, m0lm: m0lm.pct, m1: m1.pct, m1lm: m1lm.pct, p50: tat.p50, p75: tat.p75, p90: tat.p90, nP: s("nP"), nS: s("nS"), nO: s("nO") };
  };
  const sumParts = (t) => [el("span", {}, ["HOTOs ", el("b", { text: fmtInt(t.nH) })]), el("span", {}, ["M0 ", el("b", { text: t.m0 == null ? "–" : `${t.m0.toFixed(1)}%` })]),
    el("span", {}, ["P50 ", el("b", { text: dCell(t.p50) })]), el("span", {}, ["Stuck ", el("b", { text: fmtInt(t.nS) })])];
  const allT = totalOf(cRows, "All clusters");
  main.append(block(1, "HOTO → installation by cluster", `${ctx.curText} · ${ctx.curRange} · conversion vs the same days last month · TAT of projects installed this month · pipeline live (active) · click a count for its projects`,
    el("div", { class: "count", style: { margin: "0 0 8px" }, text: `All clusters: ${fmtInt(allT.nH)} HOTOs · M0 ${allT.m0 == null ? "–" : `${allT.m0.toFixed(1)}%`} · M1 ${allT.m1 == null ? "–" : `${allT.m1.toFixed(1)}%`} · HOTO → install P50 ${dCell(allT.p50)} · ${fmtInt(allT.nP)} not installed, ${fmtInt(allT.nS)} stuck (${R})` }),
    tierTable({ rows: cRows, cols, totalOf, sumParts, tier: state.tier, onTier: (v) => setState({ tier: v }), sortKey: "nH", sortDir: -1 })));

  // ---------------- 2 · trend: conversion or TAT
  const trend = state.p1Trend === "tat" ? "tat" : "conv";
  const grain = ["mom", "wow", "dod"].includes(state.p1Grain) ? state.p1Grain : "mom";
  let chart, note;
  if (trend === "conv") {
    const months = monthsBetween(monthBounds(shiftMonth(ctx.key, -6))[0], Math.min(monthBounds(ctx.key)[1], last));
    const range = (k) => { const [a, b] = monthBounds(k); return [a, Math.min(b, last)]; };
    const series = [0, 1, 2].map((k) => months.map((m) => { const v = conv(rows, range(m), k); return v.base >= 30 && v.pct != null ? Math.round(v.pct * 10) / 10 : null; }));
    chart = lineChart(months.map((m) => monthLabel(m) + (monthBounds(m)[1] > last ? " (MTD)" : "")), [
      { label: "M0", data: series[0], color: "--series-1" }, { label: "M1", data: series[1], color: "--series-2" }, { label: "M2", data: series[2], color: "--series-3" }], { yFormat: (v) => `${v}%`, height: 290 });
    note = "M0 = HOTOs of the month installed in the same month · M1 = last month's HOTOs installed in this month · M2 = two months back · this month to date";
  } else {
    const labels = [], p50 = [], p90 = [];
    const push2 = (lbl, r) => { const t = M.hotoToInstall(data, p2r, r); labels.push(lbl); p50.push(t.count >= 20 ? t.p50 : null); p90.push(t.count >= 20 ? t.p90 : null); };
    if (grain === "dod") for (let d = last - (daySpanOf(state) - 1); d <= last; d++) push2(fmtDay(d).slice(0, 6), [d, d]);
    else if (grain === "wow") for (let w = 11; w >= 0; w--) { const b = last - 7 * w, a = b - 6; push2(`${fmtDay(a).slice(0, 6)}–${fmtDay(b).slice(0, 6)}`, [a, b]); }
    else for (const k of monthsBetween(data.meta.windows.YTD[0], last)) { const [a, b] = monthBounds(k); push2(monthLabel(k) + (b > last ? " (MTD)" : ""), [a, Math.min(b, last)]); }
    chart = lineChart(labels, [{ label: "P50", data: p50, color: "--series-1" }, { label: "P90", data: p90, color: "--series-2" }], { yFormat: (v) => `${v} d`, height: 290 });
    note = "Projects installed in each period: days from HOTO to installation (periods with fewer than 20 installs left blank)";
  }
  main.append(block(2, "Conversion and speed over time", note,
    box([el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start", gap: "10px" } }, [
      segmented([["conv", "Conversion (M0 / M1 / M2)"], ["tat", "HOTO → install TAT"]], trend, (v) => setState({ p1Trend: v }), "Trend"),
      trend === "tat" ? segmented([["mom", "Month"], ["wow", "Week"], ["dod", "Day"]], grain, (v) => setState({ p1Grain: v }), "Grain") : null,
      trend === "tat" && grain === "dod" ? daySpanSwitch(state, setState) : null]), chart])));

  // ---------------- 3 · HOTO-day skew (last 3 full months of HOTOs)
  const skewMonths = [shiftMonth(ctx.key, -3), shiftMonth(ctx.key, -2), shiftMonth(ctx.key, -1)];
  const skFrom = monthBounds(skewMonths[0])[0], skTo = monthBounds(skewMonths[2])[1];
  const dom = (d) => new Date(Date.UTC(2020, 0, 1) + d * 86400000).getUTCDate();
  const skewCells = (rs) => SKEW.map(([a, b]) => {
    const xs = rs.filter((x) => { const h = x[ci.hoto_day]; if (h == null || h < skFrom || h > skTo) return false; const dd = dom(h); return dd >= a && dd <= b; });
    const hit = xs.filter((x) => { const i = instDay(x); return i != null && monthKey(i) === monthKey(x[ci.hoto_day]); });
    return { n: xs.length, hit: hit.length, p: xs.length ? (100 * hit.length) / xs.length : null, miss: xs.filter((x) => !hit.includes(x)) };
  });
  const lateShare = (rs) => { const xs = rs.filter((x) => inR(x[ci.hoto_day], [skFrom, skTo])); return xs.length ? (100 * xs.filter((x) => dom(x[ci.hoto_day]) >= 22).length) / xs.length : null; };
  const lateNow = (rs) => {  // only once day 22 has passed, else every month reads 0%
    if (dom(ctx.cur[1]) < 22 && ctx.live) return null;
    const xs = rs.filter((x) => inR(x[ci.hoto_day], ctx.cur)); return xs.length ? (100 * xs.filter((x) => dom(x[ci.hoto_day]) >= 22).length) / xs.length : null; };
  const skRows = clusters.map((name) => { const rs = rows.filter((x) => cl(x) === name); return { name, cells: skewCells(rs), n: rs.filter((x) => inR(x[ci.hoto_day], [skFrom, skTo])).length, late: lateShare(rs), lateNow: lateNow(rs) }; }).filter((r) => r.n >= 30);
  const skTot = { footer: true, name: "All clusters", cells: skewCells(rows), n: rows.filter((x) => inR(x[ci.hoto_day], [skFrom, skTo])).length, late: lateShare(rows), lateNow: lateNow(rows) };
  const skCell = (i) => (v, r) => { const c = r.cells[i]; if (!c.n || c.n < 10) return el("span", { class: "count", text: "·" });
    return el("span", { class: `pill ${convTone(c.p)}`, "data-tip": `${r.name} · HOTO on ${SKEW[i][2].replace("Days ", "days ")}: ${c.hit} of ${c.n} installed in the same month\nClick for the ${c.n - c.hit} that weren't`, role: r.footer ? null : "button",
      onclick: r.footer ? null : (e) => { e.stopPropagation(); openHotos(`${r.name} · HOTO ${SKEW[i][2]} · not installed in the same month`, c.miss); } }, pctTxt(c.p)); };
  skRows.forEach((r) => SKEW.forEach((_, i) => { r[`s${i}`] = r.cells[i].p; })); SKEW.forEach((_, i) => { skTot[`s${i}`] = skTot.cells[i].p; });
  main.append(block(3, "When in the month HOTOs land", `HOTOs of ${monthLabel(skewMonths[0])} – ${monthLabel(skewMonths[2])} · share installed in the same month, by HOTO day · a HOTO after the 27th almost never makes M0 · clusters with 30+ HOTOs`,
    box(dataTable([{ key: "name", label: "Cluster" }, { key: "n", label: "HOTOs", num: true, fmt: fmtInt },
      ...SKEW.map(([, , lbl], i) => ({ key: `s${i}`, label: lbl, num: true, fmt: skCell(i) })),
      { key: "late", label: "HOTOs after the 22nd", num: true, tip: "Share of the cluster's HOTOs that land on day 22 or later (same 3 months)", fmt: (v) => pctTxt(v) },
      { key: "lateNow", label: `…this month`, num: true, tip: `Same share for ${ctx.curText} so far (shown once day 22 has passed)`, fmt: (v) => pctTxt(v) }], skRows, { sortKey: "late", sortDir: -1, maxHeight: 520, footer: skTot }))));

  // ---------------- 4 · cluster x lane TAT with the network's best (HOTOs of the last 6 full months, installed)
  const lanes = (data.meta.lanes || []).slice();
  const from6 = ctx.cols.at(0).range[0], to6 = ctx.cols.at(-1).range[1];
  const tatOf = (x) => { const h = x[ci.hoto_day], i = instDay(x); return h != null && h >= from6 && h <= to6 && i != null && i >= h ? i - h : null; };
  const laneOf = (x) => label(f, "lane", x[ci.lane]);
  const dist = (xs) => { const t = xs.map(tatOf).filter((v) => v != null); return t.length ? { n: t.length, p10: percentile(t, 0.1), p50: percentile(t, 0.5), p90: percentile(t, 0.9) } : { n: 0 }; };
  const best = {};  // network best per lane = the cluster with the lowest P50 among cells with 40+ installs (all clusters, no filters)
  const allFacts = f.facts, allCl = (x) => label(f, "cluster", x[ci.cluster]);
  for (const ln of lanes) {
    const by = new Map(); for (const x of allFacts) { if (laneOf(x) !== ln) continue; const t = tatOf(x); if (t == null) continue; const k = allCl(x); if (!by.has(k)) by.set(k, []); by.get(k).push(t); }
    let b = null; for (const [k, t] of by) { if (t.length < MIN_LANE_N || SKIP.has(k)) continue; const p = percentile(t, 0.5); if (!b || p < b.p50) b = { name: k, p50: p, n: t.length }; }
    best[ln] = b;
  }
  const lRows = clusters.map((name) => { const rs = rows.filter((x) => cl(x) === name), r = { name, n: 0 }; for (const ln of lanes) { const d = dist(rs.filter((x) => laneOf(x) === ln)); r[ln] = d; r.n += d.n; } return r; }).filter((r) => r.n >= MIN_LANE_N);
  const lCell = (ln) => (d, r) => {
    if (!d || d.n < MIN_LANE_N) return el("span", { class: "count", text: d && d.n ? `n ${d.n}` : "·" });
    const b = best[ln], gap = b ? d.p50 - b.p50 : null, t = gap == null ? "flat" : gap <= 3 ? "good" : gap <= 10 ? "warn" : "bad";
    return el("span", { class: "split-cell", "data-tip": `${r.name} · ${ln}: P10 ${Math.round(d.p10)} · P50 ${Math.round(d.p50)} · P90 ${Math.round(d.p90)} days (${d.n} installs)${b ? `\nNetwork best: ${b.name} ${Math.round(b.p50)} days` : ""}` }, [
      `${Math.round(d.p50)} d`, gap != null ? el("small", { class: `t-${t}`, text: gap <= 0.5 ? "best" : `+${Math.round(gap)}` }) : null]);
  };
  const bestRow = { footer: true, name: "Network best (P50)" }; for (const ln of lanes) bestRow[ln] = best[ln];
  const bestCell = (ln) => (d, r) => (r.footer ? (best[ln] ? el("span", { class: "split-cell" }, [`${Math.round(best[ln].p50)} d`, el("small", { text: best[ln].name })]) : "–") : lCell(ln)(d, r));
  main.append(block(4, "HOTO → install by cluster and lane, against the best", `HOTOs of ${monthLabel(monthKey(from6))} – ${monthLabel(monthKey(to6))} that are installed · P50 days, small = days slower than the network's best cluster for that lane (green within 3, amber within 10) · cells with ${MIN_LANE_N}+ installs · hover for P10 / P90`,
    box(dataTable([{ key: "name", label: "Cluster" }, { key: "n", label: "Installs", num: true, fmt: fmtInt }, ...lanes.map((ln) => ({ key: ln, label: ln, num: true, fmt: bestCell(ln) }))],
      lRows, { sortKey: "n", sortDir: -1, maxHeight: 560, footer: bestRow }))));

  // ---------------- 5 · cluster x stage (Pre-RTI / RTI / Post-RTI, or OMS status)
  const holdOn = !!state.stageHold, view = state.p1StageView === "oms" ? "oms" : "ours";
  const pendSm = M.p1Pending(data, { ...state, hideCancelled: false }).filter((x) => { const s = label(f, "state", x[pci.state]); return s === "active" || (holdOn && s === "on-hold"); });
  const yard = M.stageP90s(data, ctx);
  const stageOf = (x) => label(f, "next_stage", x[pci.next_stage]);
  const late = push.isStuck;  // same rule as the Stuck counts
  const omsOf = (x) => { const v = label(f, "status", x[pci.status]); return v && v !== "—" ? v : "No status"; };
  main.append(block(5, "Where HOTOs wait: cluster × stage", `${fmtInt(pendSm.length)} handed over, not installed (${holdOn ? "active + on-hold" : "active"}) · live · late = past the stage's limit (${R})`,
    el("div", { class: "card-actions", style: { marginBottom: "10px", justifyContent: "flex-start", gap: "10px" } }, [
      segmented([["ours", "Our stages"], ["oms", "OMS status"]], view, (v) => setState({ p1StageView: v }), "Stage view"),
      segmented([["active", "Active"], ["hold", "Active + on-hold"]], holdOn ? "hold" : "active", (v) => setState({ stageHold: v === "hold" }), "Projects")]),
    box(stageMatrix({ items: pendSm, groupOf: (x) => label(f, "cluster", x[pci.cluster]), late, onCell: (xs, title) => openPend(title, xs), lateWord: `past ${R}`,
      stageOf: view === "oms" ? omsOf : stageOf, order: view === "oms" ? OMS_ORDER : stages.map((s) => s.name),
      colGroups: view === "oms" ? null : RTI_GROUPS, colLabel: (s) => s.replace(" (P1 collected / RFD)", "") }))));

  // ---------------- 6 · not-installed list
  const pipe = M.p1Pending(data, state);
  main.append(block(6, "Not installed: project list", `${fmtInt(pipe.length)} projects · live · oldest HOTO first${state.hideCancelled ? " · active only" : " · active, on-hold and seeking cancellation"}`,
    box(projectList(lateCols, [...pipe].sort((a, b) => b[pci.days_since_hoto] - a[pci.days_since_hoto]).map(lateRow), { searchKeys: pendList.cols.filter((x) => !x.num).map((x) => x.key), sortKey: "days", sortDir: -1, filename: "hoto_to_install_pipeline.csv" }))));

  // ---------------- 7 · month on month
  const convM = (k) => (rs, r) => conv(rs, r, k).pct, convB = (k) => (rs, r) => conv(rs, r, k).base, h2i = (q) => (rs, r) => M.hotoToInstall(data, rs, r)[q];
  const metrics = [
    { id: "hotos", label: "HOTOs", src: "f", kind: "count", good: "up", value: (rs, r) => rs.filter((x) => inR(x[ci.hoto_day], r)).length, pick: (rs, r) => rs.filter((x) => inR(x[ci.hoto_day], r)) },
    { id: "m0", label: "M0 conversion", src: "f", kind: "pct", good: "up", minBase: 30, value: convM(0), base: convB(0) },
    { id: "m1", label: "M1 conversion", src: "f", kind: "pct", good: "up", minBase: 30, value: convM(1), base: convB(1) },
    { id: "m2", label: "M2 conversion", src: "f", kind: "pct", good: "up", minBase: 30, value: convM(2), base: convB(2) },
    { id: "h2i", label: "HOTO → install P50", src: "i", kind: "days", good: "down", value: h2i("p50"), base: (rs, r) => M.hotoToInstall(data, rs, r).count },
    { id: "h2i75", label: "HOTO → install P75", src: "i", kind: "days", good: "down", value: h2i("p75"), base: (rs, r) => M.hotoToInstall(data, rs, r).count },
    { id: "h2i90", label: "HOTO → install P90", src: "i", kind: "days", good: "down", value: h2i("p90"), base: (rs, r) => M.hotoToInstall(data, rs, r).count },
  ];
  main.append(block(7, "Month on month", "Month to date and full months · M0 / M1 / M2 = share of each HOTO month installed in the same, next and following month",
    momTables(metrics, ctx, { f: { file: f, ci, rows, list: hotoList }, i: { file: p2, ci: p2.ci, rows: p2r, list: p2FactList(p2) } })));
}
