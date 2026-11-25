// Month-based page layout (D-81), shared by every page:
//   1. this month at a glance (MTD vs same days last month, and last month's full total)
//   2. month-on-month table (6 full months + this month + same days last month + change)
//   3. leaderboard / laggerboard by City / COM / SOH / ZOH for one chosen metric
//   4. full ranking table for that level (all rows, sortable, CSV)
//   5. details, folded away
// A page declares its metrics once; all blocks read the same definitions, so numbers can't disagree between blocks.
//
// Metric: { id, label, src, kind: 'count'|'pct'|'days'|'now', good: 'up'|'down',
//           value(rows, range) -> number|null, base?(rows, range) -> sample size, minBase?, kpi?, mom?, rank?, foot? }
// Sources: { [src]: { file, ci, rows } }  (rows already filtered by the global filters)
import { el, card, segmented, metricCard, dataTable, downloadCSV, projectList } from "./ui.js";
import { monthKey, monthLabel, monthBounds, shiftMonth, fmtDay, label, isExpansion, matcher } from "./data.js";
import { delta } from "./metrics.js";
import { fmtInt, fmtPct } from "./stats.js";

export const LEVELS = [["cluster", "Cluster"], ["com", "COM"], ["soh", "SOH"], ["zoh", "ZOH"]];  // D-86: cluster, not city
const SKIP = new Set(["", "—", "Not mapped", "No cell", "Unknown"]);
const MOM_MONTHS = 6;

export const fmtD = (v) => (v == null ? "–" : (Number.isInteger(v) ? String(v) : v.toFixed(1)));
export function fmtKind(kind, v) {
  if (v == null || Number.isNaN(v)) return "–";
  if (kind === "pct") return fmtPct(v);
  if (kind === "days") return `${fmtD(v)} d`;
  if (kind === "num") return v.toFixed(2);  // D-124: e.g. calls per order
  return fmtInt(v);
}
const deltaKind = (kind) => (kind === "pct" ? "pct" : kind === "days" ? "days" : "count");
const GROUP = { count: "--g-volume", days: "--g-speed", pct: "--g-quality", now: "--g-now" };

// ---------------------------------------------------------------- month context
export function monthOptions(meta) {
  const out = [];
  let k = monthKey(meta.as_of_day);
  const first = monthKey(meta.trend_from_day);
  while (k >= first) { out.push(k); k = shiftMonth(k, -1); }
  return out;
}

/** The month a visit opens on: the month of the last complete day (D-97). */
export const defaultMonth = (meta) => monthKey(meta.as_of_day - 1);

// D-97: month to date runs to YESTERDAY (complete days); today's partial day is shown apart (ctx.today).
export function monthContext(meta, key) {
  const asOf = meta.as_of_day, last = asOf - 1;
  const [a, b] = monthBounds(key);
  const live = key === monthKey(last) && last < b;
  const prevKey = shiftMonth(key, -1), [pa, pb] = monthBounds(prevKey);
  const span = live ? last - a : b - a;                       // days after the 1st that count
  const cur = [a, live ? last : b];
  const prevSame = live ? [pa, Math.min(pa + span, pb)] : [pa, pb];
  const cols = [], mtdCols = [];
  for (let i = MOM_MONTHS; i >= 1; i--) {
    const k = shiftMonth(key, -i), r = monthBounds(k);
    cols.push({ key: k, label: monthLabel(k), range: r });
    mtdCols.push({ key: k, label: monthLabel(k), range: [r[0], Math.min(r[0] + span, r[1])] });
  }
  const dayN = span + 1, days = b - a + 1;
  const rangeText = (r) => `${fmtDay(r[0])} – ${fmtDay(r[1])}`;
  return {
    key, live, cur, prevSame, prevFull: [pa, pb], prevKey, cols, mtdCols, asOf, last, today: [asOf, asOf],
    label: monthLabel(key), prevLabel: monthLabel(prevKey), dayN, days,
    curText: live ? `${monthLabel(key)} MTD` : monthLabel(key),
    prevText: live ? `${monthLabel(prevKey)} MTD` : monthLabel(prevKey),
    curRange: rangeText(cur), prevRange: rangeText(prevSame),
    sub: live ? `${monthLabel(key)} · ${rangeText(cur)} (day ${dayN} of ${days}, complete days) · vs ${rangeText(prevSame)} · today counted apart`
              : `${monthLabel(key)} · full month · vs ${monthLabel(prevKey)}`,
  };
}

const val = (m, src, range) => m.value(src.rows, range);
const projected = (m, v, ctx) => (m.kind === "count" && ctx.live && v != null ? Math.round((v / ctx.dayN) * ctx.days) : v);

// ---------------------------------------------------------------- tooltips + project-list drawer (D-94)
let tipEl = null;
/** Every element with data-tip shows that text on hover / focus (multi-line with \n). */
export function initTooltips() {
  if (tipEl) return;
  tipEl = el("div", { class: "tip", role: "tooltip", hidden: true });
  document.body.append(tipEl);
  const show = (e) => {
    const t = e.target.closest ? e.target.closest("[data-tip]") : null;
    if (!t) { tipEl.hidden = true; return; }
    tipEl.textContent = t.getAttribute("data-tip");
    tipEl.hidden = false;
    const r = t.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let x = r.left + r.width / 2 - w / 2, y = r.top - h - 8;
    if (y < 8) y = r.bottom + 8;
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    tipEl.style.left = `${x}px`; tipEl.style.top = `${y}px`;
  };
  document.addEventListener("mouseover", show);
  document.addEventListener("focusin", show);
  document.addEventListener("scroll", () => { tipEl.hidden = true; }, true);
}

let listEl = null;
/** Opens the side drawer with the projects behind a number: {title, sub, cols, rows, filename}. */
function ensureListEl() {
  if (!listEl) {
    listEl = el("aside", { class: "drawer list-drawer", "aria-hidden": "true" });
    const scrim = el("div", { class: "scrim list-scrim", hidden: true, onclick: () => closeList() });
    document.body.append(scrim, listEl);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeList(); });
  }
}
function showDrawer(title, sub, body, back) {
  ensureListEl();
  listEl.replaceChildren(
    el("div", { class: "drawer-head" }, [
      back ? el("button", { class: "small-btn back-btn", type: "button", text: "← Back", onclick: back }) : null,
      el("div", { style: { flex: "1", minWidth: "0" } }, [el("h2", { text: title }), sub ? el("div", { class: "card-sub", text: sub }) : null]),
      el("button", { class: "icon-btn", type: "button", "aria-label": "Close", text: "✕", onclick: () => closeList() })]),
    el("div", { class: "drawer-body" }, body),
  );
  listEl.classList.add("open"); listEl.setAttribute("aria-hidden", "false");
  document.querySelector(".list-scrim").hidden = false;
  listEl.querySelector(".drawer-body").scrollTop = 0;
}
/** A project list in the side drawer. `back` (optional) adds a Back button, e.g. to return to a cluster panel. */
export function openList({ title, sub, cols, rows, filename, noun, back }) {
  const numCol = cols.find((c) => c.num);
  showDrawer(title, sub, projectList(cols, rows, { searchKeys: cols.filter((c) => !c.num).map((c) => c.key), sortKey: numCol ? numCol.key : null, sortDir: -1,
    filename: filename || "projects.csv", noun: noun || (cols.some((c) => c.key === "sseid") ? "projects" : "rows") }), back);
}
/** Any content in the same side drawer (cluster panel, D-107). */
export function openPanel({ title, sub, body }) { showDrawer(title, sub, body, null); }
function closeList() {
  if (!listEl) return;
  listEl.classList.remove("open"); listEl.setAttribute("aria-hidden", "true");
  document.querySelector(".list-scrim").hidden = true;
}

/** Opens the list behind metric m for a range, when the metric can pick its rows and the source can list them. */
export function drill(m, s, range, ctx, title) {
  if (!m.pick || !s.list) return null;
  return () => {
    const rows = m.pick(s.rows, range);
    openList({ title: title || m.label, sub: `${fmtInt(rows.length)} projects${range ? ` · ${fmtDay(range[0])} – ${fmtDay(range[1])}` : " · live"}`,
      cols: s.list.cols, rows: rows.map(s.list.row), filename: `${m.id}_${ctx.key}.csv` });
  };
}

function tipText(m, ctx, s) {
  const lines = [m.label, m.hint || ""];
  if (m.kind === "now") {
    lines.push("Live count, as of the latest refresh.");
    if (m.at) { const w = m.at(s.rows, ctx.asOf - 7); if (w != null) lines.push(`One week ago: ${fmtKind("count", w)}`); }
  } else {
    lines.push(`${ctx.curText} (${ctx.curRange}): ${fmtKind(m.kind, val(m, s, ctx.cur))}`);
    lines.push(`${ctx.live ? "Same days last month" : ctx.prevLabel} (${ctx.prevRange}): ${fmtKind(m.kind, val(m, s, ctx.prevSame))}`);
    if (ctx.live) lines.push(`${ctx.prevLabel} full month: ${fmtKind(m.kind, val(m, s, ctx.prevFull))}`);
    if (ctx.live && m.kind === "count") {
      const full = val(m, s, ctx.prevFull), v = val(m, s, ctx.cur);
      if (full) lines.push(`${Math.round((100 * v) / full)}% of ${ctx.prevLabel}'s full month reached · day ${ctx.dayN} of ${ctx.days} (${Math.round((100 * ctx.dayN) / ctx.days)}% of the month)`);
    }
  }
  if (m.pick && s.list) lines.push("Click the number for the project list.");
  return lines.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------- 1. at a glance
export function glance(metrics, ctx, sources, opts = {}) {
  return el("div", { class: "grid metrics" }, metrics.filter((m) => m.kpi).map((m) => {
    const s = sources[m.src];
    const goTo = opts.links && opts.links[m.id] ? () => { location.hash = opts.links[m.id]; } : null;
    let node;
    if (m.kind === "now") {
      const v = val(m, s, null), w = m.at ? m.at(s.rows, ctx.asOf - 7) : null;
      node = metricCard({ label: m.label, value: fmtKind("count", v), now: true, group: GROUP.now,
        delta: w != null ? delta(v, w, "count", m.good) : null, prevText: w != null ? `one week ago: ${fmtKind("count", w)}` : null,
        foot: m.foot ? m.foot(s.rows) : null });
      wire(node, drill(m, s, null, ctx), goTo);
    } else {
      const v = val(m, s, ctx.cur), p = val(m, s, ctx.prevSame);
      const full = ctx.live ? val(m, s, ctx.prevFull) : null;
      const unit = m.kind === "days" ? "d" : null;
      const shown = m.kind === "days" ? fmtD(v) : fmtKind(m.kind, v);
      node = metricCard({
        label: m.label, value: shown, unit, group: GROUP[m.kind],
        delta: delta(v, p, deltaKind(m.kind), m.good),
        prevText: `${ctx.live ? "same days last month" : ctx.prevLabel}: ${fmtKind(m.kind, p)}`,
        foot: ctx.live ? `${ctx.prevLabel} full month: ${fmtKind(m.kind, full)}` : (m.foot ? m.foot(s.rows) : null),
      });
      wire(node, drill(m, s, ctx.cur, ctx), goTo);
      // merged TAT card: P50 is the headline, P75 / P90 (with their change) on one line underneath
      if (m.also) {
        const items = m.also.map((id) => metrics.find((x) => x.id === id)).filter(Boolean).map((o) => {
          const os = sources[o.src], ov = val(o, os, ctx.cur), op = val(o, os, ctx.prevSame), od = delta(ov, op, deltaKind(o.kind), o.good);
          return el("span", { class: "m-also-item" }, [el("small", { text: o.short || o.label }), fmtKind(o.kind, ov), od ? el("span", { class: `delta ${od.tone}`, text: `${od.arrow} ${od.text}` }) : null]);
        });
        node.querySelector(".m-row").after(el("div", { class: "m-also" }, items));
      }
    }
    let tip = tipText(m, ctx, s);
    if (m.also) tip += "\n" + m.also.map((id) => metrics.find((x) => x.id === id)).filter(Boolean).map((o) => `${o.label}: ${fmtKind(o.kind, val(o, sources[o.src], ctx.cur))} (same days last month ${fmtKind(o.kind, val(o, sources[o.src], ctx.prevSame))})`).join("\n");
    node.setAttribute("data-tip", tip);
    return node;
  }));
}

/** Number opens the project list; the rest of the card goes to the page (Overview). */
export function wire(node, onList, onPage) {
  const v = node.querySelector(".m-value");
  if (onList && v) {
    v.classList.add("clickable"); v.setAttribute("role", "button"); v.setAttribute("tabindex", "0");
    v.addEventListener("click", (e) => { e.stopPropagation(); onList(); });
    v.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.stopPropagation(); onList(); } });
  }
  if (onPage) {
    node.classList.add("linked"); node.setAttribute("role", "link"); node.setAttribute("tabindex", "0");
    node.addEventListener("click", onPage); node.addEventListener("keydown", (e) => { if (e.key === "Enter") onPage(); });
  }
}

// ---------------------------------------------------------------- 2. month on month: MTD table + full-month table (D-94)
// Lane switch above the two tables (D-118): All lanes, or one lane at a time, inside the top bar's filters.
export const LANE_ORDER = ["PSU", "FL Direct", "FL NBFC", "Name change", "LC only", "Phase change"];
/** Lanes present in the sources' rows (top-bar filters already applied) and the sources narrowed to one lane ("all": untouched). */
function laneScope(sources, lane) {
  const present = new Set();
  for (const s of Object.values(sources)) {
    const li = s.ci ? s.ci.lane : null;
    if (li == null) continue;
    const labels = s.file.dims.lane || [], seen = new Set();
    for (const r of s.rows) seen.add(r[li]);
    for (const i of seen) if (labels[i]) present.add(labels[i]);
  }
  const lanes = [...LANE_ORDER.filter((l) => present.has(l)), ...[...present].filter((l) => !LANE_ORDER.includes(l)).sort()];
  const cur = lane && lane !== "all" && lanes.includes(lane) ? lane : "all";
  if (cur === "all") return { lanes, cur, sources };
  const narrowed = {};
  for (const [k, s] of Object.entries(sources)) {
    const keep = s.ci && s.ci.lane != null ? matcher(s.file, { lane: [cur] }, s.ci) : () => true;
    narrowed[k] = { ...s, rows: s.rows.filter(keep) };
  }
  return { lanes, cur, sources: narrowed };
}

/**
 * Month on month: MTD table + full-month table (D-94). opts = { state, setState } adds the lane switch on top (D-118, shared
 * state `momLane`). A rate or TAT cell that rests on fewer than minBase projects (default 20) is greyed, its count in the tooltip.
 */
export function momTables(metrics, ctx, sourcesIn, opts = {}) {
  const rows = metrics.filter((m) => m.kind !== "now" && m.mom !== false);
  const withLane = typeof opts.setState === "function";
  const { lanes, cur: lane, sources } = withLane ? laneScope(sourcesIn, opts.state ? opts.state.momLane : "all") : { lanes: [], cur: "all", sources: sourcesIn };
  const laneNote = lane === "all" ? "" : ` · ${lane} lane only`;
  const cell = (m, s, range, cls = "num") => {
    const v = val(m, s, range);
    const n = v != null && m.base && (m.kind === "pct" || m.kind === "days") ? m.base(s.rows, range) : null;
    const low = n != null && n < (m.minBase ?? 20);
    return el("td", { class: `${cls}${low ? " low-n" : ""}`, text: fmtKind(m.kind, v),
      "data-tip": low ? `Based on only ${fmtInt(n)} project${n === 1 ? "" : "s"}: too few to read much into` : null });
  };
  const out = [];
  if (withLane && lanes.length > 1) {
    out.push(el("div", { class: "mom-lane" }, [
      segmented([["all", "All lanes"], ...lanes.map((l) => [l, l])], lane, (v) => opts.setState({ momLane: v }), "Lane"),
      el("span", { class: "mom-lane-note", text: lane === "all" ? "Pick a lane to see both tables for that lane only" : `Both tables: ${lane} lane only · the rest of the page follows the top bar` }),
    ]));
  }
  if (ctx.live) {
    const head = el("tr", {}, [el("th", { text: "Metric" }), ...ctx.mtdCols.map((c) => el("th", { class: "num", text: c.label, "data-tip": `${fmtDay(c.range[0])} – ${fmtDay(c.range[1])}` })),
      el("th", { class: "num cur", text: ctx.curText, "data-tip": ctx.curRange }), el("th", { class: "num", text: "vs last month" })]);
    const body = rows.map((m) => {
      const s = sources[m.src], v = val(m, s, ctx.cur), p = val(m, s, ctx.mtdCols.at(-1).range), d = delta(v, p, deltaKind(m.kind), m.good);
      return el("tr", {}, [el("td", { text: m.label, "data-tip": m.hint || null }),
        ...ctx.mtdCols.map((c) => cell(m, s, c.range)),
        cell(m, s, ctx.cur, "num cur"),
        el("td", { class: `num ${d ? `tone-${d.tone}` : ""}`, text: d ? `${d.arrow} ${d.text}` : "–" })]);
    });
    out.push(card("Month to date, month on month", `Day 1 – ${ctx.dayN} of each month (complete days) · hover a month for its dates${laneNote}`,
      el("div", { class: "table-wrap" }, el("table", { class: "data mom" }, [el("thead", {}, head), el("tbody", {}, body)]))));
  }
  const curHead = ctx.live ? `${ctx.label} to date` : ctx.label;
  const head = el("tr", {}, [el("th", { text: "Metric" }), ...ctx.cols.map((c) => el("th", { class: "num", text: c.label })),
    el("th", { class: "num cur", text: curHead, "data-tip": ctx.live ? `${ctx.curRange} (complete days)` : null }),
    el("th", { class: "num", text: ctx.live ? `vs ${ctx.prevLabel} full` : `vs ${ctx.prevLabel}`, "data-tip": ctx.live ? "Counts: share of last month's full total reached so far. Rates and TATs: change vs last month's full-month value." : null })]);
  const body = rows.map((m) => {
    const s = sources[m.src], v = val(m, s, ctx.cur), p = val(m, s, ctx.prevFull);
    const share = ctx.live && m.kind === "count";
    const d = share ? null : delta(v, p, deltaKind(m.kind), m.good);
    const changeCell = share
      ? el("td", { class: "num", text: p ? `${Math.round((100 * v) / p)}% of ${ctx.prevLabel}` : "–", "data-tip": `Day ${ctx.dayN} of ${ctx.days} = ${Math.round((100 * ctx.dayN) / ctx.days)}% of the month gone` })
      : el("td", { class: `num ${d ? `tone-${d.tone}` : ""}`, text: d ? `${d.arrow} ${d.text}` : "–" });
    return el("tr", {}, [el("td", { text: m.label, "data-tip": m.hint || null }),
      ...ctx.cols.map((c) => cell(m, s, c.range)),
      cell(m, s, ctx.cur, "num cur"), changeCell]);
  });
  out.push(card("Full month, month on month", (ctx.live ? `Last 6 full months · ${ctx.label} so far, as a share of last month (counts) or vs last month (rates, TATs)` : "Last 6 full months") + laneNote,
    el("div", { class: "table-wrap" }, el("table", { class: "data mom" }, [el("thead", {}, head), el("tbody", {}, body)]))));
  return el("div", { class: "stack" }, out);
}
export const momTable = momTables;  // old name kept for pages not yet moved

// ---------------------------------------------------------------- needs action: exception cards (D-94, D-99)
// defs: [{label, value, valueText?, tone:'bad'|'warn'|'ok', rule, sub?, onClick?}]
/**
 * Needs action (D-94, D-109). With `groups` ([[key, title], ...] in the order to act) the cards are laid out as labelled rows:
 * worst first within a row (red, then amber, keeping the given order), and cards with nothing to do (green) shrink to small
 * 'all clear' chips at the end of their row; a group given as [key, title, { keepOrder: true }] keeps its cards in the given
 * (stage) order. Without `groups`: one grid, as before.
 */
export function exceptions(defs, groups) {
  if (groups && groups.length) {
    const rank = { bad: 0, warn: 1, ok: 2 };
    const toneOf = (d) => d.tone || (d.value ? "bad" : "ok");
    const rows = groups.map(([key, title, opt], i) => {
      const ds = defs.filter((d) => (d.group || groups[0][0]) === key);
      if (!ds.length) return null;
      const act = ds.filter((d) => toneOf(d) !== "ok").map((d, j) => ({ d, j })).sort((a, b) => (opt && opt.keepOrder ? 0 : rank[toneOf(a.d)] - rank[toneOf(b.d)]) || a.j - b.j).map((x) => x.d);
      const clear = ds.filter((d) => toneOf(d) === "ok");
      const chips = clear.map((d) => el(d.onClick && d.value ? "button" : "span", { type: d.onClick && d.value ? "button" : null, class: "exc-chip", "data-tip": `${d.label}
Rule: ${d.rule}`,
        onclick: d.onClick && d.value ? d.onClick : null }, [el("span", { class: "exc-chip-ok", text: "✓" }), `${d.label}: ${d.valueText != null ? d.valueText : fmtInt(d.value)}`]));
      return el("div", { class: "exc-row", style: `--n: ${Math.max(1, act.length)}` }, [
        el("div", { class: "exc-row-head" }, [el("span", { class: "exc-row-n", text: String(i + 1) }), el("span", { text: title }),
          !act.length ? el("span", { class: "exc-row-ok", text: "all clear" }) : null]),
        act.length ? exceptions(act) : null,
        chips.length ? el("div", { class: "exc-chips" }, chips) : null,
      ]);
    }).filter(Boolean);
    // renumber shown rows 1..n
    rows.forEach((r, i) => { r.querySelector(".exc-row-n").textContent = String(i + 1); });
    return el("div", { class: "exc-rows" }, rows);
  }
  return el("div", { class: "grid exc-grid" }, defs.map((d) => {
    const tone = d.tone || (d.value ? "bad" : "ok");
    const node = el("div", { class: `card exc ${tone}${d.onClick ? " linked" : ""}`, "data-tip": `${d.label}\nRule: ${d.rule}${d.onClick ? "\nClick for the list." : ""}`,
      role: d.onClick ? "button" : null, tabindex: d.onClick ? "0" : null }, [
      el("div", { class: "exc-value", text: d.valueText != null ? d.valueText : fmtInt(d.value) }),
      el("div", { class: "exc-label", text: d.label }),
      d.sub ? el("div", { class: "exc-sub", text: d.sub }) : null,
      el("div", { class: "exc-rule", text: d.rule }),
    ]);
    if (d.onClick) { node.addEventListener("click", d.onClick); node.addEventListener("keydown", (e) => { if (e.key === "Enter") d.onClick(); }); }
    return node;
  }));
}

// ---------------------------------------------------------------- pace (D-94)
// items: [{label, mtd, today?, target?, targetToDate?, stretch?, lastFull, lastSame, onClick?, sub?}]
export function pace(items, ctx) {
  // Reference layout (D-107): title · big number · "Plan MTD: X · Y% achieved" · bar · "±% vs N LMTD · run rate" · "Month plan · required run rate".
  // Plan cards: achieved = done ÷ plan MTD (the plan's daily curve to yesterday; straight line when the plan has no curve, e.g. MOP).
  // No-plan cards: the yardstick is last month to the same day (LMTD), D-106. Projection and the rest are in the tooltip.
  return el("div", { class: "grid pace-grid" }, items.map((it) => {
    const rr = ctx.dayN ? it.mtd / ctx.dayN : 0, left = Math.max(1, ctx.days - ctx.dayN);
    const hasPlan = !!it.target;
    const goal = hasPlan ? it.target : it.lastFull;
    const planCurve = hasPlan && it.targetToDate != null;
    const yard = hasPlan ? (planCurve ? it.targetToDate : (it.target * ctx.dayN) / ctx.days) : (it.lastSame || null);  // plan MTD, or LMTD
    const ach = yard ? (100 * it.mtd) / yard : null;
    const tone = ach == null ? "flat" : ach >= 90 ? "good" : ach >= 75 ? "warn" : "bad";  // D-99: amber below 90%, red below 75%
    const proj = yard && goal ? Math.round((it.mtd / yard) * goal) : Math.round(rr * ctx.days);
    const need = goal ? Math.max(0, (goal - it.mtd) / left) : null;
    const d = delta(it.mtd, it.lastSame, "count", "up");
    // no plan: LMTD is a benchmark, not a target, so show how far behind / ahead of it (D-107 refined): amber up to 10% behind, red beyond
    const gap = !hasPlan && it.lastSame ? (100 * (it.mtd - it.lastSame)) / it.lastSame : null;
    const gapTone = gap == null ? "flat" : gap >= 0 ? "good" : gap >= -10 ? "warn" : "bad";
    const gapTxt = gap == null ? "–" : Math.abs(gap) < 0.05 ? "level with LMTD" : `${gap > 0 ? "▲" : "▼"} ${Math.abs(gap).toFixed(1)}% ${gap > 0 ? "ahead of" : "behind"} LMTD`;
    const tip = [`${it.label}${it.sub ? ` (${it.sub})` : ""}, ${ctx.curRange}: ${fmtInt(it.mtd)}`, it.today != null ? `Today so far (partial, not counted): ${fmtInt(it.today)}` : "",
      hasPlan ? `Plan MTD ${fmtInt(Math.round(yard))} = what the plan expects by the end of ${ctx.dayN === 1 ? "day 1" : `day ${ctx.dayN}`} (${planCurve ? "the plan's daily curve" : `month plan × ${ctx.dayN}/${ctx.days} days, no daily curve`}) · achieved ${ach != null ? Math.round(ach) : "–"}%`
        : `No plan: benchmark = ${ctx.prevLabel} to the same day (LMTD ${fmtInt(it.lastSame)}) · ${gapTxt}`,
      hasPlan ? `Month plan (base) ${fmtInt(it.target)}${it.stretch ? ` · stretch (aggressive) ${fmtInt(it.stretch)}` : ""} · ${fmtInt(Math.round((100 * it.mtd) / it.target))}% of the month done` : `${ctx.prevLabel} full month ${fmtInt(it.lastFull)} · ${goal ? Math.round((100 * it.mtd) / goal) : "–"}% of it done`,
      `Same days last month (LMTD): ${fmtInt(it.lastSame)}${d ? ` · ${d.arrow} ${d.text}` : ""}`,
      `Run rate ${rr.toFixed(1)}/day · projected month-end ${fmtInt(proj)}${goal ? ` (${Math.round((100 * proj) / goal)}% of ${hasPlan ? "plan" : ctx.prevLabel})` : ""}${yard ? " = done ÷ yardstick to date × month total" : ""}`,
      need != null ? `Required run rate ${need.toFixed(1)}/day for the remaining ${left} days to reach ${hasPlan ? "the plan" : `${ctx.prevLabel}'s total`}` : ""].filter(Boolean).join("\n");
    const achTxt = ach == null ? "–" : `${Math.round(ach)}%`;
    const node = el("div", { class: `card pace2${it.onClick ? " linked" : ""}`, "data-tip": tip }, [
      el("div", { class: "p2-title" }, [it.label, it.sub ? el("span", { text: ` · ${it.sub}` }) : null]),
      el("div", { class: "p2-value", text: fmtInt(it.mtd) }),
      el("div", { class: "p2-line" }, hasPlan
        ? [`Plan MTD: ${fmtInt(Math.round(yard))} ·`, el("b", { class: tone, text: `${achTxt} achieved` })]
        : [`LMTD: ${fmtInt(it.lastSame)} ·`, el("b", { class: gapTone, text: gapTxt })]),
      hasPlan ? el("div", { class: "pace-bar" }, el("i", { class: tone, style: { width: `${ach == null ? 0 : Math.min(100, ach)}%` } })) : null,
      el("div", { class: "p2-line" }, hasPlan
        ? [el("span", { class: "nowrap" }, [d ? el("span", { class: `delta ${d.tone}`, text: `${d.arrow} ${d.text}` }) : null, ` vs ${fmtInt(it.lastSame)} LMTD`]), el("span", { class: "nowrap", text: `· run rate ${rr.toFixed(1)}/day` })]
        : [`Run rate ${rr.toFixed(1)}/day`]),
      el("div", { class: "p2-line muted", text: hasPlan ? `Month plan ${fmtInt(it.target)} · required run rate ${need.toFixed(1)}/day` : `${ctx.prevLabel} full month ${fmtInt(it.lastFull)} · required run rate ${need != null ? need.toFixed(1) : "–"}/day` }),
    ]);
    if (it.onClick) { node.setAttribute("role", "link"); node.setAttribute("tabindex", "0"); node.addEventListener("click", it.onClick); }
    return node;
  }));
}

// ---------------------------------------------------------------- 3 + 4. rankings
function groupRows(src, dim) {
  const g = new Map();
  for (const r of src.rows) {
    const k = label(src.file, dim, r[src.ci[dim]]);
    if (SKIP.has(k)) continue;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  return g;
}

/** One row per group: value now, value same days last month, change, sample size; null when below the minimum sample. */
function scoreGroups(m, ctx, sources, dim) {
  const src = sources[m.src];
  const out = [];
  for (const [name, rows] of groupRows(src, dim)) {
    if (m.kind === "now") {
      const v = m.value(rows, null);
      if (v == null) continue;
      out.push({ name, v, p: null, d: null, base: rows.length, score: v });
      continue;
    }
    const v = m.value(rows, ctx.cur), p = m.value(rows, ctx.prevSame);
    const base = m.base ? m.base(rows, ctx.cur) : (m.kind === "count" ? Math.max(v || 0, p || 0) : rows.length);
    const min = m.minBase ?? (m.kind === "count" ? 10 : 20);
    if (v == null || base < min) continue;
    const d = delta(v, p, deltaKind(m.kind), m.good);
    // counts rank on change vs same days last month (a big city isn't "leading" just because it's big); rates on their value
    const score = m.kind === "count" ? (p ? (100 * (v - p)) / p : null) : v;
    if (score == null) continue;
    out.push({ name, v, p, d, base, score });
  }
  return out;
}

function boardList(rows, m, tone) {
  const box = el("div", { class: "board-list" });
  if (!rows.length) box.append(el("div", { class: "count", text: "Not enough volume to rank." }));
  rows.forEach((r, i) => box.append(el("div", { class: "board-row" }, [
    el("span", { class: "att-rank", text: String(i + 1) }),
    el("span", { class: "board-name", text: r.name, title: r.name }),
    el("span", { class: "board-val", text: fmtKind(m.kind === "now" ? "count" : m.kind, r.v) }),
    r.d ? el("span", { class: `delta ${r.d.tone}`, text: `${r.d.arrow} ${r.d.text}` }) : el("span", { class: `board-tag ${tone}` }),
  ])));
  return box;
}

export function rankings(metrics, ctx, sources, { level, metricId, onLevel, onMetric, page }) {
  const rankable = metrics.filter((m) => m.rank !== false);
  const m = rankable.find((x) => x.id === metricId) || rankable[0];
  const dim = LEVELS.some(([k]) => k === level) ? level : "cluster";
  const dimLabel = LEVELS.find(([k]) => k === dim)[1];
  const scored = scoreGroups(m, ctx, sources, dim);
  const better = m.good === "up" ? (a, b) => b.score - a.score : (a, b) => a.score - b.score;
  const sorted = [...scored].sort(better);
  const lagN = Math.min(5, Math.floor(sorted.length / 2)), leadN = Math.min(5, sorted.length - lagN);  // never the same name on both boards
  const leaders = sorted.slice(0, leadN);
  const laggers = sorted.slice(sorted.length - lagN).reverse();
  const how = m.kind === "now" ? "live count" : m.kind === "count" ? `change vs ${ctx.live ? "same days last month" : ctx.prevLabel}` : `${ctx.curText} value`;
  const sel = el("select", { class: "mini-select", "aria-label": "Metric to rank" }, rankable.map((x) => el("option", { value: x.id, text: x.label, selected: x.id === m.id })));
  sel.addEventListener("change", () => onMetric(sel.value));
  const controls = el("div", { class: "rank-controls" }, [
    segmented(LEVELS, dim, onLevel, "Rank by level"), el("span", { class: "rank-label", text: "Metric" }), sel,
    el("span", { class: "count", text: `Ranked on ${how} · ${scored.length} ${dimLabel}s with enough volume` }),
  ]);
  // live counts (backlogs) have no "leaders": the best are simply the ones with nothing open, so show the biggest backlogs only
  const boards = m.kind === "now"
    ? el("div", { class: "grid" }, [el("div", { class: "card board bad" }, [el("div", { class: "board-head", text: `Biggest backlog · top 10 ${dimLabel}` }),
        boardList([...scored].sort((a, b) => b.score - a.score).filter((r) => r.score > 0).slice(0, 10), m, "bad")])])
    : el("div", { class: "grid two" }, [
      el("div", { class: "card board good" }, [el("div", { class: "board-head", text: `Leaderboard · top 5 ${dimLabel}` }), boardList(leaders, m, "good")]),
      el("div", { class: "card board bad" }, [el("div", { class: "board-head", text: `Laggerboard · bottom 5 ${dimLabel}` }), boardList(laggers, m, "bad")]),
    ]);
  return el("div", {}, [controls, boards, rankTable(rankable, ctx, sources, dim, dimLabel, page)]);
}

function rankTable(metrics, ctx, sources, dim, dimLabel, page) {
  const byName = new Map();
  for (const m of metrics) {
    const src = sources[m.src];
    for (const [name, rows] of groupRows(src, dim)) {
      const r = byName.get(name) || { name };
      if (m.kind === "now") r[`v_${m.id}`] = m.value(rows, null);
      else {
        const v = m.value(rows, ctx.cur), p = m.value(rows, ctx.prevSame);
        r[`v_${m.id}`] = v;
        const d = delta(v, p, deltaKind(m.kind), m.good);
        r[`d_${m.id}`] = d ? (m.kind === "count" ? (p ? Math.round((1000 * (v - p)) / p) / 10 : null) : Math.round(10 * (v - p)) / 10) : null;
      }
      byName.set(name, r);
    }
  }
  const rows = [...byName.values()];
  const cols = [{ key: "name", label: dimLabel }];
  for (const m of metrics) {
    cols.push({ key: `v_${m.id}`, label: m.label, num: true, fmt: (v) => fmtKind(m.kind === "now" ? "count" : m.kind, v), csv: (v) => v });
    if (m.kind !== "now") cols.push({ key: `d_${m.id}`, label: m.kind === "count" ? "Δ %" : m.kind === "pct" ? "Δ pts" : "Δ d", num: true, fmt: (v) => (v == null ? "" : `${v > 0 ? "+" : ""}${v}`), csv: (v) => v });
  }
  const first = metrics[0];
  const exportBtn = el("button", { class: "small-btn", type: "button", text: "Export CSV", onclick: () => downloadCSV(`${page}_${dim}_${ctx.key}.csv`, cols, rows) });
  return card(`All ${dimLabel}s`, `${ctx.curText} · Δ vs ${ctx.live ? "same days last month" : ctx.prevLabel} · click a header to sort`,
    dataTable(cols, rows, { sortKey: `v_${first.id}`, sortDir: -1, maxHeight: 420 }), [el("span", { class: "count", text: `${rows.length} rows` }), exportBtn]);
}

// ---------------------------------------------------------------- 5. details
export function details(title, sub, ...children) {
  return el("details", { class: "fold" }, [
    el("summary", {}, [el("span", { class: "fold-title", text: title }), sub ? el("span", { class: "fold-sub", text: sub }) : null]),
    el("div", { class: "fold-body" }, children),
  ]);
}

// ---------------------------------------------------------------- page skeleton
export function block(n, title, sub, ...children) {
  return el("section", { class: "section" }, [
    el("div", { class: "section-head" }, [el("h2", {}, [el("span", { class: "step", text: String(n) }), title]), sub ? el("span", { class: "sub", text: sub }) : null]),
    ...children,
  ]);
}

// ---------------------------------------------------------------- cluster x stage (D-105)
/**
 * Rows = clusters (worst first: most projects past P90), columns = stages in `order` (any other value goes last, biggest first).
 * Each cell: project count, and below it how many are past P90 (`late(x)`); shaded by the share past P90: 20-40% light,
 * 40-60% mid, 60%+ strong (open stages run ~27% past P90 India-wide, so the bands pick out the worst cells); cells under
 * 5 projects stay unshaded. Click a cell, a row total or a column total for its projects.
 */
export function stageMatrix({ items, stageOf, groupOf, late, order = [], onCell, corner = "Cluster", what = "projects", colLabel = (c) => c, colGroups = null, lateWord = "past P90" }) {
  const count = new Map();
  for (const x of items) count.set(stageOf(x), (count.get(stageOf(x)) || 0) + 1);
  const stages = [...order.filter((s) => count.has(s)), ...[...count.keys()].filter((s) => !order.includes(s)).sort((a, b) => count.get(b) - count.get(a))];
  const groups = new Map();
  for (const x of items) { const g = groupOf(x); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); }
  const rowsG = [...groups].map(([g, xs]) => ({ g, xs, late: xs.filter(late).length }))
    .sort((a, b) => b.late - a.late || b.xs.length - a.xs.length || String(a.g).localeCompare(String(b.g)));
  const tint = (n, l) => (!n ? "zero" : n < 5 || l / n < 0.2 ? "" : l / n >= 0.6 ? "t3" : l / n >= 0.4 ? "t2" : "t1");
  const pctTxt = (n, l) => (n ? `${Math.round((100 * l) / n)}%` : "–");
  const cellTd = (xs, rowName, colName, extra = "") => {
    const n = xs.length, l = xs.filter(late).length;
    if (!n) return el("td", { class: `sm zero${extra}`, text: "·" });
    const title = colName ? `${rowName} · ${colName}` : rowName;
    return el("td", { class: `sm ${tint(n, l)}${extra}`, tabindex: "0", role: "button",
      "data-tip": `${title}\n${fmtInt(n)} ${what} · ${fmtInt(l)} ${lateWord} (${pctTxt(n, l)})\nClick for the list`,
      onclick: () => onCell(xs, title), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCell(xs, title); } } },
    [fmtInt(n), l ? el("span", { class: "sm-late", text: `${fmtInt(l)} late` }) : null]);
  };
  // column groups (D-110): e.g. Pre-RTI / RTI / Post-RTI, each collapsible to one total column (collapsed by default)
  const gdefs = colGroups ? colGroups.map((g) => ({ ...g, stages: g.stages.filter((s) => count.has(s)) })) : null;
  if (gdefs) { const used = new Set(gdefs.flatMap((g) => g.stages)); const rest = stages.filter((s) => !used.has(s)); if (rest.length) gdefs.push({ name: "Other", stages: rest }); }
  const openSet = new Set();
  const holder = el("div", { class: "table-wrap", style: { maxHeight: "560px", overflow: "auto" } });
  const allLate = items.filter(late).length;
  const draw = () => {
    // columns: {label, tip, match(stage), first (group start, for the divider)}
    const cols = [];
    if (gdefs) {
      for (const g of gdefs) {
        if (!g.stages.length) continue;
        if (openSet.has(g.name)) g.stages.forEach((s, i) => cols.push({ label: colLabel(s), tip: s, match: (x) => x === s, first: i === 0, group: g.name }));
        else cols.push({ label: "All", tip: `${g.name}: ${g.stages.join(", ")}`, match: (x) => g.stages.includes(x), first: true, group: g.name, total: true });
      }
    } else stages.forEach((s) => cols.push({ label: colLabel(s), tip: s, match: (x) => x === s }));
    const table = el("table", { class: `data stage-matrix${gdefs ? " grouped" : ""}` });
    const head = [];
    if (gdefs) {
      const r1 = [el("th", { class: "sticky", rowspan: "2", text: corner })];
      for (const g of gdefs) {
        if (!g.stages.length) continue;
        const span = openSet.has(g.name) ? g.stages.length : 1, n = items.filter((x) => g.stages.includes(stageOf(x))).length;
        r1.push(el("th", { class: "num grp-head", colspan: String(span), "data-tip": `${g.name} (${fmtInt(n)} ${what}): ${g.stages.join(" → ")}\nClick to ${openSet.has(g.name) ? "fold" : "show"} its stages` }, [
          el("button", { type: "button", class: "grp-toggle", "aria-expanded": String(openSet.has(g.name)), onclick: () => { if (openSet.has(g.name)) openSet.delete(g.name); else openSet.add(g.name); draw(); } },
            [el("span", { class: "grp-caret", text: openSet.has(g.name) ? "▾" : "▸" }), `${g.name} · ${fmtInt(n)}`])]));
      }
      r1.push(el("th", { class: "num", rowspan: "2", text: "Total" }), el("th", { class: "num", rowspan: "2", text: lateWord.replace(/^past/, "Past") }));
      head.push(el("tr", {}, r1), el("tr", {}, cols.map((c) => el("th", { class: `num${c.first ? " grp-first" : ""}`, text: c.label, "data-tip": c.tip }))));
    } else {
      head.push(el("tr", {}, [el("th", { class: "sticky", text: corner }), ...cols.map((c) => el("th", { class: "num", text: c.label, "data-tip": c.tip })),
        el("th", { class: "num", text: "Total" }), el("th", { class: "num", text: lateWord.replace(/^past/, "Past") })]));
    }
    table.append(el("thead", {}, head));
    const tb = el("tbody");
    const colTitle = (c) => (c.total ? c.group : c.tip);
    for (const r of rowsG) {
      tb.append(el("tr", {}, [el("td", { class: "sticky", text: r.g }), ...cols.map((c) => cellTd(r.xs.filter((x) => c.match(stageOf(x))), r.g, colTitle(c), c.first && gdefs ? " grp-first" : "")),
        cellTd(r.xs, `${r.g} · all stages`), el("td", { class: "num", text: r.late ? `${fmtInt(r.late)} (${pctTxt(r.xs.length, r.late)})` : "0" })]));
    }
    tb.append(el("tr", { class: "total-row" }, [el("td", { class: "sticky", text: "All" }), ...cols.map((c) => cellTd(items.filter((x) => c.match(stageOf(x))), "All", colTitle(c), c.first && gdefs ? " grp-first" : "")),
      cellTd(items, "All · all stages"), el("td", { class: "num", text: `${fmtInt(allLate)} (${pctTxt(items.length, allLate)})` })]));
    table.append(tb);
    holder.replaceChildren(table);
  };
  draw();
  const legend = el("div", { class: "sm-legend" }, [
    el("span", { text: `Shade = share ${lateWord}:` }),
    el("span", {}, [el("i", { style: { background: "var(--surface)" } }), "under 20%"]),
    el("span", {}, [el("i", { style: { background: "var(--bad-soft)" } }), "20–40%"]),
    el("span", {}, [el("i", { style: { background: "color-mix(in srgb, var(--bad) 28%, var(--surface))" } }), "40–60%"]),
    el("span", {}, [el("i", { style: { background: "color-mix(in srgb, var(--bad) 48%, var(--surface))" } }), "60% or more"]),
    el("span", { text: `· all: ${pctTxt(items.length, allLate)} late · cells under 5 projects not shaded · ${gdefs ? "click a group heading to show its stages · " : ""}click any number for its list` }),
  ]);
  return el("div", {}, [legend, holder]);
}

// ---------------------------------------------------------------- day charts: last 30 / 60 / 90 days (D-117)
export const DAY_SPANS = [30, 60, 90];
/** How many days the Day view of a trend chart shows (shared state, default 30). */
export const daySpanOf = (state) => (DAY_SPANS.includes(Number(state.daySpan)) ? Number(state.daySpan) : 30);
/** The 30 / 60 / 90 days switch shown next to a trend's grain switch while the Day view is on. */
export function daySpanSwitch(state, setState) {
  return segmented(DAY_SPANS.map((n) => [String(n), `${n} days`]), String(daySpanOf(state)), (v) => setState({ daySpan: Number(v) }), "Days shown");
}

// ---------------------------------------------------------------- cluster table with a tier switch (D-116)
/**
 * One sortable cluster table with an All / BAU / Expansion switch above it (replaced the BAU / Expansion folds, D-116).
 * The pinned total row and the summary on the right follow the switch. `tier` is the shared state value: "all" | "bau" | "exp".
 * totalOf(rows, name) builds the total row; sumParts(total) the summary spans.
 */
export function tierTable({ rows, cols, totalOf, sumParts = () => [], tier = "all", onTier, sortKey = null, sortDir = -1 }) {
  const t = tier === "bau" || tier === "exp" ? tier : "all";
  const nExp = rows.filter((r) => isExpansion(r.name)).length, nBau = rows.length - nExp;
  const shown = t === "all" ? rows : rows.filter((r) => (t === "exp") === isExpansion(r.name));
  const total = totalOf(shown, t === "all" ? "All clusters" : t === "bau" ? "BAU" : "Expansion");
  return el("div", { class: "cl-group cl-flat" }, [
    el("div", { class: "cl-head" }, [
      segmented([["all", `All · ${rows.length}`], ["bau", `BAU · ${nBau}`], ["exp", `Expansion · ${nExp}`]], t, onTier, "Cluster tier"),
      el("span", { class: "cl-sum" }, sumParts(total)),
    ]),
    el("div", { class: "cl-body" }, shown.length
      ? dataTable(cols, shown, { sortKey, sortDir, maxHeight: 560, footer: total })
      : el("div", { class: "empty", text: "No clusters in this tier for the current filters." })),
  ]);
}

// ---------------------------------------------------------------- folded cluster table (D-110 / D-111)
/**
 * One collapsible group of a cluster table: a <details> with a summary line (title, cluster count, summary parts) and a
 * sortable table with a pinned subtotal. Used by the V3 pages (BAU / Expansion, or the plan's groups).
 */
export function foldTable(title, rows, cols, total, sumParts = [], { open = true, sortKey = null, sortDir = -1, note = "" } = {}) {
  return el("details", { class: "cl-group", open }, [
    el("summary", {}, [el("span", { text: title }), el("span", { class: "count", text: `${rows.length} ${rows.length === 1 ? "cluster" : "clusters"}${note ? ` · ${note}` : ""}` }), el("span", { class: "cl-sum" }, sumParts)]),
    el("div", { class: "cl-body" }, dataTable(cols, rows, { sortKey, sortDir, maxHeight: 560, footer: total })),
  ]);
}
