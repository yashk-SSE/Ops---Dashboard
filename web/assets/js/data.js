// Data loading + decoding for the files written by pipeline/publish/web_data.py.
// Dates are day numbers since 2020-01-01 (IST dates); labels are indexes into file.dims.

const EPOCH_MS = Date.UTC(2020, 0, 1);
const DAY_MS = 86400000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const FILTER_DIMS = ["region", "cluster", "cell", "payment_lane", "lane", "zoh", "soh", "com"];

// Expansion clusters (D-77; moves to the Config sheet's Expansion_List). Every other cluster is BAU. The cluster tables
// show All / BAU / Expansion with the switch above them (D-116).
export const EXPANSION = new Set(["Vijayawada", "Guntur", "Bareilly", "Meerut", "Kota", "Visakhapatnam", "Salem", "Erode", "Jodhpur",
  "Raipur", "Trichy", "Madurai", "Prayagraj", "Krishnagiri"]);
export const isExpansion = (name) => EXPANSION.has(name);

export const DIM_LABELS = {
  region: "Region", cluster: "Cluster", city: "City", cell: "Cell", lane: "Lane", payment_lane: "Payment lane",
  com: "COM", soh: "SOH", zoh: "ZOH", state: "State", ic: "IC", vendor: "Vendor",
};

export function dayToDate(d) { return new Date(EPOCH_MS + d * DAY_MS); }
/** "2026-11-18" -> day number (days since 2020-01-01); null when invalid. */
export function dayFromISO(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - EPOCH_MS) / DAY_MS) : null; }
export function isoOfDay(d) { return dayToDate(d).toISOString().slice(0, 10); }
export function weekdayOf(d) { return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dayToDate(d).getUTCDay()]; }
export function fmtDay(d) {
  if (d == null) return "";
  const x = dayToDate(d);
  return `${String(x.getUTCDate()).padStart(2, "0")} ${MONTHS[x.getUTCMonth()]} ${String(x.getUTCFullYear()).slice(2)}`;
}
export function monthKey(d) {
  const x = dayToDate(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function monthLabel(key) {
  const [y, m] = key.split("-");
  return `${MONTHS[Number(m) - 1]}-${y.slice(2)}`;
}
/** [first day, last day] (day numbers) of a "YYYY-MM" month. */
export function monthBounds(key) {
  const [y, m] = key.split("-").map(Number);
  return [(Date.UTC(y, m - 1, 1) - EPOCH_MS) / DAY_MS, (Date.UTC(y, m, 0) - EPOCH_MS) / DAY_MS];
}
export function shiftMonth(key, n) {
  const [y, m] = key.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
export function monthsBetween(fromDay, toDay) {
  const out = [];
  const a = dayToDate(fromDay), b = dayToDate(toDay);
  let y = a.getUTCFullYear(), m = a.getUTCMonth();
  while (y < b.getUTCFullYear() || (y === b.getUTCFullYear() && m <= b.getUTCMonth())) {
    out.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    m += 1; if (m === 12) { m = 0; y += 1; }
  }
  return out;
}

function indexCols(cols) { return Object.fromEntries(cols.map((c, i) => [c, i])); }

async function getJSON(path) {
  // The single-file share build (pipeline/tools/build_share.py) embeds each data file as
  // <script type="application/json" id="opsdash-data-<name>">, so it opens from disk without a server.
  const name = path.replace(/^data\//, "").replace(/\.json$/, "");
  const embedded = document.getElementById(`opsdash-data-${name}`);
  if (embedded) return JSON.parse(embedded.textContent);
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

export async function loadAll() {
  const [meta, p1, p2, qhse, esc, sub, plan, nbfc, psu] = await Promise.all([getJSON("data/meta.json"), getJSON("data/p1.json"), getJSON("data/p2.json"),
    getJSON("data/qhse.json"), getJSON("data/escalations.json"), getJSON("data/subsidy.json"), getJSON("data/plan.json").catch(() => ({ months: {} })),
    getJSON("data/nbfc.json").catch(() => null), getJSON("data/psu.json").catch(() => null)]);  // D-122: a missing loan file only blanks its page
  for (const f of [p1, p2]) {
    f.ci = indexCols(f.cols);
    f.pci = indexCols(f.pending_cols);
  }
  qhse.ci = indexCols(qhse.cols);
  qhse.ppci = indexCols(qhse.pp_cols);
  esc.ci = indexCols(esc.cols);
  sub.ci = indexCols(sub.cols);
  for (const f of [nbfc, psu]) if (f) f.ci = indexCols(f.cols);
  return { meta, p1, p2, qhse, esc, sub, plan, nbfc, psu };
}

// Filters are multi-select: each dim holds a list of labels (empty = all). Old single-value states are read as one-item lists.
export const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
/** The filter dims with at least one value selected. */
export const activeFilterDims = (filters) => FILTER_DIMS.filter((d) => asList(filters[d]).length);

// Build a row predicate for one file from the label-based global filters: a row passes when, for every dim with a
// selection, its value is one of the selected labels. Labels that don't exist in this file match nothing (no such rows).
export function matcher(file, filters, colIndex) {
  const checks = [];
  for (const dim of FILTER_DIMS) {
    const labels = asList(filters[dim]);
    if (!labels.length) continue;
    const ci = colIndex[dim];
    if (ci == null) continue;
    const values = file.dims[dim] || [];
    checks.push([ci, new Set(labels.map((l) => values.indexOf(l)).filter((i) => i >= 0))]);
  }
  return (row) => checks.every(([ci, set]) => set.has(row[ci]));
}

export function label(file, dim, idx) { return idx == null ? "" : (file.dims[dim] || [])[idx] ?? ""; }

export function bucketOf(days, buckets) {
  for (const [lo, hi, lab] of buckets) if (days >= lo && (hi == null || days <= hi)) return lab;
  return buckets[0][2];
}

/**
 * Plan view for the Base / Aggressive switch (D-110). Pages read the install plan from base_* fields; in aggressive mode
 * those fields carry the aggressive numbers and aggr_* carry the base ones ("the other plan"). The plan has no aggressive
 * M0 / M1 / M2+ daily curves, so the base curves are scaled by aggressive / base for each bucket.
 */
export function planView(plan, mode) {
  if (!plan || mode !== "aggr") return plan;
  const scale = (cum, a, b) => (cum && b ? cum.map((v) => (v * a) / b) : cum);
  const months = {};
  for (const [k, m] of Object.entries(plan.months || {})) {
    const clusters = {};
    for (const [name, pc] of Object.entries(m.clusters || {})) {
      clusters[name] = {
        ...pc,
        base_total: pc.aggr_total, base_cum: pc.aggr_cum, base_m0: pc.aggr_m0, base_m1: pc.aggr_m1, base_m2plus: pc.aggr_m2plus,
        base_m0_cum: scale(pc.base_m0_cum, pc.aggr_m0, pc.base_m0), base_m1_cum: scale(pc.base_m1_cum, pc.aggr_m1, pc.base_m1),
        base_m2_cum: scale(pc.base_m2_cum, pc.aggr_m2plus, pc.base_m2plus),
        aggr_total: pc.base_total, aggr_cum: pc.base_cum,
      };
    }
    months[k] = { ...m, clusters };
  }
  return { ...plan, months, mode: "aggr" };
}
export const PLAN_NAMES = { base: "Base", aggr: "Aggressive" };
