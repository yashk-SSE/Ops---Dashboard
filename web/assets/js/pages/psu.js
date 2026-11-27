// PSU cases V1 (D-122): "Where are PSU loans waiting: before RFD (it holds up installation) and before the 70% / 30% disbursals?"
// Population: projects in the PSU payment lane (D-38). Milestones = OMS tasks, as everywhere else on the dashboard: RFD = PSUN004 (D-61),
// 70% = PSUN005, 30% = PSUN007 (old codes PSU006 / PSU008 counted too). Steps = first entry into each PSU stage of the EMI application
// (EMI log, from Dec 2025; same day as PSUN004 for 95% of projects). Time in step k = entry into step k + 1 - entry into step k.
//  1. Cluster table (All / BAU / Expansion): PSU HOTOs, RFD vs LMTD, HOTO -> RFD P50 / P90, waiting for RFD (live), late, 70% / 30% received,
//     waiting for the 30%.
//  2. Trend: RFD, 70% or 30% (bars) vs PSU HOTOs (dashed), month / week / day.
//  3. Where they wait: cluster x PSU step (before RFD / after RFD), late = longer in the step than its limit (India).
//  4. Step by step: milestones (OMS) and the time in each step (EMI log), P50 / P75 / P90, with the waiting projects.
//  5. Month on month.  6. Waiting list.
import { el, dataTable, segmented, projectList } from "../ui.js";
import { label, matcher, monthBounds, monthLabel, fmtDay } from "../data.js";
import { fmtInt, tatSummary } from "../stats.js";
import * as M from "../metrics.js";
import { momTables, block, tierTable, openList, stageMatrix, daySpanOf, daySpanSwitch, chartClusters } from "../layout.js";
import { comboChart } from "../charts.js";
import { psuList } from "../lists.js";

const SKIP = new Set(["", "—", "Not mapped"]);
const box = (kids) => el("div", { class: "card" }, kids);
const pctTxt = (p) => (p == null ? "–" : `${Math.round(p)}%`);
const dTxt = (v) => (v == null ? "–" : `${Math.round(v)} d`);
const tone = (p) => (p == null ? "flat" : p > 25 ? "bad" : p > 10 ? "warn" : "good");
const MIN_N = 10;
const BEFORE = ["No loan application", "Portal application", "Document verification", "Lender selection", "Jan Samarth application", "Runner assignment",
  "Bank visit", "Bank inspection", "Final customer visit (RFD)"];
const AFTER = ["1st disbursal", "Disbursal verification", "Installation (1st disbursal received)", "Installation documents", "2nd disbursal"];
const AFTER_70 = ["Installation (1st disbursal received)", "Installation documents", "2nd disbursal"];

export function render(main, { data, state, setState, ctx }) {
  const f = data.psu;
  if (!f) { main.append(el("div", { class: "card count", text: "PSU data is not published yet. It appears after the next refresh." })); return; }
  const c = f.ci, asOf = data.meta.as_of_day, last = ctx.last, inR = M.inRange, R = M.stuckShort(ctx);
  const filtered = f.facts.filter(matcher(f, state.filters, c));
  const rows = filtered.filter((x) => !state.hideCancelled || x[c.later_cancelled] === 0);
  const cl = (x) => label(f, "cluster", x[c.cluster]), step = (x) => label(f, "step", x[c.step]), st = (x) => label(f, "state", x[c.state]);
  const portalFrom = monthBounds((f.portal_from || "2026-06-01").slice(0, 7))[0];
  const portalOk = (r) => r && r[1] >= portalFrom;
  const E = f.steps.map((_, i) => c[`e${i}`]);

  // ---------------- definitions
  const hotos = (rs, r) => rs.filter((x) => inR(x[c.hoto_day], r));
  const done = (col) => (rs, r) => rs.filter((x) => inR(x[c[col]], r));
  const rfds = done("rfd_day"), d70s = done("d70_day"), d30s = done("d30_day");
  const tatOf = (a, b) => (rs, r) => rs.filter((x) => inR(x[c[b]], r) && x[c[a]] != null && x[c[b]] >= x[c[a]]).map((x) => x[c[b]] - x[c[a]]);
  const h2r = tatOf("hoto_day", "rfd_day"), r2s = tatOf("rfd_day", "d70_day"), i2t = tatOf("installed_day", "d30_day"), h2t = tatOf("hoto_day", "d30_day");
  const inStep = (k) => (rs, r) => rs.filter((x) => inR(x[E[k + 1]], r) && x[E[k]] != null && x[E[k + 1]] >= x[E[k]]).map((x) => x[E[k + 1]] - x[E[k]]);
  // India yardsticks over the last 6 full months, whatever the filters (D-107 / D-111)
  const win = [ctx.cols.at(0).range[0], ctx.cols.at(-1).range[1]];
  const rfdLimit = M.stuckLimit(h2r(f.facts, win), ctx);
  const stepLimit = f.steps.map((_, k) => (k < f.steps.length - 1 ? M.stuckLimit(inStep(k)(f.facts, win), ctx) : null));
  const holdOn = !!state.stageHold;
  const okState = (s) => s === "active" || (holdOn && s === "on-hold");
  const since = (x) => asOf - x[c.hoto_day], inStepDays = (x) => (x[c.step_day] == null ? null : asOf - x[c.step_day]);
  // waiting (live): for RFD = handed over, no RFD, not installed, no 70%; for the 70% = RFD done, no 70%;
  // for the 30% = installed, 70% received, no 30% (completed projects count: the money is still due). Projects with no EMI-portal
  // application (70% received before Jun 2026, before task PSUN007 existed) are kept apart: their 30% may have been paid unrecorded.
  const portal = (x) => label(f, "lender", x[c.lender]) !== "No loan application";
  const wRFD = filtered.filter((x) => okState(st(x)) && x[c.hoto_day] != null && x[c.rfd_day] == null && x[c.installed_day] == null && x[c.d70_day] == null);
  const w70 = filtered.filter((x) => okState(st(x)) && x[c.rfd_day] != null && x[c.d70_day] == null);
  const w30all = filtered.filter((x) => (okState(st(x)) || st(x) === "completed") && x[c.installed_day] != null && x[c.d70_day] != null && x[c.d30_day] == null);
  const w30 = w30all.filter(portal), w30old = w30all.filter((x) => !portal(x));
  const waitingAll = [...new Set([...wRFD, ...w70, ...w30])];
  const isPre = new Set(wRFD), is70 = new Set(w70);
  // what the project waits for: its EMI stage when that fits the milestones reached, else the next milestone (the stage lags)
  const waitStep = (x) => {
    const s = step(x);
    if (isPre.has(x)) return BEFORE.includes(s) ? s : "Other";
    if (is70.has(x)) return s === "1st disbursal" || s === "Disbursal verification" ? s : "1st disbursal";
    return AFTER_70.includes(s) || s === "Disbursal verification" ? s : "Other";
  };
  const late = (x) => {
    const s = waitStep(x), k = f.steps.indexOf(s), d = inStepDays(x);
    if (s === step(x) && k >= 0 && stepLimit[k] != null && d != null) return d > stepLimit[k];
    return isPre.has(x) && rfdLimit != null && since(x) > rfdLimit;
  };
  const limitTxt = (x) => { const s = waitStep(x), k = f.steps.indexOf(s);
    return s === step(x) && k >= 0 && stepLimit[k] != null ? Math.round(stepLimit[k]) : isPre.has(x) && rfdLimit != null ? Math.round(rfdLimit) : null; };

  const list = psuList(f, asOf);
  const lateCols = [...list.cols, { key: "limit", label: `Limit (${R})`, num: true, tip: "Days allowed in this step (India, last 6 months); before RFD with no step, days since HOTO vs HOTO → RFD" }, { key: "late", label: "Late" }];
  const lateRow = (x) => ({ ...list.row(x), step: waitStep(x), limit: limitTxt(x), late: late(x) ? "Late" : "" });
  const openRows = (title, xs) => openList({ title, sub: `${fmtInt(xs.length)} projects`, cols: lateCols, rows: [...xs].sort((a, b) => since(b) - since(a)).map(lateRow), filename: `${title.replace(/\W+/g, "_").toLowerCase()}.csv` });
  const btn = (xs, title) => (xs.length ? el("button", { type: "button", class: "link-btn", text: fmtInt(xs.length), onclick: (e) => { e.stopPropagation(); openRows(title, xs); } }) : el("span", { class: "count", text: "0" }));

  // ---------------- 1 · cluster table
  const clusters = [...new Set(rows.map(cl).concat(waitingAll.map(cl)))].filter((k) => !SKIP.has(k));
  const cRow = (name) => {
    const rs = rows.filter((x) => cl(x) === name), w = wRFD.filter((x) => cl(x) === name), lt = w.filter(late), t = tatSummary(h2r(rs, ctx.cur));
    const r = rfds(rs, ctx.cur), a = d70s(rs, ctx.cur), b = d30s(rs, ctx.cur), w3 = w30.filter((x) => cl(x) === name);
    return { name, h: hotos(rs, ctx.cur), nH: hotos(rs, ctx.cur).length, r, nR: r.length, lm: rfds(rs, ctx.prevSame).length, p50: t.p50, p90: t.p90,
      w, nW: w.length, lt, nL: lt.length, a, n70: a.length, b, n30: b.length, w3, nW3: w3.length };
  };
  const cRows = clusters.map(cRow).filter((r) => r.nH || r.nR || r.nW || r.nW3);
  const cols = [
    { key: "name", label: "Cluster" },
    { key: "nH", label: "PSU HOTOs MTD", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.h, `${r.name} · PSU HOTOs ${ctx.curText}`)) },
    { key: "nR", label: "RFD MTD", num: true, tip: "OMS task PSUN004: final customer visit for loan sanction (RFD)", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.r, `${r.name} · RFD ${ctx.curText}`)) },
    { key: "dl", label: "vs LMTD", num: true, fmt: (v, r) => { const d = M.delta(r.nR, r.lm, "count", "up"); return d ? el("span", { class: `delta ${d.tone}`, "data-tip": `LMTD ${fmtInt(r.lm)}`, text: `${d.arrow} ${d.text}` }) : "–"; } },
    { key: "p50", label: "HOTO → RFD P50", num: true, tip: "Projects reaching RFD this month: days from HOTO", fmt: dTxt },
    { key: "p90", label: "P90", num: true, fmt: dTxt },
    { key: "nW", label: "Waiting for RFD", num: true, tip: "Active, handed over, no RFD, not installed (live)", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.w, `${r.name} · waiting for RFD`)) },
    { key: "nL", label: "Late", num: true, tip: `Longer in their PSU step than its limit (${R}, India, last 6 months)`, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.lt, `${r.name} · waiting for RFD, late`)) },
    { key: "pL", label: "Share late", num: true, fmt: (v, r) => { const p = r.nW ? (100 * r.nL) / r.nW : null; return p == null ? "–" : el("span", { class: `pill ${tone(p)}`, text: pctTxt(p) }); } },
    { key: "n70", label: "70% received MTD", num: true, tip: "OMS task PSUN005: first disbursal (70%)", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.a, `${r.name} · 70% received ${ctx.curText}`)) },
    { key: "n30", label: "30% received MTD", num: true, tip: "OMS task PSUN007: second disbursal (30%)", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.b, `${r.name} · 30% received ${ctx.curText}`)) },
    { key: "nW3", label: "Waiting for the 30%", num: true, tip: "Installed, 70% received, 30% not yet (live; completed projects included; EMI-portal projects only)", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.w3, `${r.name} · waiting for the 30%`)) },
  ];
  const totalOf = (rs, name) => {
    const names = new Set(rs.map((r) => r.name)), sub = rows.filter((x) => names.has(cl(x))), s = (k) => rs.reduce((a, r) => a + (r[k] || 0), 0), t = tatSummary(h2r(sub, ctx.cur));
    return { footer: true, name, nH: s("nH"), nR: s("nR"), lm: s("lm"), p50: t.p50, p90: t.p90, nW: s("nW"), nL: s("nL"), n70: s("n70"), n30: s("n30"), nW3: s("nW3") };
  };
  const sumParts = (t) => [el("span", {}, ["RFD ", el("b", { text: fmtInt(t.nR) })]), el("span", {}, ["Waiting ", el("b", { text: fmtInt(t.nW) })]),
    el("span", { class: `pill ${tone(t.nW ? (100 * t.nL) / t.nW : null)}`, text: `${pctTxt(t.nW ? (100 * t.nL) / t.nW : null)} late` })];
  const allT = totalOf(cRows, "All clusters");
  main.append(block(1, "PSU cases by cluster", `${ctx.curText} · ${ctx.curRange} · RFD / 70% / 30% = OMS tasks PSUN004 / PSUN005 / PSUN007 · waiting live · click a count for its projects`,
    el("div", { class: "count", style: { margin: "0 0 8px" }, text: `All clusters: ${fmtInt(allT.nH)} PSU HOTOs · ${fmtInt(allT.nR)} reached RFD (P50 ${dTxt(allT.p50)}, P90 ${dTxt(allT.p90)} from HOTO) · ${fmtInt(allT.nW)} waiting for RFD, ${fmtInt(allT.nL)} late · ${fmtInt(w70.length)} waiting for the 70% · ${fmtInt(allT.nW3)} installed and waiting for the 30% (plus ${fmtInt(w30old.length)} older ones with no EMI-portal record, 70% received before Jun 2026: check with the EMI team)` }),
    tierTable({ rows: cRows, cols, totalOf, sumParts, tier: state.tier, onTier: (v) => setState({ tier: v }), sortKey: "nW", sortDir: -1 })));

  // ---------------- 2 · trend
  // D-125: the graph's own cluster picker (this graph only, inside the top-bar filters)
  const cp = chartClusters(state, setState, "psu", rows.map(cl));
  const gRows = rows.filter((x) => cp.keep(cl(x)));
  const grain = ["mom", "wow", "dod"].includes(state.psuGrain) ? state.psuGrain : "mom";
  const series = ["rfd", "d70", "d30"].includes(state.psuSeries) ? state.psuSeries : "rfd";
  const sName = { rfd: "RFD", d70: "70% received", d30: "30% received" }[series];
  const byDay = (field) => { const mp = new Map(); for (const x of gRows) { const d = x[c[field]]; if (d != null) mp.set(d, (mp.get(d) || 0) + 1); } return mp; };
  const sDay = byDay(series === "rfd" ? "rfd_day" : series === "d70" ? "d70_day" : "d30_day"), hDay = byDay("hoto_day");
  const labels = [], ss = [], hs = [];
  const add = (lbl, a, b) => { let s1 = 0, h1 = 0; for (let d = a; d <= b; d++) { s1 += sDay.get(d) || 0; h1 += hDay.get(d) || 0; } labels.push(lbl); ss.push(s1); hs.push(h1); };
  if (grain === "dod") for (let d = last - (daySpanOf(state) - 1); d <= last; d++) add(fmtDay(d).slice(0, 6), d, d);
  else if (grain === "wow") for (let w = 11; w >= 0; w--) { const b = last - 7 * w, a = b - 6; add(`${fmtDay(a).slice(0, 6)}–${fmtDay(b).slice(0, 6)}`, a, b); }
  else for (const k of M.trendMonths(data.meta)) { const [a, b] = monthBounds(k); if (a > last) continue; add(monthLabel(k) + (b > last ? " (MTD)" : ""), a, Math.min(b, last)); }
  main.append(block(2, "RFD and disbursals vs handed over", `Bars = ${sName}, dashed line = PSU HOTOs${cp.note}`,
    box([el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start", gap: "10px" } }, [
      segmented([["rfd", "RFD"], ["d70", "70% received"], ["d30", "30% received"]], series, (v) => setState({ psuSeries: v }), "Milestone"),
      segmented([["mom", "Month on month"], ["wow", "Week on week"], ["dod", "Day on day"]], grain, (v) => setState({ psuGrain: v }), "Grain"), grain === "dod" ? daySpanSwitch(state, setState) : null, cp.node]),
      comboChart(labels, { label: sName, data: ss, color: "--series-1" }, { label: "PSU HOTOs", data: hs, color: "--series-2" }, { yFormat: (v) => fmtInt(v), height: 290 })])));

  // ---------------- 3 · where they wait: cluster x PSU step
  main.append(block(3, "Where PSU cases wait", `${fmtInt(waitingAll.length)} waiting (${holdOn ? "active + on-hold" : "active"}; the 30% also counts completed projects; EMI-portal projects) · live · step = the EMI application's current PSU stage (the next milestone when the stage lags) · late = longer in the step than its limit (${R}, India, last 6 months)`,
    el("div", { class: "card-actions", style: { marginBottom: "10px", justifyContent: "flex-start" } }, [
      segmented([["active", "Active"], ["hold", "Active + on-hold"]], holdOn ? "hold" : "active", (v) => setState({ stageHold: v === "hold" }), "Projects")]),
    box(stageMatrix({ items: waitingAll, groupOf: cl, stageOf: waitStep, order: [...BEFORE, ...AFTER], late, onCell: (xs, title) => openRows(title, xs), lateWord: `past ${R}`,
      colGroups: [{ name: "Before RFD", stages: BEFORE }, { name: "After RFD", stages: AFTER }] }))));

  // ---------------- 4 · step by step
  const tRow = (name, vals, extra = {}) => { const t = tatSummary(vals); return { name, n: vals.length, p50: vals.length >= MIN_N ? t.p50 : null, p75: vals.length >= MIN_N ? t.p75 : null, p90: vals.length >= MIN_N ? t.p90 : null, ...extra }; };
  const msRows = [
    tRow("HOTO → RFD (PSUN004)", h2r(rows, ctx.cur), { limit: rfdLimit, w: wRFD, nW: wRFD.length }),
    tRow("RFD → 70% received (PSUN005)", r2s(rows, ctx.cur), { w: w70, nW: w70.length }),
    tRow("Installed → 30% received (PSUN007)", i2t(rows, ctx.cur), { w: w30, nW: w30.length }),
    tRow("HOTO → 30% received", h2t(rows, ctx.cur), {}),
  ];
  const stepRows = f.steps.slice(0, -1).map((name, k) => { const w = waitingAll.filter((x) => waitStep(x) === name);
    return tRow(name, inStep(k)(rows, ctx.cur), { limit: stepLimit[k], w, nW: w.length, nL: w.filter(late).length }); });
  const tCols = (first) => [{ key: "name", label: first }, { key: "n", label: "Finished this month", num: true, fmt: fmtInt },
    { key: "p50", label: "P50", num: true, fmt: dTxt }, { key: "p75", label: "P75", num: true, fmt: dTxt }, { key: "p90", label: "P90", num: true, fmt: dTxt },
    { key: "limit", label: `Limit (${R}, India)`, num: true, fmt: dTxt },
    { key: "nW", label: "Waiting now", num: true, fmt: (v, r) => (r.w ? btn(r.w, `Waiting · ${r.name}`) : "–") }];
  main.append(block(4, "Step by step", `${ctx.curText} · days, steps finished this month (blank under ${MIN_N} projects) · milestones from OMS tasks, steps from the EMI log (PSU stages, most PSU handovers from Jun 2026) · a step's time = until the next stage starts`,
    box([el("div", { class: "card-sub", style: { marginBottom: "6px" }, text: "Milestones" }), dataTable(tCols("Milestone"), msRows, { maxHeight: 260 })]),
    box([el("div", { class: "card-sub", style: { marginBottom: "6px" }, text: "Time in each PSU step" }),
      dataTable([...tCols("Step (what the project waits for)"), { key: "nL", label: `Past ${R}`, num: true, fmt: fmtInt }], stepRows, { maxHeight: 520 })])));

  // ---------------- 5 · month on month (above the list, as asked)
  const p1f = data.p1, p1c = p1f.ci, p1rows = M.p1Rows(data, state);
  const psuOf = (x) => label(p1f, "payment_lane", x[p1c.payment_lane]) === "PSU";
  const pOk = (v) => (rs3, r) => (portalOk(r) ? v(rs3, r) : null);
  const stepMetric = (k, id) => ({ id, label: `${f.steps[k]}: time in step P50`, src: "s", kind: "days", good: "down", hint: "EMI log, from Jun 2026", value: pOk((rs3, r) => tatSummary(inStep(k)(rs3, r)).p50), base: (rs3, r) => inStep(k)(rs3, r).length });
  const metrics = [
    { id: "hotos", label: "PSU HOTOs", src: "s", kind: "count", good: "up", value: (rs3, r) => hotos(rs3, r).length, pick: hotos },
    { id: "share", label: "PSU share of all HOTOs", src: "p", kind: "pct", good: "up", hint: "PSU lane ÷ all HOTOs (HOTO → Installation data)",
      value: (rs3, r) => { const h = rs3.filter((x) => inR(x[p1c.hoto_day], r)); return h.length ? (100 * h.filter(psuOf).length) / h.length : null; }, base: (rs3, r) => rs3.filter((x) => inR(x[p1c.hoto_day], r)).length },
    { id: "rfd", label: "RFD (PSUN004)", src: "s", kind: "count", good: "up", value: (rs3, r) => rfds(rs3, r).length, pick: rfds },
    { id: "h2r50", label: "HOTO → RFD P50", src: "s", kind: "days", good: "down", value: (rs3, r) => tatSummary(h2r(rs3, r)).p50, base: (rs3, r) => h2r(rs3, r).length },
    { id: "h2r75", label: "HOTO → RFD P75", src: "s", kind: "days", good: "down", value: (rs3, r) => tatSummary(h2r(rs3, r)).p75, base: (rs3, r) => h2r(rs3, r).length },
    { id: "h2r90", label: "HOTO → RFD P90", src: "s", kind: "days", good: "down", value: (rs3, r) => tatSummary(h2r(rs3, r)).p90, base: (rs3, r) => h2r(rs3, r).length },
    { id: "d70", label: "70% received (PSUN005)", src: "s", kind: "count", good: "up", value: (rs3, r) => d70s(rs3, r).length, pick: d70s },
    { id: "r2s", label: "RFD → 70% received P50", src: "s", kind: "days", good: "down", value: (rs3, r) => tatSummary(r2s(rs3, r)).p50, base: (rs3, r) => r2s(rs3, r).length },
    { id: "d30", label: "30% received (PSUN007)", src: "s", kind: "count", good: "up", value: (rs3, r) => d30s(rs3, r).length, pick: d30s },
    { id: "i2t", label: "Installed → 30% received P50", src: "s", kind: "days", good: "down", value: (rs3, r) => tatSummary(i2t(rs3, r)).p50, base: (rs3, r) => i2t(rs3, r).length },
    stepMetric(2, "js"), stepMetric(4, "visit"), stepMetric(5, "insp"), stepMetric(6, "final"),
  ];
  main.append(block(5, "Month on month", "Month to date and full months · HOTOs by HOTO date, milestones and TATs by the date the step finished · PSU steps from Jun 2026",
    momTables(metrics, ctx, { s: { file: f, ci: c, rows, list }, p: { file: p1f, ci: { ...p1c, lane: undefined }, rows: p1rows } }, { state, setState })));  // the share row stays all lanes: no lane switch on it

  // ---------------- 6 · waiting list
  const which = ["rfd", "d70", "d30", "old"].includes(state.psuList) ? state.psuList : "rfd";
  const listRows = which === "rfd" ? wRFD : which === "d70" ? w70 : which === "d30" ? w30 : w30old;
  main.append(block(6, "Waiting: project list", `${fmtInt(listRows.length)} projects · live · longest since HOTO first`,
    el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["rfd", `For RFD (${fmtInt(wRFD.length)})`], ["d70", `For the 70% (${fmtInt(w70.length)})`], ["d30", `For the 30% (${fmtInt(w30.length)})`], ["old", `30%, no portal record (${fmtInt(w30old.length)})`]], which, (v) => setState({ psuList: v }), "List")]),
    box(projectList(lateCols, [...listRows].sort((a, b) => since(b) - since(a)).map(lateRow), { searchKeys: lateCols.filter((x) => !x.num && !x.fmt).map((x) => x.key), sortKey: "days", sortDir: -1, filename: `psu_waiting_${which}.csv` }))));
}
