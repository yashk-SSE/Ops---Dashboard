// Escalations V3 (D-113): "Are customers escalating, and are we closing fast?"  (D-75, D-85)
// Operations tickets from Freshdesk: not merged, with an SSE ID, CT Team excluded. All levels; L2-L5 + Red Alert = true escalations.
// Closure TAT and aging buckets as Q-1767 (IST calendar days). "Open too long" = past the closure limit by the global stuck rule
// (India P90, or 2 x India P50, of tickets closed in the last 6 full months).
//  1. Cluster table (BAU / Expansion folds).  2. Trend: raised vs closed.  3. Split: by level or issue type.
//  4. Open tickets by days open.  5. Open ticket list.  6. Month on month.
import { el, dataTable, segmented, projectList } from "../ui.js";
import { label, fmtDay, bucketOf, matcher, monthBounds, monthLabel, monthsBetween } from "../data.js";
import { fmtInt, pct, tatSummary } from "../stats.js";
import * as M from "../metrics.js";
import { momTables, block, tierTable, openList, daySpanOf, daySpanSwitch } from "../layout.js";
import { comboChart } from "../charts.js";
import { escTicketList } from "../lists.js";

const L3PLUS = new Set(["L3 - Founders", "L4 - Social Media", "L5 - Consumer Forum"]);
const SKIP = new Set(["", "—", "Not mapped"]);
const box = (kids) => el("div", { class: "card" }, kids);
const pctTxt = (p) => (p == null ? "–" : `${Math.round(p)}%`);
const dTxt = (v) => (v == null ? "–" : `${v < 10 ? (Math.round(v * 10) / 10) : Math.round(v)} d`);

export function render(main, { data, state, setState, ctx }) {
  const f = data.esc, c = f.ci, asOf = data.meta.as_of_day, last = ctx.last;
  const rows = f.facts.filter(matcher(f, state.filters, c));
  const inR = M.inRange, R = M.stuckShort(ctx);
  const lvl = (x) => label(f, "level", x[c.level]), cl = (x) => label(f, "cluster", x[c.cluster]);
  const list = escTicketList(f);
  const openT = (title, xs) => openList({ title, sub: `${fmtInt(xs.length)} tickets`, cols: list.cols, rows: [...xs].sort((a, b) => a[c.created_day] - b[c.created_day]).map(list.row), noun: "tickets", filename: `${title.replace(/\W+/g, "_").toLowerCase()}.csv` });
  const btn = (xs, title) => (xs.length ? el("button", { type: "button", class: "link-btn", text: fmtInt(xs.length), onclick: (e) => { e.stopPropagation(); openT(title, xs); } }) : el("span", { class: "count", text: "0" }));
  const created = (rs, r) => rs.filter((x) => inR(x[c.created_day], r));
  const closedTat = (rs, r) => rs.filter((x) => inR(x[c.closed_day], r) && x[c.closure_tat] != null).map((x) => x[c.closure_tat]);
  const isOpen = (x) => !!x[c.is_open];
  // closure limit, India-wide (all tickets closed in the last 6 full months), by the stuck rule
  const win = [ctx.cols.at(0).range[0], ctx.cols.at(-1).range[1]];
  const limit = M.stuckLimit(f.facts.filter((x) => inR(x[c.closed_day], win) && x[c.closure_tat] != null).map((x) => x[c.closure_tat]), ctx);
  const ageOf = (x) => asOf - x[c.created_day];

  // ---------------- 1 · cluster table
  const clusters = [...new Set(rows.map(cl))].filter((k) => !SKIP.has(k));
  const cRow = (name) => {
    const rs = rows.filter((x) => cl(x) === name), cur = created(rs, ctx.cur), op = rs.filter(isOpen);
    const trueC = cur.filter((x) => x[c.true_esc]), opTrue = op.filter((x) => x[c.true_esc]), opL3 = op.filter((x) => L3PLUS.has(lvl(x)));
    const late = limit == null ? [] : op.filter((x) => ageOf(x) > limit), o15 = op.filter((x) => ageOf(x) > 15);
    return { name, cur, nT: cur.length, lm: created(rs, ctx.prevSame).length, trueC, nE: trueC.length, op, nO: op.length, opTrue, nOE: opTrue.length, opL3, nL3: opL3.length, late, nLate: late.length, o15, n15: o15.length,
      p50: tatSummary(closedTat(rs, ctx.cur)).p50 };
  };
  const cRows = clusters.map(cRow).filter((r) => r.nT || r.nO);
  const cols = [
    { key: "name", label: "Cluster" },
    { key: "nT", label: "Tickets MTD", num: true, tip: "All levels, created this month", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.cur, `${r.name} · tickets ${ctx.curText}`)) },
    { key: "dl", label: "vs LMTD", num: true, tip: "Fewer is better", fmt: (v, r) => { const d = M.delta(r.nT, r.lm, "count", "down"); return d ? el("span", { class: `delta ${d.tone}`, "data-tip": `LMTD ${fmtInt(r.lm)}`, text: `${d.arrow} ${d.text}` }) : "–"; } },
    { key: "nE", label: "True escalations MTD", num: true, tip: "L2–L5 + Red Alert, created this month", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.trueC, `${r.name} · true escalations ${ctx.curText}`)) },
    { key: "nO", label: "Open", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.op, `${r.name} · open tickets`)) },
    { key: "nOE", label: "Open true", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.opTrue, `${r.name} · open true escalations`)) },
    { key: "nL3", label: "Open L3–L5", num: true, tip: "Founders, social media, consumer forum", fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.opL3, `${r.name} · open L3–L5`)) },
    { key: "nLate", label: `Open past ${R}`, num: true, tip: `Open longer than the closure ${R} (${limit == null ? "–" : Math.round(limit)} days, India, last 6 full months)`, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.late, `${r.name} · open past ${R}`)) },
    { key: "n15", label: "Open > 15 days", num: true, fmt: (v, r) => (r.footer ? fmtInt(v) : btn(r.o15, `${r.name} · open more than 15 days`)) },
    { key: "p50", label: "Closure P50", num: true, tip: "Tickets closed this month: closed − created", fmt: dTxt },
  ];
  const totalOf = (rs, name) => {
    const names = new Set(rs.map((r) => r.name)), sub = rows.filter((x) => names.has(cl(x))), s = (k) => rs.reduce((a, r) => a + r[k], 0);
    return { footer: true, name, nT: s("nT"), lm: s("lm"), nE: s("nE"), nO: s("nO"), nOE: s("nOE"), nL3: s("nL3"), nLate: s("nLate"), n15: s("n15"), p50: tatSummary(closedTat(sub, ctx.cur)).p50 };
  };
  const sumParts = (t) => [el("span", {}, ["Tickets ", el("b", { text: fmtInt(t.nT) })]), el("span", {}, ["True ", el("b", { text: fmtInt(t.nE) })]), el("span", {}, ["Open ", el("b", { text: fmtInt(t.nO) })]), el("span", {}, [`Past ${R} `, el("b", { text: fmtInt(t.nLate) })])];
  const allT = totalOf(cRows, "All clusters");
  const dAll = M.delta(allT.nT, allT.lm, "count", "down");
  main.append(block(1, "Escalations by cluster", `${ctx.curText} · ${ctx.curRange} · open tickets live · click a count for its tickets`,
    el("div", { class: "count", style: { margin: "0 0 8px" }, text: `All clusters: ${fmtInt(allT.nT)} tickets${dAll ? ` (${dAll.arrow} ${dAll.text} vs LMTD ${fmtInt(allT.lm)})` : ""} · ${fmtInt(allT.nE)} true escalations · ${fmtInt(allT.nO)} open (${fmtInt(allT.nOE)} true, ${fmtInt(allT.nL3)} L3–L5) · ${fmtInt(allT.nLate)} open past ${R} (${limit == null ? "–" : Math.round(limit)} d) · closure P50 ${dTxt(allT.p50)}` }),
    tierTable({ rows: cRows, cols, totalOf, sumParts, tier: state.tier, onTier: (v) => setState({ tier: v }), sortKey: "nO", sortDir: -1 })));

  // ---------------- 2 · trend: raised vs closed
  const grain = ["mom", "wow", "dod"].includes(state.escGrain) ? state.escGrain : "wow";
  const rDay = new Map(), cDay = new Map();
  for (const x of rows) { if (x[c.created_day] != null) rDay.set(x[c.created_day], (rDay.get(x[c.created_day]) || 0) + 1); if (x[c.closed_day] != null) cDay.set(x[c.closed_day], (cDay.get(x[c.closed_day]) || 0) + 1); }
  const labels = [], rs = [], cs = [];
  const addRange = (lbl, a, b) => { let n = 0, m = 0; for (let d = a; d <= b; d++) { n += rDay.get(d) || 0; m += cDay.get(d) || 0; } labels.push(lbl); rs.push(n); cs.push(m); };
  if (grain === "dod") for (let d = last - (daySpanOf(state) - 1); d <= last; d++) addRange(fmtDay(d).slice(0, 6), d, d);
  else if (grain === "wow") for (let w = 11; w >= 0; w--) { const b = last - 7 * w, a = b - 6; addRange(`${fmtDay(a).slice(0, 6)}–${fmtDay(b).slice(0, 6)}`, a, b); }
  else for (const k of monthsBetween(data.meta.windows.YTD[0], last)) { const [a, b] = monthBounds(k); addRange(monthLabel(k) + (b > last ? " (MTD)" : ""), a, Math.min(b, last)); }
  main.append(block(2, "Raised vs closed over time", "Bars = tickets raised, dashed line = tickets closed · when the line sits below the bars, the open pile grows",
    box([el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["mom", "Month on month"], ["wow", "Week on week"], ["dod", "Day on day"]], grain, (v) => setState({ escGrain: v }), "Grain"), grain === "dod" ? daySpanSwitch(state, setState) : null]),
      comboChart(labels, { label: "Raised", data: rs, color: "--series-1" }, { label: "Closed", data: cs, color: "--series-2" }, { yFormat: (v) => fmtInt(v), height: 290 })])));

  // ---------------- 3 · split: level or issue type (tickets created this month)
  const by = state.escSplit === "issue" ? "issue" : "level";
  const catOf0 = (x) => (by === "level" ? lvl(x) : label(f, "issue_type", x[c.issue_type])) || "–";
  const month = created(rows, ctx.cur);
  const counts = new Map(); for (const x of month) counts.set(catOf0(x), (counts.get(catOf0(x)) || 0) + 1);
  const cats = by === "level" ? f.levels.filter((l) => counts.has(l)) : [...[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k]) => k), ...(counts.size > 7 ? ["Other"] : [])];
  const catOf = (x) => (cats.includes(catOf0(x)) ? catOf0(x) : "Other");
  const sRow = (name, xs) => { const r = { name, n: xs.length, by: {} }; for (const k of cats) { r.by[k] = xs.filter((x) => catOf(x) === k); r[`c_${k}`] = r.by[k].length; } return r; };
  const sRows = clusters.map((n) => sRow(n, month.filter((x) => cl(x) === n))).filter((r) => r.n);
  const sTot = { ...sRow("All clusters", month), footer: true };
  const sCell = (k) => (v, r) => { const xs = r.by[k]; if (!xs.length) return el("span", { class: "count", text: "·" }); return el("span", { class: "split-cell" }, [r.footer ? fmtInt(xs.length) : btn(xs, `${r.name} · ${k}`), el("small", { text: pctTxt(pct(xs.length, r.n)) })]); };
  main.append(block(3, "What the tickets are", `${fmtInt(month.length)} tickets created in ${ctx.curText} · count and share of the cluster's tickets`,
    box([el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["level", "Level"], ["issue", "Issue type"]], by, (v) => setState({ escSplit: v }), "Split")]),
      dataTable([{ key: "name", label: "Cluster" }, { key: "n", label: "Tickets", num: true, fmt: fmtInt }, ...cats.map((k) => ({ key: `c_${k}`, label: k, num: true, fmt: sCell(k) }))], sRows, { sortKey: "n", sortDir: -1, maxHeight: 480, footer: sTot })])));

  // ---------------- 4 · open tickets by days open
  const buckets = f.aging_buckets, bl = buckets.map((b) => b[2]);
  const open = rows.filter(isOpen);
  const levels = f.levels.filter((l) => open.some((x) => lvl(x) === l));
  const aRows = levels.map((l) => { const xs = open.filter((x) => lvl(x) === l), r = { name: l, n: xs.length, by: {} }; for (const b of bl) { r.by[b] = xs.filter((x) => bucketOf(ageOf(x), buckets) === b); r[`b_${b}`] = r.by[b].length; } return r; });
  const aTot = { footer: true, name: "All levels", n: open.length, by: {} }; for (const b of bl) { aTot.by[b] = open.filter((x) => bucketOf(ageOf(x), buckets) === b); aTot[`b_${b}`] = aTot.by[b].length; }
  const aCell = (b) => (v, r) => { const xs = r.by[b]; if (!xs.length) return el("span", { class: "count", text: "·" }); return r.footer ? fmtInt(xs.length) : btn(xs, `${r.name} · open ${b}`); };
  main.append(block(4, "Open tickets: how long open", `${fmtInt(open.length)} open · live · buckets as the CX ticket report (Q-1767)`,
    box(dataTable([{ key: "name", label: "Level" }, { key: "n", label: "Open", num: true, fmt: fmtInt }, ...bl.map((b) => ({ key: `b_${b}`, label: b, num: true, fmt: aCell(b) }))], aRows, { maxHeight: 380, footer: aTot }))));

  // ---------------- 5 · open ticket list
  main.append(block(5, "Open tickets: list", `${fmtInt(open.length)} tickets · oldest first · ticket id and SSE ID only (no customer names or subjects)`,
    box(projectList(list.cols, [...open].sort((a, b) => a[c.created_day] - b[c.created_day]).map(list.row), { searchKeys: list.cols.filter((x) => !x.num).map((x) => x.key), sortKey: "created", sortDir: 1, filename: "open_escalations.csv", noun: "tickets" }))));

  // ---------------- 6 · month on month
  const metrics = [
    { id: "raised", label: "Tickets raised", src: "e", kind: "count", good: "down", value: (rs2, r) => created(rs2, r).length, pick: created },
    { id: "trueEsc", label: "True escalations (L2–L5 + Red Alert)", src: "e", kind: "count", good: "down", minBase: 3, value: (rs2, r) => created(rs2, r).filter((x) => x[c.true_esc]).length },
    { id: "l3plus", label: "L3–L5 (Founders, Social, Forum)", src: "e", kind: "count", good: "down", minBase: 3, value: (rs2, r) => created(rs2, r).filter((x) => L3PLUS.has(lvl(x))).length },
    { id: "tat50", label: "Closure TAT P50", src: "e", kind: "days", good: "down", value: (rs2, r) => tatSummary(closedTat(rs2, r)).p50, base: (rs2, r) => closedTat(rs2, r).length },
    { id: "tat90", label: "Closure TAT P90", src: "e", kind: "days", good: "down", value: (rs2, r) => tatSummary(closedTat(rs2, r)).p90, base: (rs2, r) => closedTat(rs2, r).length },
  ];
  main.append(block(6, "Month on month", "Tickets by month of creation · TAT by month of closing · month to date and full months", momTables(metrics, ctx, { e: { file: f, ci: c, rows, list } })));
}
