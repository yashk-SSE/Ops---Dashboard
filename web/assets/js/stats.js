// Same maths as pipeline/common/stats.py, so the browser and the Python marts agree.

export function percentile(values, p) {
  if (!values.length) return null;
  const xs = [...values].sort((a, b) => a - b);
  const k = (xs.length - 1) * p;
  const lo = Math.floor(k), hi = Math.ceil(k);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (k - lo);
}

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

export function tatSummary(days) {
  const n = days.length;
  if (!n) return { count: 0, p50: null, p75: null, p90: null, within7: null, within15: null };
  let w7 = 0, w15 = 0;
  for (const d of days) { if (d <= 7) w7 += 1; if (d <= 15) w15 += 1; }
  return {
    count: n,
    p50: r1(percentile(days, 0.5)), p75: r1(percentile(days, 0.75)), p90: r1(percentile(days, 0.9)),
    within7: r1((100 * w7) / n), within15: r1((100 * w15) / n),
  };
}

const NF = new Intl.NumberFormat("en-IN");
export const fmtInt = (v) => (v == null ? "–" : NF.format(v));
export const fmtPct = (v) => (v == null ? "–" : `${v.toFixed(1)}%`);
export const fmtDays = (v) => (v == null ? "–" : `${Number.isInteger(v) ? v : v.toFixed(1)} d`);
export const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
