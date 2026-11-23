// TAT / SLA breach V3 (D-113): "Which stages run past their benchmark, and where?"
// Five stages (D-100): design approval, permit, EMI / NBFC, installation, commissioning. Benchmark per stage = P50 / P75 / P90 of
// stages completed in the last 6 full months, ALL India (D-107: the same yardstick whatever the filters). An open project is
// "late" when its days in stage pass the stage's limit by the global stuck rule (India P90, or 2 x India P50; D-111).
//  1. Stages (India benchmarks) and clusters (BAU / Expansion folds): late per stage.  2. Trend: stage P50 by month / week.
//  3. Split: stage x lane.  4. Days in stage.  5. Open project-stages list.  6. Month on month (stage P50 / P75 / P90).
import { el, dataTable, segmented, projectList } from "../ui.js";
import { label, fmtDay, monthBounds, monthLabel, monthsBetween } from "../data.js";
import { fmtInt, pct, tatSummary, percentile } from "../stats.js";
import * as M from "../metrics.js";
import { momTables, block, tierTable, openList } from "../layout.js";
import { lineChart } from "../charts.js";

const AGE = [[0, 1, "0–1 d"], [2, 4, "2–4 d"], [5, 7, "5–7 d"], [8, 15, "8–15 d"], [16, 30, "16–30 d"], [31, null, "30+ d"]];
const BUCKETS = ["On track", "Past P50", "Past P75", "Past P90"];
const SKIP = new Set(["", "—", "Not mapped", "No cell", "Unknown"]);
const box = (kids) => el("div", { class: "card" }, kids);
const pctTxt = (p) => (p == null ? "–" : `${Math.round(p)}%`);
const dTxt = (v) => (v == null ? "–" : `${Math.round(v)} d`);
const tone = (p) => (p == null ? "flat" : p > 25 ? "bad" : p > 10 ? "warn" : "good");  // share late: red above 25%, amber above 10%

export function render(main, { data, state, setState, ctx }) {
  const f1 = data.p1, c1 = f1.ci, p1 = f1.pci, f2 = data.p2, c2 = f2.ci, p2 = f2.pci, asOf = data.meta.as_of_day, last = ctx.last;
  const p1r = M.p1Rows(data, state), p2r = M.p2Rows(data, state), R = M.stuckShort(ctx);
  const holdOn = !!state.stageHold;
  const okState = (s) => s === "active" || (holdOn && s === "on-hold");
  const raw = { ...state, hideCancelled: false };
  const pipe = M.p1Pending(data, raw).filter((x) => okState(label(f1, "state", x[p1.state])));
  const pend = M.p2Pending(data, raw).filter((x) => okState(label(f2, "state", x[p2.state])));
  const inR = M.inRange, nbfc = (file, ci, x) => label(file, "payment_lane", x[ci.payment_lane]) === "NBFC";
  const payDay = (x) => { const d = x[c1.F03]; return d != null && d >= 0 ? x[c1.hoto_day] + d : null; };

  // ---------------- the five stages
  const STAGES = [
    { id: "design", name: "Design approval", span: "HOTO → customer design approval (020)", src: "p1",
      done: (rs, r) => rs.filter((x) => x[c1.cx_design_day] != null && inR(x[c1.cx_design_day], r) && x[c1.cx_design_day] >= x[c1.hoto_day]).map((x) => x[c1.cx_design_day] - x[c1.hoto_day]),
      open: () => pipe.filter((x) => x[p1.E_CX_DESIGN] == null).map((x) => ({ x, src: "p1", days: x[p1.days_since_hoto] })) },
    { id: "permit", name: "Permit approval", span: "Design approval → sanction letter", src: "p1",
      done: (rs, r) => rs.filter((x) => x[c1.sanction_day] != null && x[c1.cx_design_day] != null && inR(x[c1.sanction_day], r) && x[c1.sanction_day] >= x[c1.cx_design_day]).map((x) => x[c1.sanction_day] - x[c1.cx_design_day]),
      open: () => pipe.filter((x) => x[p1.E_CX_DESIGN] != null && x[p1.E_SANCTION] == null).map((x) => ({ x, src: "p1", days: asOf - x[p1.E_CX_DESIGN] })) },
    { id: "nbfc", name: "EMI / NBFC", span: "NBFC lane: HOTO → payment ready (lender RFD, else E004A)", src: "p1",
      done: (rs, r) => rs.filter((x) => nbfc(f1, c1, x) && inR(payDay(x), r)).map((x) => payDay(x) - x[c1.hoto_day]),
      open: () => pipe.filter((x) => nbfc(f1, p1, x) && x[p1.E_P1_COLLECTED] == null).map((x) => ({ x, src: "p1", days: x[p1.days_since_hoto] })) },
    { id: "install", name: "Installation", span: "HOTO → installed (039B)", src: "p2",
      done: (rs, r) => rs.filter((x) => inR(x[c2.installed_day], r) && x[c2.hoto_day] != null && x[c2.installed_day] >= x[c2.hoto_day]).map((x) => x[c2.installed_day] - x[c2.hoto_day]),
      open: () => pipe.map((x) => ({ x, src: "p1", days: x[p1.days_since_hoto] })) },
    { id: "comm", name: "Commissioning", span: "Installed → commissioned", src: "p2",
      done: (rs, r) => rs.filter((x) => inR(x[c2.commissioned_day], r) && x[c2.tat_days] != null).map((x) => x[c2.tat_days]),
      open: () => pend.map((x) => ({ x, src: "p2", days: x[p2.aging_days] })) },
  ];
  const win = [ctx.cols.at(0).range[0], ctx.cols.at(-1).range[1]];
  const allRows = { p1: f1.facts, p2: f2.facts };  // India-wide benchmarks
  for (const s of STAGES) {
    const t = s.done(allRows[s.src], win);
    s.bench = t.length >= 30 ? { p50: percentile(t, 0.5), p75: percentile(t, 0.75), p90: percentile(t, 0.9), n: t.length } : null;
    s.limit = M.stuckLimit(t, ctx);
    s.items = s.open().filter((o) => o.days != null).map((o) => ({ ...o, bucket: !s.bench ? null : o.days > s.bench.p90 ? 3 : o.days > s.bench.p75 ? 2 : o.days > s.bench.p50 ? 1 : 0, late: s.limit != null && o.days > s.limit }));
    s.lateItems = s.items.filter((o) => o.late);
    s.past50 = s.items.filter((o) => o.bucket >= 1).length;
  }
  const dimOf = (o, k) => (o.src === "p1" ? label(f1, k, o.x[p1[k]]) : label(f2, k, o.x[p2[k]]));
  const listCols = [{ key: "sseid", label: "SSE ID" }, { key: "cluster", label: "Cluster" }, { key: "cell", label: "Cell" }, { key: "lane", label: "Lane" }, { key: "com", label: "COM" }, { key: "zoh", label: "ZOH" },
    { key: "stage", label: "Stage" }, { key: "days", label: "Days in stage", num: true }, { key: "limit", label: `Limit (${R})`, num: true }, { key: "late", label: "Late" }, { key: "bucket", label: "Bucket" }, { key: "state", label: "State" }];
  const listRow = (s) => (o) => ({ sseid: o.x[o.src === "p1" ? p1.sseid : p2.sseid], cluster: dimOf(o, "cluster"), cell: dimOf(o, "cell"), lane: dimOf(o, "lane"), com: dimOf(o, "com"), zoh: dimOf(o, "zoh"),
    stage: s.name, days: o.days, limit: s.limit == null ? null : Math.round(s.limit), late: o.late ? "Late" : "", bucket: o.bucket == null ? "–" : BUCKETS[o.bucket], state: dimOf(o, "state") });
  const openFor = (s, items, title) => openList({ title, sub: `${fmtInt(items.length)} projects · ${s.span} · limit ${dTxt(s.limit)} (${R})`, cols: listCols, rows: [...items].sort((a, b) => b.days - a.days).map(listRow(s)), filename: `tat_${s.id}.csv` });
  const btn = (n, onClick) => (n ? el("button", { type: "button", class: "link-btn", text: fmtInt(n), onclick: (e) => { e.stopPropagation(); onClick(); } }) : el("span", { class: "count", text: "0" }));

  // ---------------- 1 · stages (India) and clusters
  const stageRows = STAGES.map((s) => ({ s, name: s.name, span: s.span, b50: s.bench?.p50, b75: s.bench?.p75, b90: s.bench?.p90, limit: s.limit, open: s.items.length, past50: s.past50, nLate: s.lateItems.length,
    q50: pct(s.past50, s.items.length), qLate: pct(s.lateItems.length, s.items.length) }));
  const stageTable = dataTable([
    { key: "name", label: "Stage", fmt: (v, r) => el("span", { text: v, "data-tip": r.span }) },
    { key: "b50", label: "P50", num: true, tip: "India, stages completed in the last 6 full months", fmt: dTxt }, { key: "b75", label: "P75", num: true, fmt: dTxt }, { key: "b90", label: "P90", num: true, fmt: dTxt },
    { key: "limit", label: `Limit (${R})`, num: true, tip: "The stuck rule in the top bar", fmt: dTxt },
    { key: "open", label: "Open", num: true, fmt: (v, r) => btn(v, () => openFor(r.s, r.s.items, `${r.name}: open`)) },
    { key: "q50", label: "Past P50", num: true, fmt: (v) => pctTxt(v) },
    { key: "nLate", label: "Late", num: true, fmt: (v, r) => btn(v, () => openFor(r.s, r.s.lateItems, `${r.name}: past ${R}`)) },
    { key: "qLate", label: "Share late", num: true, fmt: (v) => el("span", { class: `pill ${tone(v)}`, text: pctTxt(v) }) },
  ], stageRows, { maxHeight: 320 });
  // per cluster: late per stage (count, share of that cluster's open in the stage)
  const groups = new Map();
  for (const s of STAGES) for (const o of s.items) {
    const g = dimOf(o, "cluster"); if (SKIP.has(g)) continue;
    if (!groups.has(g)) groups.set(g, { name: g, open: 0, late: 0, by: {} });
    const r = groups.get(g); r.open += 1; if (o.late) r.late += 1;
    (r.by[s.id] ||= { open: [], late: [] }).open.push(o); if (o.late) r.by[s.id].late.push(o);
  }
  const gRows = [...groups.values()];
  gRows.forEach((r) => STAGES.forEach((s) => { r[`l_${s.id}`] = r.by[s.id] ? r.by[s.id].late.length : 0; }));
  const lateCell = (s) => (v, r) => {
    const b = r.by[s.id]; if (!b || !b.open.length) return el("span", { class: "count", text: "·" });
    const p = pct(b.late.length, b.open.length);
    return el("span", { class: "split-cell", "data-tip": `${r.name} · ${s.name}: ${b.late.length} of ${b.open.length} open past ${R}` }, [
      r.footer ? fmtInt(b.late.length) : btn(b.late.length, () => openFor(s, b.late, `${r.name} · ${s.name}: past ${R}`)), b.open.length >= 10 ? el("small", { class: `t-${tone(p)}`, text: pctTxt(p) }) : null]);
  };
  const cols = [{ key: "name", label: "Cluster" }, { key: "open", label: "Open (project-stages)", num: true, fmt: fmtInt },
    ...STAGES.map((s) => ({ key: `l_${s.id}`, label: `${s.name} late`, num: true, fmt: lateCell(s) })), { key: "late", label: "Late, all stages", num: true, fmt: fmtInt }];
  const totalOf = (rs, name) => { const t = { footer: true, name, open: 0, late: 0, by: {} }; for (const r of rs) { t.open += r.open; t.late += r.late; for (const s of STAGES) { const b = r.by[s.id]; if (!b) continue; (t.by[s.id] ||= { open: [], late: [] }).open.push(...b.open); t.by[s.id].late.push(...b.late); } } STAGES.forEach((s) => { t[`l_${s.id}`] = t.by[s.id] ? t.by[s.id].late.length : 0; }); return t; };
  const sumParts = (t) => [el("span", {}, ["Open ", el("b", { text: fmtInt(t.open) })]), el("span", {}, ["Late ", el("b", { text: fmtInt(t.late) })]), el("span", { class: `pill ${tone(pct(t.late, t.open))}`, text: `${pctTxt(pct(t.late, t.open))} late` })];
  main.append(block(1, "Breach by stage and cluster", `Open projects (${holdOn ? "active + on-hold" : "active"}) · benchmarks India, stages completed ${fmtDay(win[0])} – ${fmtDay(win[1])} · late = past the limit (${R}, top bar) · a project waiting for several stages counts in each`,
    el("div", { class: "card-actions", style: { marginBottom: "10px", justifyContent: "flex-start" } }, [segmented([["active", "Active"], ["hold", "Active + on-hold"]], holdOn ? "hold" : "active", (v) => setState({ stageHold: v === "hold" }), "Projects")]),
    box([el("div", { class: "card-sub", style: { margin: "0 0 8px" }, text: "India: stage benchmarks and open projects" }), stageTable]),
    el("div", { style: { height: "10px" } }),
    tierTable({ rows: gRows, cols, totalOf, sumParts, tier: state.tier, onTier: (v) => setState({ tier: v }), sortKey: "late", sortDir: -1 })));

  // ---------------- 2 · trend: stage P50 by month / week (completed stages, page filters)
  const grain = state.tatGrain === "wow" ? "wow" : "mom";
  const rowsOf = { p1: p1r, p2: p2r };
  const periods = [];
  if (grain === "wow") for (let w = 11; w >= 0; w--) { const b = last - 7 * w, a = b - 6; periods.push([`${fmtDay(a).slice(0, 6)}–${fmtDay(b).slice(0, 6)}`, [a, b]]); }
  else for (const k of monthsBetween(data.meta.windows.YTD[0], last)) { const [a, b] = monthBounds(k); periods.push([monthLabel(k) + (b > last ? " (MTD)" : ""), [a, Math.min(b, last)]]); }
  const colors = ["--series-1", "--series-2", "--series-3", "--g-now", "--warning"];
  main.append(block(2, "Stage TAT over time", "P50 days of stages completed in each period (blank when fewer than 20) · lower is better",
    box([el("div", { class: "card-actions", style: { marginBottom: "8px", justifyContent: "flex-start" } }, [segmented([["mom", "Month on month"], ["wow", "Week on week"]], grain, (v) => setState({ tatGrain: v }), "Grain")]),
      lineChart(periods.map((p) => p[0]), STAGES.map((s, i) => ({ label: s.name, color: colors[i], data: periods.map(([, r]) => { const t = s.done(rowsOf[s.src], r); return t.length >= 20 ? tatSummary(t).p50 : null; }) })), { yFormat: (v) => `${v} d`, height: 300 })])));

  // ---------------- 3 · split: stage x lane
  const lanes = (data.meta.lanes || []).slice();
  const laneRows = STAGES.map((s) => { const r = { s, name: s.name, by: {} }; for (const ln of lanes) { const xs = s.items.filter((o) => dimOf(o, "lane") === ln); r.by[ln] = { open: xs, late: xs.filter((o) => o.late) }; r[ln] = pct(r.by[ln].late.length, xs.length); } return r; });
  const laneCell = (ln) => (v, r) => { const b = r.by[ln]; if (!b.open.length) return el("span", { class: "count", text: "·" });
    return el("span", { class: "split-cell", "data-tip": `${r.name} · ${ln}: ${b.late.length} of ${b.open.length} open past ${R}` }, [btn(b.late.length, () => openFor(r.s, b.late, `${r.name} · ${ln}: past ${R}`)),
      b.open.length >= 10 ? el("small", { class: `t-${tone(v)}`, text: pctTxt(v) }) : el("small", { text: `of ${b.open.length}` })]); };
  main.append(block(3, "Breach by lane", `Late projects per stage and lane, with the share of that lane's open projects (shown where 10+ are open) · late = past ${R}`,
    box(dataTable([{ key: "name", label: "Stage" }, ...lanes.map((ln) => ({ key: ln, label: ln, num: true, fmt: laneCell(ln) }))], laneRows, { maxHeight: 320 }))));

  // ---------------- 4 · days in stage
  const ageRows = STAGES.map((s) => { const r = { s, name: s.name, n: s.items.length, by: {} }; AGE.forEach(([lo, hi, lb]) => { r.by[lb] = s.items.filter((o) => o.days >= lo && (hi == null || o.days <= hi)); r[lb] = r.by[lb].length; }); return r; });
  const ageCell = (lb) => (v, r) => { const xs = r.by[lb]; if (!xs.length) return el("span", { class: "count", text: "·" });
    return el("span", { class: "split-cell" }, [btn(xs.length, () => openFor(r.s, xs, `${r.name}: ${lb} in stage`)), el("small", { text: pctTxt(pct(xs.length, r.n)) })]); };
  main.append(block(4, "How long they have been in their stage", `Open projects (${holdOn ? "active + on-hold" : "active"}) by days in the current stage`,
    box(dataTable([{ key: "name", label: "Stage" }, { key: "n", label: "Open", num: true, fmt: fmtInt }, ...AGE.map(([, , lb]) => ({ key: lb, label: lb, num: true, fmt: ageCell(lb) }))], ageRows, { maxHeight: 320 }))));

  // ---------------- 5 · open project-stages list
  const all = STAGES.flatMap((s) => s.items.map(listRow(s)));
  main.append(block(5, "Open projects by stage: list", `${fmtInt(all.length)} project-stages · a project waiting for design, permit and payment shows once per stage`,
    box(projectList(listCols, all, { searchKeys: ["sseid", "cluster", "cell", "stage", "com", "late"], sortKey: "days", sortDir: -1, filename: "tat_sla_open.csv" }))));

  // ---------------- 6 · month on month
  const metrics = [];
  for (const s of STAGES) {
    const q = (k) => (rs, r) => tatSummary(s.done(rs, r))[k];
    metrics.push({ id: s.id, label: `${s.name} P50`, src: s.src, kind: "days", good: "down", value: q("p50"), base: (rs, r) => s.done(rs, r).length });
    metrics.push({ id: `${s.id}75`, label: `${s.name} P75`, src: s.src, kind: "days", good: "down", value: q("p75"), base: (rs, r) => s.done(rs, r).length });
    metrics.push({ id: `${s.id}90`, label: `${s.name} P90`, src: s.src, kind: "days", good: "down", value: q("p90"), base: (rs, r) => s.done(rs, r).length });
  }
  main.append(block(6, "Month on month", "Stage TAT P50 / P75 / P90 by month of completion · month to date and full months",
    momTables(metrics, ctx, { p1: { file: f1, ci: c1, rows: p1r }, p2: { file: f2, ci: c2, rows: p2r } }, { state, setState })));
}
