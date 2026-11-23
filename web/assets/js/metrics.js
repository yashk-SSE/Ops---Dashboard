// Shared metric calculations for all pages (pure functions over the published facts).
import { matcher, label, monthKey, monthsBetween } from "./data.js";
import { tatSummary, percentile, pct } from "./stats.js";

export function ranges(meta, period) {
  return { cur: meta.windows[period], prev: meta.windows_prev[period] };
}
export const inRange = (d, [a, b]) => d != null && d >= a && d <= b;

// ---------------- P2 (install -> commissioning) ----------------
export function p2Rows(data, state) {
  const f = data.p2;
  return f.facts.filter(matcher(f, state.filters, f.ci));
}
export function p2Closed(data, rows, range) {
  const ci = data.p2.ci;
  return tatSummary(rows.filter((r) => inRange(r[ci.commissioned_day], range) && r[ci.tat_days] != null).map((r) => r[ci.tat_days]));
}
export function p2Count(data, rows, col, range) {
  const ci = data.p2.ci;
  return rows.filter((r) => inRange(r[ci[col]], range)).length;
}
// HOTO -> install for projects INSTALLED in the range (closed-case basis, D-10).
export function hotoToInstall(data, rows, range) {
  const ci = data.p2.ci;
  const t = [];
  for (const r of rows) {
    const i = r[ci.installed_day], h = r[ci.hoto_day];
    if (inRange(i, range) && h != null && i >= h) t.push(i - h);
  }
  return tatSummary(t);
}
// Live pending lists. stateFilter "all" = every alive project (active, on-hold, seeking cancellation); when the
// 'hide cancelled / on-hold' switch is on, "all" keeps active projects only (D-107). An explicit state always wins.
const pendState = (state, stateFilter) => (stateFilter === "all" && state.hideCancelled ? "active" : stateFilter);
export function p2Pending(data, state, stateFilter = "all") {
  const f = data.p2, pci = f.pci, m = matcher(f, state.filters, pci), sf = pendState(state, stateFilter);
  return f.pending.filter((r) => m(r) && (sf === "all" || label(f, "state", r[pci.state]) === sf));
}

// ---------------- P1 (HOTO -> install, cohort) ----------------
export function p1Rows(data, state) {
  const f = data.p1, ci = f.ci, m = matcher(f, state.filters, ci);
  return f.facts.filter((r) => m(r) && (!state.hideCancelled || r[ci.later_cancelled] === 0));
}
export function stageStats(rows, col) {
  let applicable = 0, reached = 0;
  const tats = [];
  for (const r of rows) {
    const v = r[col];
    if (v == null) continue;
    applicable += 1;
    if (v >= 0 || v === -2) { reached += 1; if (v >= 0) tats.push(v); }
  }
  return { applicable, reached, reachedPct: pct(reached, applicable), ...tatSummary(tats) };
}
// Fixed-age conversion: share of cohort projects old enough (>= days since HOTO) that reached the stage within `days`.
// Fair across periods, unlike raw cohort %, because every project had the same time to get there.
export function withinDays(data, rows, stageId, days) {
  const ci = data.p1.ci, col = ci[stageId], asOf = data.meta.as_of_day;
  let base = 0, hit = 0;
  for (const r of rows) {
    const v = r[col];
    if (v == null || asOf - r[ci.hoto_day] < days) continue;
    base += 1;
    if (v >= 0 && v <= days) hit += 1;
  }
  return { base, hit, pct: pct(hit, base) };
}
// "≤N days of HOTO" cards (V-03, D-67): follow the HOTOs whose N-day mark falls in the period,
// i.e. HOTO day in [from − N, to − N]. Every period (even the current month) then has a full, comparable base.
export const maturedRange = (range, days) => [range[0] - days, range[1] - days];
export function maturedRows(data, rows, range, days) {
  const ci = data.p1.ci, r2 = maturedRange(range, days);
  return rows.filter((r) => inRange(r[ci.hoto_day], r2));
}
export function withinDaysMatured(data, rows, stageId, days, range) {
  return withinDays(data, maturedRows(data, rows, range, days), stageId, days);
}
export function p1Cohort(data, rows, range) {
  const ci = data.p1.ci;
  return rows.filter((r) => inRange(r[ci.hoto_day], range));
}
export function p1Pending(data, state, stateFilter = "all") {
  const f = data.p1, pci = f.pci, m = matcher(f, state.filters, pci), sf = pendState(state, stateFilter);
  return f.pending.filter((r) => m(r) && (sf === "all" || label(f, "state", r[pci.state]) === sf));
}

/** Stuck rule (D-111, global switch in the top bar): "p90" = past the India P90 (default); "p50x2" = past twice the India P50.
 *  ("ideal" = the team's ideal install TAT per lane: waits for the per-lane targets.) */
export const STUCK_RULES = { p90: { short: "P90", label: "India P90" }, p50x2: { short: "2× P50", label: "2 × India P50" } };
export function stuckLimit(values, ctx) {
  if (!values || values.length < 30) return null;
  // 2 x P50 has a floor of 1 day: when most items close the same day (P50 = 0, e.g. tickets), a 0-day limit would make
  // everything late the moment it opens
  return ctx && ctx.stuckRule === "p50x2" ? Math.max(1, 2 * percentile(values, 0.5)) : percentile(values, 0.9);
}
export const stuckShort = (ctx) => (STUCK_RULES[(ctx && ctx.stuckRule) || "p90"] || STUCK_RULES.p90).short;

/** Stuck yardstick (D-99, D-107, D-111): per HOTO -> Install stage, the limit (India P90, or 2 x India P50) of days from HOTO to
 *  reach it, over ALL projects handed over in the last 6 full months (India-wide, not the filtered rows), so "stuck" means the same
 *  thing whatever the filters. (Name kept from when it was always the P90.) */
export function stageP90s(data, ctx) {
  const f = data.p1, ci = f.ci, from = ctx.cols.at(0).range[0], to = ctx.cols.at(-1).range[1];
  const out = new Map();
  for (const s of f.stages) {
    const t = [];
    for (const x of f.facts) { const h = x[ci.hoto_day]; if (h >= from && h <= to) { const d = x[ci[s.id]]; if (d != null && d >= 0) t.push(d); } }
    out.set(s.name, stuckLimit(t, ctx));
  }
  return out;
}

// ---------------- monthly series (trend charts) ----------------
export function trendMonths(meta) { return monthsBetween(meta.trend_from_day, meta.as_of_day); }
export function monthlySeries(meta, rows, dayFn, valueFn) {
  // valueFn(groupRows) -> number|null ; dayFn(row) -> day|null
  const months = trendMonths(meta);
  const groups = Object.fromEntries(months.map((k) => [k, []]));
  for (const r of rows) { const d = dayFn(r); if (d == null) continue; const k = monthKey(d); if (k in groups) groups[k].push(r); }
  return months.map((k) => valueFn(groups[k]));
}

// ---------------- change vs previous period ----------------
// kind: 'count' (% change) | 'days' (absolute days) | 'pct' (percentage points); good: 'up' | 'down'
export function delta(cur, prev, kind, good) {
  if (cur == null || prev == null || (kind === "count" && !prev)) return null;
  const diff = cur - prev;
  const value = kind === "count" ? (100 * diff) / prev : diff;
  const eps = kind === "count" ? 0.5 : 0.05;
  const dir = Math.abs(value) < eps ? "flat" : value > 0 ? "up" : "down";
  const tone = dir === "flat" ? "flat" : (dir === good ? "good" : "bad");
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const abs = Math.abs(value);
  const text = kind === "count" ? `${sign}${abs.toFixed(1)}%` : kind === "days" ? `${sign}${abs.toFixed(1)} d` : `${sign}${abs.toFixed(1)} pts`;
  return { dir, tone, text, arrow: dir === "up" ? "▲" : dir === "down" ? "▼" : "■" };
}

// ---------------- rankings for "needs attention" ----------------
export function rankBy(rows, keyFn, valueFn, { minSize = 1, limit = 5, desc = true } = {}) {
  const groups = new Map();
  for (const r of rows) { const k = keyFn(r); if (!k || k === "Not mapped" || k === "—" || k === "No cell") continue; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const out = [];
  for (const [k, g] of groups) {
    if (g.length < minSize) continue;
    const v = valueFn(g);
    if (v == null || v.value == null) continue;
    out.push({ name: k, size: g.length, ...v });
  }
  out.sort((a, b) => (desc ? b.value - a.value : a.value - b.value));
  return out.slice(0, limit);
}
// ---------------- QHSE (D-71) ----------------
export function qhseRows(data, state) {
  const f = data.qhse;
  return f.facts.filter(matcher(f, state.filters, f.ci));
}

export { percentile };

// ---------------- D-96: M0 / M1 / M2 conversion (the Install Plan's and the Control Tower's cohort view) ----------------
// For a period r (a month, or month to date): cohort k = HOTOs of the month k months before r's month (k = 0: the HOTOs
// inside r itself); converted = cohort projects installed from r's month start to r[1]. Same-days comparisons stay fair:
// for the same days last month the cohort shifts back a month too.
export function mConversion(rows, r, k, hotoDay, installDay) {
  if (!r) return { base: 0, hit: 0, pct: null };
  let lo, hi;
  if (k === 0) { lo = r[0]; hi = r[1]; } else { [lo, hi] = monthBoundsOf(shiftKey(monthKey(r[0]), -k)); }
  let base = 0, hit = 0;
  for (const x of rows) {
    const h = hotoDay(x);
    if (h == null || h < lo || h > hi) continue;
    base += 1;
    const i = installDay(x);
    if (i != null && i >= r[0] && i <= r[1] && i >= h) hit += 1;
  }
  return { base, hit, pct: pct(hit, base) };
}
function shiftKey(key, n) { const [y, m] = key.split("-").map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; }
function monthBoundsOf(key) {
  const [y, m] = key.split("-").map(Number);
  const E = Date.UTC(2020, 0, 1), D = 86400000;
  return [Math.round((Date.UTC(y, m - 1, 1) - E) / D), Math.round((Date.UTC(y, m, 0) - E) / D)];
}

/** RTI -> installed P90 days (D-109), over ALL projects handed over in the last 6 full months (India-wide, like stageP90s). */
export function rtiInstallP90(data, ctx) {
  const f = data.p1, ci = f.ci, from = ctx.cols.at(0).range[0], to = ctx.cols.at(-1).range[1];
  const rti = (f.stages.find((s) => s.id === "F02") || {}).id, inst = (f.stages.find((s) => s.id === "F07") || f.stages.at(-1)).id;
  if (!rti) return null;
  const t = [];
  for (const x of f.facts) { const h = x[ci.hoto_day]; if (h < from || h > to) continue; const a = x[ci[rti]], b = x[ci[inst]]; if (a != null && a >= 0 && b != null && b >= a) t.push(b - a); }
  return stuckLimit(t, ctx);
}

/** Install -> commissioning limit (D-111), India-wide: projects commissioned in the last 6 full months, by the stuck rule. */
export function commStuckLimit(data, ctx) {
  const f = data.p2, ci = f.ci, from = ctx.cols.at(0).range[0], to = ctx.cols.at(-1).range[1];
  const t = [];
  for (const x of f.facts) { const c = x[ci.commissioned_day]; if (c != null && c >= from && c <= to && x[ci.tat_days] != null) t.push(x[ci.tat_days]); }
  return stuckLimit(t, ctx);
}
