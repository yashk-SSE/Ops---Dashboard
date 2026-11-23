// Installations vs plan V3 (D-111): "Are we installing to plan, and what should each cluster push?"
//  1. Cluster table vs the install plan (Base / Aggressive switch in the top bar), folded by the plan's own groups
//     (Mature OA / OA since Sep / OA from Oct) plus "Not in the plan" (actuals only). M0 / M1 / M2+ done vs plan MTD,
//     ready to install and stuck; a cluster's name opens its push panel.
//  2. Trend: installs vs plan by day / week / month, or this month cumulative.
//  3. Split: installs by HOTO age (M0 / M1 / M2+) or by lane.
//  4. Project list (installs in the period).  5. Month on month.
import { el, dataTable, segmented, projectList } from "../ui.js";
import { label, fmtDay, monthKey, monthBounds, monthLabel, monthsBetween, activeFilterDims } from "../data.js";
import { fmtInt } from "../stats.js";
import * as M from "../metrics.js";
import { momTables, block, tierTable, openList, daySpanOf, daySpanSwitch } from "../layout.js";
import { lineChart, comboChart } from "../charts.js";
import { p2FactList } from "../lists.js";
import { pushModel, openClusterPanel, countBtn } from "../push.js";

const PLAN_FILTERS = new Set(["region", "cluster"]);
const SKIP = new Set(["", "—", "Not mapped"]);
const tone = (p) => (p == null ? "flat" : p >= 90 ? "good" : p >= 75 ? "warn" : "bad");
const pctTxt = (p) => (p == null ? "–" : `${Math.round(p)}%`);
const box = (kids) => el("div", { class: "card" }, kids);

// HOTO age of an install, in months: 0 = HOTO in the install's month, 1 = the month before, 2 = two or more before
function hotoAge(instDay, hotoDay) {
  if (instDay == null || hotoDay == null) return null;
  const a = monthKey(instDay).split("-").map(Number), b = monthKey(hotoDay).split("-").map(Number);
  const diff = (a[0] * 12 + a[1]) - (b[0] * 12 + b[1]);
  return diff <= 0 ? 0 : diff === 1 ? 1 : 2;
}

export function render(main, { data, state, setState, ctx }) {
  const f = data.p2, c = f.ci;
  const rows = M.p2Rows(data, state);
  const inR = M.inRange, last = ctx.last;
  const cl = (x) => label(f, "cluster", x[c.cluster]);
  const list = p2FactList(f);
  const planWord = ctx.planMode === "aggr" ? "aggressive" : "base";
  const planMonth = (data.plan.months || {})[ctx.key];
  const otherFilters = activeFilterDims(state.filters).filter((k) => !PLAN_FILTERS.has(k));
  const usePlan = !!planMonth && !otherFilters.length;
  const installed = (rs, r) => rs.filter((x) => inR(x[c.installed_day], r));
  const byAge = (k) => (rs, r) => installed(rs, r).filter((x) => hotoAge(x[c.installed_day], x[c.hoto_day]) === k);
  const openRows = (title, xs) => openList({ title, sub: `${fmtInt(xs.length)} installs`, cols: list.cols, rows: xs.map(list.row), filename: `${title.replace(/\W+/g, "_").toLowerCase()}.csv` });
  const cntBtn = (xs, title) => (xs.length ? el("button", { type: "button", class: "link-btn", text: fmtInt(xs.length), onclick: (e) => { e.stopPropagation(); openRows(title, xs); } }) : el("span", { class: "count", text: "0" }));

  // ---------------- per-cluster rows (every cluster; plan figures where the cluster is in the plan)
  const dIdx = Math.max(0, Math.min(ctx.dayN, 31) - 1);
  const left = Math.max(1, ctx.days - ctx.dayN);
  const push = pushModel(data, state, ctx);
  const clusters = [...new Set([...rows.map(cl), ...push.clusters])].filter((k) => !SKIP.has(k));  // + clusters with only old pending projects
  const cRows = clusters.map((name) => {
    const rs = rows.filter((x) => cl(x) === name), pc = usePlan ? planMonth.clusters[name] : null;
    const cur = installed(rs, ctx.cur), lm = installed(rs, ctx.prevSame).length;
    const age = [0, 1, 2].map((k) => cur.filter((x) => hotoAge(x[c.installed_day], x[c.hoto_day]) === k));
    const r = { name, cur, mtd: cur.length, lm, age, yday: rs.filter((x) => x[c.installed_day] === last).length, rate: cur.length / Math.max(1, ctx.dayN),
      ready: push.ready(name).length, stuck: push.stuck(name).length, group: pc ? (pc.group || "Plan") : "Not in the plan" };
    if (pc) {
      r.plan = pc.base_total; r.exp = pc.base_cum ? pc.base_cum[dIdx] : (pc.base_total * ctx.dayN) / ctx.days;
      r.dayPlan = pc.base_cum ? pc.base_cum[dIdx] - (dIdx ? pc.base_cum[dIdx - 1] : 0) : pc.base_total / ctx.days;
      const frac = pc.base_total ? r.exp / pc.base_total : ctx.dayN / ctx.days, planAge = [pc.base_m0, pc.base_m1, pc.base_m2plus];
      r.ageExp = [pc.base_m0_cum, pc.base_m1_cum, pc.base_m2_cum].map((cum, k) => (cum ? cum[dIdx] : (planAge[k] || 0) * frac));
      r.ach = r.exp ? (100 * r.mtd) / r.exp : null; r.need = Math.max(0, (r.plan - r.mtd) / left); r.gap = r.mtd - r.exp;
    }
    return r;
  });
  const panelFor = (r) => openClusterPanel(r.name, push, data, { planRow: r.plan != null ? { mtd: r.mtd, exp: r.exp, plan: r.plan, need: r.need, rate: r.rate } : null,
    goToP1: () => { setState({ filters: { cluster: [r.name] } }); location.hash = "#/p1"; } });

  // ---------------- 1 · cluster table: one list with the plan group as a column, All / BAU / Expansion switch (D-116)
  const ageCell = (k) => (v, r) => {
    if (r.footer) return r.ageExp ? `${fmtInt(r[`a${k}`])} / ${fmtInt(Math.round(r.ageExp[k]))}` : fmtInt(r[`a${k}`]);
    const done = r.age[k].length, exp = r.ageExp ? r.ageExp[k] : null, p = exp ? (100 * done) / exp : null;
    return el("span", { class: "split-cell", "data-tip": exp != null ? `${r.name} · ${["M0", "M1", "M2+"][k]}: ${done} done · ${Math.round(exp)} expected by today on the plan's curve` : `${done} installs` }, [
      cntBtn(r.age[k], `${r.name} · ${["M0", "M1", "M2+"][k]} installs`), exp != null ? el("small", { class: `t-${tone(p)}`, text: `/ ${Math.round(exp)}` }) : null]);
  };
  const cols = [
    { key: "name", label: "Cluster", tip: "Click a cluster for what to push: ready to install, stuck, and where its pipeline waits",
      fmt: (n, r) => (r.footer ? n : el("button", { type: "button", class: "cl-btn", text: n, onclick: (e) => { e.stopPropagation(); panelFor(r); } })) },
    { key: "group", label: "Plan group", tip: "The install plan's cluster groups (Mature OA / OA since Sep / OA from Oct); clusters without a plan this month: Not in the plan" },
    { key: "plan", label: "Plan", num: true, tip: `The month's ${planWord} install plan`, fmt: (v) => (v == null ? "–" : fmtInt(v)) },
    { key: "exp", label: "Plan MTD", num: true, tip: `Where the ${planWord} plan's daily curve expects the cluster by the end of day ${ctx.dayN}`, fmt: (v) => (v == null ? "–" : fmtInt(Math.round(v))) },
    { key: "mtd", label: "Installs MTD", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : cntBtn(r.cur, `${r.name} · installs ${ctx.curText}`)) },
    { key: "ach", label: "Achieved MTD", num: true, tip: "Installs MTD ÷ plan MTD", fmt: (v) => (v == null ? "–" : el("span", { class: `pill ${tone(v)}`, text: pctTxt(v) })) },
    { key: "dl", label: "vs LMTD", num: true, tip: "Installs MTD vs the same days last month", fmt: (v, r) => { const d = M.delta(r.mtd, r.lm, "count", "up"); return d ? el("span", { class: `delta ${d.tone}`, "data-tip": `LMTD ${fmtInt(r.lm)}`, text: `${d.arrow} ${d.text}` }) : "–"; } },
    { key: "rate", label: "Run rate / day", num: true, fmt: (v) => v.toFixed(1) },
    { key: "need", label: "Required Run Rate", num: true, tip: "(Plan − installs MTD) ÷ days left in the month: installs needed per day to reach the plan", fmt: (v) => (v == null ? "–" : v.toFixed(1)) },
    { key: "a0", label: "M0", num: true, tip: "Installs of this month's HOTOs: done / expected by today on the plan's M0 curve", fmt: ageCell(0) },
    { key: "a1", label: "M1", num: true, tip: "Installs of last month's HOTOs: done / expected by today", fmt: ageCell(1) },
    { key: "a2", label: "M2+", num: true, tip: "Installs of older HOTOs: done / expected by today", fmt: ageCell(2) },
    { key: "ready", label: "Ready to install", num: true, tip: "Active, RTI done (design approved, sanction letter, payment ready), not installed: push these to installation now",
      fmt: (n, r) => (r.footer ? fmtInt(n) : countBtn(n, () => push.openRows(`${r.name} · ready to install`, push.ready(r.name)))) },
    { key: "stuck", label: "Stuck", num: true, tip: `Active, not installed, past its stage's limit in days from HOTO (stuck rule: ${M.stuckShort(ctx)})`,
      fmt: (n, r) => (r.footer ? fmtInt(n) : countBtn(n, () => push.openRows(`${r.name} · stuck`, push.stuck(r.name)))) },
    { key: "yday", label: "Yesterday", num: true, fmt: (v, r) => (r.dayPlan == null ? fmtInt(v) : el("span", { class: v < Math.floor(r.dayPlan) ? "t-bad" : "t-good", "data-tip": `${fmtInt(v)} installed on ${fmtDay(last)} vs ${r.dayPlan.toFixed(1)} planned`, text: `${v} / ${Math.round(r.dayPlan)}` })) },
  ];
  cRows.forEach((r) => { r.a0 = r.age[0].length; r.a1 = r.age[1].length; r.a2 = r.age[2].length; });
  const totalOf = (rs, name) => {
    const s = (k) => rs.reduce((a, r) => a + (r[k] || 0), 0), withPlan = rs.filter((r) => r.plan != null);
    const t = { footer: true, name, mtd: s("mtd"), lm: s("lm"), yday: s("yday"), ready: s("ready"), stuck: s("stuck"), a0: s("a0"), a1: s("a1"), a2: s("a2"), rate: s("mtd") / Math.max(1, ctx.dayN) };
    if (withPlan.length) {
      t.plan = withPlan.reduce((a, r) => a + r.plan, 0); t.exp = withPlan.reduce((a, r) => a + r.exp, 0); t.dayPlan = withPlan.reduce((a, r) => a + r.dayPlan, 0);
      const done = withPlan.reduce((a, r) => a + r.mtd, 0);
      t.ach = t.exp ? (100 * done) / t.exp : null; t.need = Math.max(0, (t.plan - done) / left);
      t.ageExp = [0, 1, 2].map((k) => withPlan.reduce((a, r) => a + r.ageExp[k], 0));
    }
    return t;
  };
  const sumParts = (t) => [el("span", {}, ["Installs ", el("b", { text: fmtInt(t.mtd) })]), t.exp != null ? el("span", {}, ["Plan MTD ", el("b", { text: fmtInt(Math.round(t.exp)) })]) : null,
    t.ach != null ? el("span", { class: `pill ${tone(t.ach)}`, text: `${pctTxt(t.ach)} achieved` }) : null,
    el("span", {}, ["Ready ", el("b", { text: fmtInt(t.ready) })]), el("span", {}, ["Stuck ", el("b", { text: fmtInt(t.stuck) })])];
  const planRowsAll = cRows.filter((r) => r.plan != null), allT = totalOf(cRows, "All clusters"), planT = totalOf(planRowsAll, "Plan clusters");
  const method = el("span", { class: "pill info", "data-tip": "How the plan is built (Nov26_Install_Plan_v3, Prasanna R): installs = M0 (HOTOs of the month × lane mix × lane M0 rate) + M1 (last month's HOTOs × lane M0+M1 rate − what they already installed) + M2+ (older pending pool × decay). Base rates are mostly the Aug–Oct average; aggressive = the best month since Opening Act. The daily curve follows the Aug–Oct install-day shape with Diwali factors.", text: "How the plan is built" });
  main.append(block(1, "Installations vs plan by cluster", usePlan ? `${ctx.curText} · ${ctx.curRange} · ${planWord} plan (switch at the top) · click a cluster for what to push, a count for its installs` : `${ctx.curText} · actuals only (${planMonth ? "the plan is per cluster: clear the lane / payment / COM / SOH / ZOH / cell filters" : "no install plan loaded for this month"})`,
    el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [
      el("span", { class: "count", text: usePlan ? `All clusters: ${fmtInt(allT.mtd)} installs · plan clusters ${fmtInt(planT.mtd)} of ${fmtInt(Math.round(planT.exp || 0))} plan MTD (${pctTxt(planT.ach)} achieved) · required run rate ${planT.need != null ? planT.need.toFixed(1) : "–"}/day` : `All clusters: ${fmtInt(allT.mtd)} installs` }), usePlan ? method : null]),
    tierTable({ rows: cRows, cols, totalOf, sumParts, tier: state.tier, onTier: (v) => setState({ tier: v }), sortKey: "mtd", sortDir: -1 })));

  // ---------------- 2 · trend: installs vs plan (plan clusters)
  const grain = ["dod", "wow", "mom", "cum"].includes(state.instGrain) ? state.instGrain : "dod";
  const planSet = new Set(planRowsAll.map((r) => r.name));
  const scoped = planSet.size ? rows.filter((x) => planSet.has(cl(x))) : rows;
  const byDay = new Map(); for (const x of scoped) { const d = x[c.installed_day]; if (d != null) byDay.set(d, (byDay.get(d) || 0) + 1); }
  const dayTarget = (d) => {
    const k = monthKey(d), pm = (data.plan.months || {})[k];
    if (!pm || !planSet.size || otherFilters.length) return null;
    const [a, b] = monthBounds(k), i = d - a, n = b - a + 1;
    return [...planSet].reduce((s, name) => { const pc = pm.clusters[name]; if (!pc) return s; return s + (pc.base_cum ? pc.base_cum[Math.min(i, pc.base_cum.length - 1)] - (i ? pc.base_cum[Math.min(i - 1, pc.base_cum.length - 1)] : 0) : pc.base_total / n); }, 0);
  };
  let chart;
  if (grain === "cum") {
    const [a] = monthBounds(ctx.key), days = Array.from({ length: ctx.days }, (_, i) => i + 1);
    const act = []; let run = 0; for (const d of days) { if (a + d - 1 > last) { act.push(null); continue; } run += byDay.get(a + d - 1) || 0; act.push(run); }
    const cumOf = (field, total) => days.map((d) => planRowsAll.reduce((s, r) => { const pc = planMonth.clusters[r.name]; return s + (pc[field] ? pc[field][Math.min(d, pc[field].length) - 1] : (pc[total] * d) / ctx.days); }, 0));
    chart = usePlan ? lineChart(days.map(String), [{ label: "Actual", data: act, color: "--series-1" },
      { label: `${planWord[0].toUpperCase()}${planWord.slice(1)} plan`, data: cumOf("base_cum", "base_total").map(Math.round), color: "--series-2" },
      { label: ctx.planMode === "aggr" ? "Base plan" : "Aggressive plan", data: cumOf("aggr_cum", "aggr_total").map(Math.round), color: "--series-3" }], { yFormat: (v) => fmtInt(v), height: 290 })
      : el("div", { class: "count", text: "No plan for this month." });
  } else {
    const labels = [], act = [], tgt = [];
    if (grain === "dod") for (let d = last - (daySpanOf(state) - 1); d <= last; d++) { labels.push(fmtDay(d).slice(0, 6)); act.push(byDay.get(d) || 0); const t = dayTarget(d); tgt.push(t == null ? null : Math.round(t)); }
    else if (grain === "wow") for (let w = 11; w >= 0; w--) { const b = last - 7 * w, a = b - 6; let s = 0, t = 0, has = false; for (let d = a; d <= b; d++) { s += byDay.get(d) || 0; const dt = dayTarget(d); if (dt != null) { t += dt; has = true; } } labels.push(`${fmtDay(a).slice(0, 6)}–${fmtDay(b).slice(0, 6)}`); act.push(s); tgt.push(has ? Math.round(t) : null); }
    else for (const k of monthsBetween(data.meta.windows.YTD[0], last)) { const [a, b] = monthBounds(k), to = Math.min(b, last); let s = 0, t = 0, has = false; for (let d = a; d <= to; d++) { s += byDay.get(d) || 0; const dt = dayTarget(d); if (dt != null) { t += dt; has = true; } } labels.push(monthLabel(k) + (to < b ? " (MTD)" : "")); act.push(s); tgt.push(has ? Math.round(t) : null); }
    const hasT = tgt.some((v) => v != null);
    chart = comboChart(labels, { label: "Installs", data: act, color: "--series-1" }, hasT ? { label: `${planWord[0].toUpperCase()}${planWord.slice(1)} plan`, data: tgt, color: "--series-2" } : null, { yFormat: (v) => fmtInt(v), height: 290 });
  }
  main.append(block(2, "Installs vs plan over time", `${planSet.size ? `${planSet.size} plan clusters` : "All clusters"} · ${grain === "cum" ? "this month, cumulative" : "bars = installs, dashed = the plan (its daily curve)"} · plan only for months that have one`,
    box([el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [
      segmented([["mom", "Month on month"], ["wow", "Week on week"], ["dod", "Day on day"], ["cum", "This month, cumulative"]], grain, (v) => setState({ instGrain: v }), "Grain"), grain === "dod" ? daySpanSwitch(state, setState) : null]), chart])));

  // ---------------- 3 · split: HOTO age or lane (installs this month, every cluster)
  const split = state.instSplit === "lane" ? "lane" : "age";
  const cats = split === "age" ? [["0", "M0 · HOTO this month"], ["1", "M1 · last month"], ["2", "M2+ · older"]] : (data.meta.lanes || []).map((l) => [l, l]);
  const catOf = split === "age" ? (x) => String(hotoAge(x[c.installed_day], x[c.hoto_day])) : (x) => label(f, "lane", x[c.lane]);
  const curAll = installed(rows, ctx.cur);
  const sRow = (name, xs) => { const r = { name, n: xs.length, by: {} }; for (const [k] of cats) { r.by[k] = xs.filter((x) => catOf(x) === k); r[`c_${k}`] = r.by[k].length; } return r; };
  const sRows = clusters.map((n) => sRow(n, curAll.filter((x) => cl(x) === n))).filter((r) => r.n);
  const sTot = { ...sRow("All clusters", curAll), footer: true };
  const sCell = (k, name) => (v, r) => { const xs = r.by[k], p = r.n ? (100 * xs.length) / r.n : null; if (!xs.length) return el("span", { class: "count", text: "·" });
    return el("span", { class: "split-cell" }, [r.footer ? fmtInt(xs.length) : cntBtn(xs, `${r.name} · ${name}`), el("small", { text: pctTxt(p) })]); };
  main.append(block(3, "What the installs are made of", `${ctx.curText} · ${ctx.curRange} · count and share of each cluster's installs`,
    box([el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["age", "HOTO age"], ["lane", "Lane"]], split, (v) => setState({ instSplit: v }), "Split")]),
      dataTable([{ key: "name", label: "Cluster" }, { key: "n", label: "Installs", num: true, fmt: fmtInt }, ...cats.map(([k, name]) => ({ key: `c_${k}`, label: name, num: true, fmt: sCell(k, name) }))], sRows, { sortKey: "n", sortDir: -1, maxHeight: 520, footer: sTot })])));

  // ---------------- 4 · project list
  main.append(block(4, "Installs in the period", `${fmtInt(curAll.length)} installs · ${ctx.curRange}`,
    box(projectList(list.cols, curAll.map(list.row), { searchKeys: list.cols.filter((x) => !x.num).map((x) => x.key), sortKey: "installed", sortDir: -1, filename: `installs_${ctx.key}.csv`, noun: "installs" }))));

  // ---------------- 5 · month on month
  const metrics = [
    { id: "inst", label: "Installations", src: "f", kind: "count", good: "up", value: (rs, r) => installed(rs, r).length, pick: installed, hint: "Installation task 039B done" },
    { id: "m0", label: "Installs · M0 (HOTO this month)", src: "f", kind: "count", good: "up", value: (rs, r) => byAge(0)(rs, r).length, pick: byAge(0) },
    { id: "m1", label: "Installs · M1 (HOTO last month)", src: "f", kind: "count", good: "up", value: (rs, r) => byAge(1)(rs, r).length, pick: byAge(1) },
    { id: "m2", label: "Installs · M2+ (older HOTOs)", src: "f", kind: "count", good: "up", value: (rs, r) => byAge(2)(rs, r).length, pick: byAge(2) },
  ];
  main.append(block(5, "Month on month", `${planSet.size ? "Plan clusters · " : ""}installations by HOTO age · month to date and full months, last 6 months`,
    momTables(metrics, ctx, { f: { file: f, ci: c, rows: scoped, list } })));
}
