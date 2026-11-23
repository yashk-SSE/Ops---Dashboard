// Overview V3 (D-110): our major metrics against the plans, nothing else.
//  1. This month vs MOP: HOTOs vs the HOTO MOP, installations vs the install plan (base or aggressive, top-bar switch),
//     plan clusters. Click a card: cluster, MOP target, MOP MTD, actual, achieved %.
//  2. FY27 so far vs AOP (Apr '26 to yesterday): HOTOs, installations, commissions, revenue. Click a card: clusters by month.
//     AOP targets are waiting for the AOP sheet; revenue actuals (order value of installs) are being added.
import { el, dataTable } from "../ui.js";
import { label, fmtDay, monthKey, monthLabel, monthsBetween, activeFilterDims } from "../data.js";
import { fmtInt } from "../stats.js";
import * as M from "../metrics.js";
import { block, openPanel } from "../layout.js";

const PLAN_FILTERS = new Set(["region", "cluster"]);
const tone = (p) => (p == null ? "flat" : p >= 90 ? "good" : p >= 75 ? "warn" : "bad");  // D-99 bands
const pctTxt = (p) => (p == null ? "–" : `${Math.round(p)}%`);

export function render(main, { data, state, ctx }) {
  const { p1, p2 } = data;
  const c1 = p1.ci, c2 = p2.ci, last = ctx.last, inR = M.inRange;
  const p1r = M.p1Rows(data, state), p2r = M.p2Rows(data, state);
  const cl1 = (x) => label(p1, "cluster", x[c1.cluster]), cl2 = (x) => label(p2, "cluster", x[c2.cluster]);
  const planWord = ctx.planMode === "aggr" ? "aggressive" : "base";

  // ---------------- 1 · this month vs MOP
  const planMonth = (data.plan.months || {})[ctx.key];
  const otherFilters = activeFilterDims(state.filters).filter((k) => !PLAN_FILTERS.has(k));
  const present = new Set([...p2r.map(cl2), ...p1r.map(cl1)]);
  const planClusters = planMonth && !otherFilters.length ? Object.entries(planMonth.clusters).filter(([k]) => present.has(k)) : [];
  const dIdx = Math.max(0, Math.min(ctx.dayN, 31) - 1);
  const rows = planClusters.map(([name, pc]) => {
    const hoto = { target: pc.hoto_mop || 0, mtd: ((pc.hoto_mop || 0) * ctx.dayN) / ctx.days,
      act: p1r.filter((x) => cl1(x) === name && inR(x[c1.hoto_day], ctx.cur)).length, lm: p1r.filter((x) => cl1(x) === name && inR(x[c1.hoto_day], ctx.prevSame)).length };
    const inst = { target: pc.base_total || 0, mtd: pc.base_cum ? pc.base_cum[dIdx] : ((pc.base_total || 0) * ctx.dayN) / ctx.days,
      act: p2r.filter((x) => cl2(x) === name && inR(x[c2.installed_day], ctx.cur)).length, lm: p2r.filter((x) => cl2(x) === name && inR(x[c2.installed_day], ctx.prevSame)).length };
    return { name, group: pc.group, hoto, inst };
  });
  const sum = (k, f) => rows.reduce((a, r) => a + r[k][f], 0);

  const mopCard = (key, title, unit, targetName) => {
    const tgt = sum(key, "target"), mtd = sum(key, "mtd"), act = sum(key, "act"), lm = sum(key, "lm");
    const ach = mtd ? (100 * act) / mtd : null, rr = ctx.dayN ? act / ctx.dayN : 0, left = Math.max(1, ctx.days - ctx.dayN);
    const need = Math.max(0, (tgt - act) / left), d = M.delta(act, lm, "count", "up");
    const tip = [`${title}, ${ctx.curRange}: ${fmtInt(act)} (${rows.length} plan clusters)`,
      `${targetName} MTD ${fmtInt(Math.round(mtd))} = ${key === "inst" ? `the ${planWord} install plan's daily curve to the end of day ${ctx.dayN}` : `the month's MOP × ${ctx.dayN}/${ctx.days} days (no daily curve)`}`,
      `Achieved ${pctTxt(ach)} of ${targetName} MTD · ${pctTxt(tgt ? (100 * act) / tgt : null)} of the month's ${targetName}`,
      `Same days last month (LMTD): ${fmtInt(lm)}`, `Run rate ${rr.toFixed(1)}/day · required run rate ${need.toFixed(1)}/day for the remaining ${left} days`, "Click for the cluster table"].join("\n");
    const node = el("div", { class: "card pace2 linked ov-card", role: "button", tabindex: "0", "data-tip": tip }, [
      el("div", { class: "p2-title" }, [title, el("span", { text: ` · ${unit}` })]),
      el("div", { class: "p2-value", text: fmtInt(act) }),
      el("div", { class: "p2-line" }, [`${targetName} MTD: ${fmtInt(Math.round(mtd))} ·`, el("b", { class: tone(ach), text: `${pctTxt(ach)} achieved` })]),
      el("div", { class: "pace-bar" }, el("i", { class: tone(ach), style: { width: `${ach == null ? 0 : Math.min(100, ach)}%` } })),
      el("div", { class: "p2-line" }, [el("span", { class: "nowrap" }, [d ? el("span", { class: `delta ${d.tone}`, text: `${d.arrow} ${d.text}` }) : null, ` vs ${fmtInt(lm)} LMTD`]),
        el("span", { class: "nowrap", text: `· run rate ${rr.toFixed(1)}/day` })]),
      el("div", { class: "p2-line muted", text: `Month ${targetName === "Plan" ? "plan" : targetName} ${fmtInt(tgt)} · required run rate ${need.toFixed(1)}/day` }),
    ]);
    const open = () => openPanel({ title: `${title} vs ${targetName} by cluster`, sub: `${ctx.curText} · ${ctx.curRange} · ${targetName} MTD to the end of day ${ctx.dayN}`,
      body: dataTable([
        { key: "name", label: "Cluster" },
        { key: "target", label: `${targetName} target`, num: true, fmt: fmtInt },
        { key: "mtd", label: `${targetName} MTD`, num: true, fmt: (v) => fmtInt(Math.round(v)) },
        { key: "act", label: "Actual", num: true, fmt: fmtInt },
        { key: "ach", label: "Achieved MTD", num: true, tip: `Actual ÷ ${targetName} MTD`, fmt: (v) => el("span", { class: `pill ${tone(v)}`, text: pctTxt(v) }) },
      ], rows.map((r) => ({ name: r.name, ...r[key], ach: r[key].mtd ? (100 * r[key].act) / r[key].mtd : null })),
      { sortKey: "ach", sortDir: 1, maxHeight: 640, footer: { name: "All plan clusters", target: tgt, mtd, act, ach } }) });
    node.addEventListener("click", open); node.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    return node;
  };

  if (planClusters.length) {
    main.append(block(1, "This month vs MOP", `${ctx.curText} · ${ctx.curRange} · ${rows.length} plan clusters · installs vs the ${planWord} plan (switch at the top) · click a card for clusters`,
      el("div", { class: "grid ov-grid" }, [mopCard("hoto", "HOTOs", "HOTO MOP", "MOP"), mopCard("inst", "Installations", `${planWord} install plan`, "Plan")])));
  } else {
    main.append(block(1, "This month vs MOP", "", el("div", { class: "card count", text: otherFilters.length
      ? "The MOP is per cluster: clear the lane / payment lane / COM / SOH / ZOH / cell filters to compare with it."
      : `No MOP for ${ctx.curText} yet (the Install Plan sheet is loaded month by month).` })));
  }

  // ---------------- 2 · FY27 so far vs AOP (targets pending)
  const fyFrom = data.meta.windows.YTD[0], fyTo = last;
  const fyLabel = `${fmtDay(fyFrom)} – ${fmtDay(fyTo)}`;
  const months = monthsBetween(fyFrom, fyTo);
  const aopMetrics = [
    { id: "hoto", title: "HOTOs", rows: p1r, day: (x) => x[c1.hoto_day], cl: cl1 },
    { id: "inst", title: "Installations", rows: p2r, day: (x) => x[c2.installed_day], cl: cl2 },
    { id: "comm", title: "Commissions", rows: p2r, day: (x) => x[c2.commissioned_day], cl: cl2 },
  ];
  const aopCard = (m) => {
    const ytd = m.rows.filter((x) => inR(m.day(x), [fyFrom, fyTo]));
    const mtd = ytd.filter((x) => inR(m.day(x), ctx.cur)).length, lm = m.rows.filter((x) => inR(m.day(x), ctx.prevSame)).length;
    const d = M.delta(mtd, lm, "count", "up");
    const node = el("div", { class: "card pace2 linked ov-card", role: "button", tabindex: "0",
      "data-tip": `${m.title}, FY27 so far (${fyLabel}): ${fmtInt(ytd.length)}\nAOP targets: waiting for the AOP sheet\nThis month (${ctx.curRange}): ${fmtInt(mtd)} · LMTD ${fmtInt(lm)}\nClick for clusters by month` }, [
      el("div", { class: "p2-title" }, [m.title, el("span", { text: " · FY27 so far" })]),
      el("div", { class: "p2-value", text: fmtInt(ytd.length) }),
      el("div", { class: "p2-line" }, ["AOP YTD: –", el("span", { class: "pill flat", text: "AOP sheet pending" })]),
      el("div", { class: "pace-bar" }, el("i", { style: { width: "0%" } })),
      el("div", { class: "p2-line" }, [el("span", { class: "nowrap" }, [`This month ${fmtInt(mtd)}`, d ? el("span", { class: `delta ${d.tone}`, text: `${d.arrow} ${d.text}` }) : null]), el("span", { class: "nowrap", text: "vs LMTD" })]),
      el("div", { class: "p2-line muted", text: `${monthLabel(months[0])} – ${monthLabel(months.at(-1))} · click for clusters by month` }),
    ]);
    const open = () => {
      const byCl = new Map();
      for (const x of ytd) { const k = m.cl(x); if (!k || k === "—" || k === "Not mapped") continue; if (!byCl.has(k)) byCl.set(k, {}); const mk = monthKey(m.day(x)); byCl.get(k)[mk] = (byCl.get(k)[mk] || 0) + 1; }
      const trows = [...byCl.entries()].map(([name, mm]) => { const r = { name, ytd: 0 }; for (const k of months) { r[k] = mm[k] || 0; r.ytd += r[k]; } return r; });
      const tot = { name: "All clusters", ytd: 0 }; for (const k of months) { tot[k] = trows.reduce((a, r) => a + r[k], 0); tot.ytd += tot[k]; }
      openPanel({ title: `${m.title} by cluster, month on month`, sub: `FY27 so far (${fyLabel}) · ${monthLabel(months.at(-1))} to yesterday · AOP columns appear once the AOP sheet is shared`,
        body: dataTable([{ key: "name", label: "Cluster" }, ...months.map((k) => ({ key: k, label: monthLabel(k), num: true, fmt: fmtInt })),
          { key: "ytd", label: "FY27 YTD", num: true, fmt: fmtInt }, { key: "aop", label: "AOP YTD", num: true, fmt: () => "–" }, { key: "aopPct", label: "Achieved YTD", num: true, fmt: () => "–" }],
        trows, { sortKey: "ytd", sortDir: -1, maxHeight: 640, footer: tot }) });
    };
    node.addEventListener("click", open); node.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    return node;
  };
  const revenueCard = el("div", { class: "card pace2 ov-card", "data-tip": "Revenue = pre-tax order value of projects installed in the period (as the Central Base Sheet's Revenue tab). The order value is being added to the data; targets come with the AOP sheet." }, [
    el("div", { class: "p2-title" }, ["Revenue", el("span", { text: " · FY27 so far" })]),
    el("div", { class: "p2-value muted-val", text: "–" }),
    el("div", { class: "p2-line" }, ["AOP YTD: –", el("span", { class: "pill flat", text: "AOP sheet pending" })]),
    el("div", { class: "pace-bar" }, el("i", { style: { width: "0%" } })),
    el("div", { class: "p2-line", text: "Order value of installs (pre-tax)" }),
    el("div", { class: "p2-line muted", text: "being added to the data" }),
  ]);
  main.append(block(2, "FY27 so far vs AOP", `${fyLabel} · AOP targets appear here once the AOP sheet is shared · click a card for clusters by month`,
    el("div", { class: "grid ov-grid four" }, [...aopMetrics.map(aopCard), revenueCard])));
}
