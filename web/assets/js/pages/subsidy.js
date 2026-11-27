// Subsidy backlog V3 (D-112): "How much subsidy is pending, where, and for how long?"
// Logic of the "New - Pending Subsidy Tracker_V1" sheet on live system data (D-87, D-90): stage = current OMS subsidy status
// ("Vendor Selection Pending" = commissioned from 1 Oct 2026, no status yet; older no-status projects counted apart); backlog =
// National DBT, commissioned, not cancelled, not disbursed; days in stage = since the first entry into the current status.
//  1. Cluster table (BAU / Expansion folds): backlog, over 30 days in stage, vendor selection pending, disbursed MTD vs LMTD,
//     commissioning -> disbursed P50, commissioned MTD (inflow).
//  2. Trend: disbursed (bars) vs commissioned (line), month / week (OMS records disbursals in batches, so days read badly).
//  3. Split: stage x days in stage.  4. Cluster x stage (stage order).  5. Month on month (above the list, D-123).  6. Backlog list (or the old no-status list).
import { el, dataTable, segmented, projectList } from "../ui.js";
import { label, fmtDay, bucketOf, matcher, monthBounds, monthLabel, monthsBetween } from "../data.js";
import { fmtInt, tatSummary } from "../stats.js";
import * as M from "../metrics.js";
import { momTables, block, tierTable, openList, stageMatrix, chartClusters } from "../layout.js";
import { comboChart } from "../charts.js";
import { subsidyList } from "../lists.js";

const SKIP = new Set(["", "—", "Not mapped"]);
const VSP = "Vendor Selection Pending";
const box = (kids) => el("div", { class: "card" }, kids);
const pctTxt = (p) => (p == null ? "–" : `${Math.round(p)}%`);
const dTxt = (v) => (v == null ? "–" : `${Math.round(v)} d`);

export function render(main, { data, state, setState, ctx }) {
  const f = data.sub, c = f.ci, asOf = data.meta.as_of_day, last = ctx.last;
  const rows = f.facts.filter(matcher(f, state.filters, c));
  const inR = M.inRange;
  const stg = (x) => label(f, "stage", x[c.stage]), cl = (x) => label(f, "cluster", x[c.cluster]);
  const inStage = (x) => (x[c.stage_day] == null ? null : asOf - x[c.stage_day]);
  const back = rows.filter((x) => x[c.in_backlog]), oldNo = rows.filter((x) => x[c.old_no_status]);
  const list = subsidyList(f, asOf);
  const lateCols = [...list.cols, { key: "late", label: "Late", tip: "More than 30 days in the same subsidy stage" }];
  const lateRow = (x) => ({ ...list.row(x), late: inStage(x) > 30 ? "Late (over 30 days in stage)" : "Not late" });
  const openRows = (title, xs) => openList({ title, sub: `${fmtInt(xs.length)} projects`, cols: lateCols, rows: [...xs].sort((a, b) => (inStage(b) ?? -1) - (inStage(a) ?? -1)).map(lateRow), filename: `${title.replace(/\W+/g, "_").toLowerCase()}.csv` });
  const btn = (xs, title) => (xs.length ? el("button", { type: "button", class: "link-btn", text: fmtInt(xs.length), onclick: (e) => { e.stopPropagation(); openRows(title, xs); } }) : el("span", { class: "count", text: "0" }));
  // disbursal dates are reliable from Oct 2026 only (status history bulk-loaded before, D-87)
  const reliableFrom = monthBounds((f.history_reliable_from || "2026-10-01").slice(0, 7))[0];
  const ok = (r) => r && r[0] >= reliableFrom;
  const disbursed = (rs, r) => rs.filter((x) => inR(x[c.disbursed_day], r));
  const tats = (rs, r) => disbursed(rs, r).map((x) => x[c.comm_to_disbursed]).filter((d) => d != null);

  // ---------------- 1 · cluster table
  const clusters = [...new Set(rows.map(cl))].filter((k) => !SKIP.has(k));
  const cRow = (name) => {
    const rs = rows.filter((x) => cl(x) === name), b = back.filter((x) => cl(x) === name);
    const over = b.filter((x) => inStage(x) > 30), vsp = b.filter((x) => stg(x) === VSP);
    const disb = ok(ctx.cur) ? disbursed(rs, ctx.cur) : [], lm = ok(ctx.prevSame) ? disbursed(rs, ctx.prevSame).length : null;
    const comm = rs.filter((x) => inR(x[c.comm_day], ctx.cur));
    return { name, b, nB: b.length, over, nO: over.length, vsp, nV: vsp.length, disb, nD: ok(ctx.cur) ? disb.length : null, lm, p50: ok(ctx.cur) ? tatSummary(tats(rs, ctx.cur)).p50 : null, comm, nC: comm.length };
  };
  const cRows = clusters.map(cRow).filter((r) => r.nB || r.nD || r.nC);
  const cols = [
    { key: "name", label: "Cluster" },
    { key: "nB", label: "Backlog", num: true, tip: "National DBT, commissioned, not cancelled, not disbursed (live)", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.b, `${r.name} · subsidy backlog`)) },
    { key: "nO", label: "> 30 days in stage", num: true, tip: "In the same subsidy stage for more than 30 days (since first entering it)", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.over, `${r.name} · more than 30 days in stage`)) },
    { key: "pO", label: "Share > 30 d", num: true, fmt: (v, r) => { const p = r.nB ? (100 * r.nO) / r.nB : null; return p == null ? "–" : el("span", { class: `pill ${p >= 25 ? "bad" : p >= 10 ? "warn" : "good"}`, text: pctTxt(p) }); } },
    { key: "nV", label: "Vendor selection pending", num: true, tip: "Commissioned from 1 Oct 2026, no subsidy status yet", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.vsp, `${r.name} · vendor selection pending`)) },
    { key: "nD", label: "Disbursed MTD", num: true, tip: "First move to 'Subsidy Disbursed' this month, as OMS recorded it (batches)", fmt: (v, r) => (v == null ? "–" : r.footer ? fmtInt(v) : btn(r.disb, `${r.name} · disbursed ${ctx.curText}`)) },
    { key: "dl", label: "vs LMTD", num: true, fmt: (v, r) => { const d = r.nD == null || r.lm == null ? null : M.delta(r.nD, r.lm, "count", "up"); return d ? el("span", { class: `delta ${d.tone}`, "data-tip": `LMTD ${fmtInt(r.lm)}`, text: `${d.arrow} ${d.text}` }) : "–"; } },
    { key: "p50", label: "Comm. → disbursed P50", num: true, tip: "Projects disbursed this month: days from commissioning", fmt: dTxt },
    { key: "nC", label: "Commissioned MTD", num: true, tip: "National DBT projects commissioned this month (inflow)", fmt: fmtInt },
  ];
  const totalOf = (rs, name) => {
    const names = new Set(rs.map((r) => r.name)), sub = rows.filter((x) => names.has(cl(x))), s = (k) => rs.reduce((a, r) => a + (r[k] || 0), 0);
    return { footer: true, name, nB: s("nB"), nO: s("nO"), nV: s("nV"), nD: ok(ctx.cur) ? s("nD") : null, lm: ok(ctx.prevSame) ? s("lm") : null, p50: ok(ctx.cur) ? tatSummary(tats(sub, ctx.cur)).p50 : null, nC: s("nC") };
  };
  const sumParts = (t) => [el("span", {}, ["Backlog ", el("b", { text: fmtInt(t.nB) })]), el("span", {}, ["> 30 d ", el("b", { text: fmtInt(t.nO) })]),
    el("span", {}, ["Disbursed ", el("b", { text: t.nD == null ? "–" : fmtInt(t.nD) })])];
  const allT = totalOf(cRows, "All clusters");
  main.append(block(1, "Subsidy backlog by cluster", `${ctx.curText} · ${ctx.curRange} · backlog live · disbursals as OMS recorded them (from Oct 2026) · click a count for its projects`,
    el("div", { class: "count", style: { margin: "0 0 8px" }, text: `All clusters: ${fmtInt(allT.nB)} in backlog · ${fmtInt(allT.nO)} more than 30 days in their stage · ${fmtInt(allT.nV)} vendor selection pending · ${allT.nD == null ? "–" : fmtInt(allT.nD)} disbursed this month · ${fmtInt(oldNo.length)} with no status (commissioned before Oct, not in the backlog)` }),
    tierTable({ rows: cRows, cols, totalOf, sumParts, tier: state.tier, onTier: (v) => setState({ tier: v }), sortKey: "nB", sortDir: -1 })));

  // ---------------- 2 · trend: disbursed vs commissioned
  // D-125: the graph's own cluster picker (this graph only, inside the top-bar filters)
  const cp = chartClusters(state, setState, "sub", rows.map(cl));
  const gRows = rows.filter((x) => cp.keep(cl(x)));
  const grain = state.subGrain === "mom" ? "mom" : "wow";
  const byDay = (field) => { const m = new Map(); for (const x of gRows) { const d = x[c[field]]; if (d != null) m.set(d, (m.get(d) || 0) + 1); } return m; };
  const dDay = byDay("disbursed_day"), cDay = byDay("comm_day");
  const labels = [], ds = [], cs = [];
  const addRange = (lbl, a, b) => { let d1 = 0, c1 = 0; for (let d = a; d <= b; d++) { d1 += dDay.get(d) || 0; c1 += cDay.get(d) || 0; } labels.push(lbl); ds.push(a >= reliableFrom ? d1 : null); cs.push(c1); };
  if (grain === "wow") for (let w = 11; w >= 0; w--) { const b = last - 7 * w, a = b - 6; addRange(`${fmtDay(a).slice(0, 6)}–${fmtDay(b).slice(0, 6)}`, a, b); }
  else for (const k of monthsBetween(data.meta.windows.YTD[0], last)) { const [a, b] = monthBounds(k); addRange(monthLabel(k) + (b > last ? " (MTD)" : ""), a, Math.min(b, last)); }
  main.append(block(2, "Disbursed vs commissioned over time", "Bars = subsidy disbursed (as OMS recorded it; blank before Oct 2026, when the history was bulk-loaded), dashed line = National DBT projects commissioned" + cp.note,
    box([el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["mom", "Month on month"], ["wow", "Week on week"]], grain, (v) => setState({ subGrain: v }), "Grain"), cp.node]),
      comboChart(labels, { label: "Disbursed", data: ds, color: "--series-1" }, { label: "Commissioned", data: cs, color: "--series-2" }, { yFormat: (v) => fmtInt(v), height: 290 })])));

  // ---------------- 3 · split: stage x days in stage
  const stages = f.stages.filter((s) => back.some((x) => stg(x) === s));
  const buckets = f.aging_buckets, bl = buckets.map((b) => b[2]);
  const ageRows = stages.map((s) => { const xs = back.filter((x) => stg(x) === s), r = { stage: s, n: xs.length, by: {} }; for (const b of bl) { r.by[b] = xs.filter((x) => inStage(x) != null && bucketOf(inStage(x), buckets) === b); r[`b_${b}`] = r.by[b].length; } return r; });
  const ageTot = { footer: true, stage: "All stages", n: back.length, by: {} }; for (const b of bl) { ageTot.by[b] = back.filter((x) => inStage(x) != null && bucketOf(inStage(x), buckets) === b); ageTot[`b_${b}`] = ageTot.by[b].length; }
  const aCell = (b) => (v, r) => { const xs = r.by[b]; if (!xs.length) return el("span", { class: "count", text: "·" });
    return el("span", { class: "split-cell" }, [r.footer ? fmtInt(xs.length) : btn(xs, `${r.stage} · ${b} in stage`), el("small", { text: pctTxt(r.n ? (100 * xs.length) / r.n : null) })]); };
  main.append(block(3, "How long the backlog has been waiting", `${fmtInt(back.length)} in backlog · days in the current stage (buckets as the Pending Subsidy Tracker; vendor selection counts from commissioning) · stages in order`,
    box(dataTable([{ key: "stage", label: "Stage" }, { key: "n", label: "Backlog", num: true, fmt: fmtInt }, ...bl.map((b) => ({ key: `b_${b}`, label: b, num: true, fmt: aCell(b) }))], ageRows, { maxHeight: 420, footer: ageTot }))));

  // ---------------- 4 · cluster x stage
  main.append(block(4, "Where the backlog sits: cluster × stage", `${fmtInt(back.length)} in backlog · live · stages in order (Vendor selection → PCR → DISCOM inspection → Redeem → Disbursal) · late = more than 30 days in the stage`,
    box(stageMatrix({ items: back, groupOf: cl, stageOf: stg, order: f.stages, late: (x) => inStage(x) > 30, onCell: (xs, title) => openRows(title, xs), lateWord: "over 30 days" }))));

  // ---------------- 6 · list (backlog, or the old no-status projects; shown below the month on month)
  const which = state.subList === "old" ? "old" : "back";
  const listRows = which === "back" ? back : oldNo;
  const listBlock = block(6, which === "back" ? "Backlog: project list" : "No status, commissioned before Oct 2026", which === "back" ? `${fmtInt(back.length)} projects · longest in stage first` : `${fmtInt(oldNo.length)} projects · not in the backlog (the tracker leaves them out) · never got a subsidy status (D-90)`,
    el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["back", `Backlog (${fmtInt(back.length)})`], ["old", `No status, before Oct (${fmtInt(oldNo.length)})`]], which, (v) => setState({ subList: v }), "List")]),
    box(projectList(list.cols, [...listRows].sort((a, b) => (inStage(b) ?? -1) - (inStage(a) ?? -1)).map(list.row), { searchKeys: list.cols.filter((x) => !x.num).map((x) => x.key), sortKey: "days", sortDir: -1, filename: which === "back" ? "subsidy_backlog.csv" : "subsidy_no_status_old.csv" })));
  main.append(listBlock);  // the month on month goes in above it (D-123)

  // ---------------- 5 · month on month (inserted above the list, D-123)
  const stageCount = (name) => (rs) => rs.filter((x) => x[c.in_backlog] && stg(x) === name).length;
  const metrics = [
    { id: "disb", label: "Subsidy disbursed", src: "s", kind: "count", good: "up", value: (rs, r) => (ok(r) ? disbursed(rs, r).length : null), pick: disbursed },
    { id: "tat", label: "Commissioning → disbursed P50", src: "s", kind: "days", good: "down", value: (rs, r) => (ok(r) ? tatSummary(tats(rs, r)).p50 : null), base: (rs, r) => (ok(r) ? tats(rs, r).length : 0) },
    { id: "tat90", label: "Commissioning → disbursed P90", src: "s", kind: "days", good: "down", value: (rs, r) => (ok(r) ? tatSummary(tats(rs, r)).p90 : null), base: (rs, r) => (ok(r) ? tats(rs, r).length : 0) },
    { id: "comm", label: "Commissioned (National DBT)", src: "s", kind: "count", good: "up", value: (rs, r) => rs.filter((x) => inR(x[c.comm_day], r)).length },
    { id: "backlog", label: "Subsidy backlog (now)", src: "s", kind: "now", good: "down", value: (rs) => rs.filter((x) => x[c.in_backlog]).length },
    { id: "vsp", label: "Vendor selection pending (now)", src: "s", kind: "now", good: "down", value: stageCount(VSP) },
  ];
  main.insertBefore(block(5, "Month on month", "Disbursals by the month OMS recorded them (from Oct 2026; earlier months bulk-loaded) · commissioned by month of commissioning",
    momTables(metrics, ctx, { s: { file: f, ci: c, rows, list } }, { state, setState })), listBlock);
}
