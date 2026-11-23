// Chart.js wrappers that follow the dataviz specs: 2px lines, >=8px markers with a surface ring,
// bars <=24px with a 4px rounded data-end, hairline recessive grid, one y-axis, legend for >=2 series,
// index tooltip (crosshair) on lines. Colours come from CSS variables, so light / dark both work.
import { el, dataTable } from "./ui.js";

const charts = new WeakMap();

export function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function baseOptions(yFormat, legend) {
  const text2 = token("--text-2"), muted = token("--muted"), grid = token("--grid"), axis = token("--axis");
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: legend, position: "top", align: "start", labels: { color: text2, boxWidth: 14, boxHeight: 2, usePointStyle: false, font: { family: token("--font") } } },
      tooltip: {
        backgroundColor: token("--surface"), titleColor: token("--text"), bodyColor: token("--text"), borderColor: token("--border"), borderWidth: 1,
        padding: 10, boxWidth: 12, boxHeight: 2, usePointStyle: false,
        callbacks: { label: (c) => ` ${yFormat(c.parsed.y ?? c.parsed.x)}  ${c.dataset.label}` },
      },
    },
    scales: {
      x: { grid: { display: false }, border: { color: axis }, ticks: { color: muted, font: { family: token("--font") } } },
      y: { beginAtZero: true, grid: { color: grid, lineWidth: 1 }, border: { display: false }, ticks: { color: muted, callback: (v) => yFormat(v), font: { family: token("--font") } } },
    },
  };
}

const crosshair = {
  id: "crosshair",
  afterDraw(chart) {
    const a = chart.tooltip?.getActiveElements?.();
    if (!a || !a.length || chart.config.type !== "line") return;
    const x = a[0].element.x, { top, bottom } = chart.chartArea, ctx = chart.ctx;
    ctx.save(); ctx.strokeStyle = token("--axis"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); ctx.restore();
  },
};

function mount(canvas, config) {
  const prev = charts.get(canvas);
  if (prev) prev.destroy();
  const chart = new window.Chart(canvas, { ...config, plugins: [crosshair] });
  charts.set(canvas, chart);
  return chart;
}

// series: [{label, data, color: '--series-1'}]
export function lineChart(labels, series, { yFormat = (v) => v, height = 260 } = {}) {
  const canvas = el("canvas", { role: "img", "aria-label": series.map((s) => s.label).join(", ") });
  const box = el("div", { class: "chart-box", style: `height:${height}px` }, canvas);
  const surface = token("--surface");
  requestAnimationFrame(() => mount(canvas, {
    type: "line",
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.label, data: s.data, borderColor: token(s.color), backgroundColor: token(s.color),
        borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, pointBorderColor: surface, pointBorderWidth: 2,
        tension: 0, spanGaps: true,
      })),
    },
    options: baseOptions(yFormat, series.length > 1),
  }));
  return box;
}

export function barChart(labels, series, { yFormat = (v) => v, height = 260, horizontal = false } = {}) {
  const canvas = el("canvas", { role: "img", "aria-label": series.map((s) => s.label).join(", ") });
  const box = el("div", { class: "chart-box", style: `height:${height}px` }, canvas);
  requestAnimationFrame(() => {
    const opts = baseOptions(yFormat, series.length > 1);
    opts.interaction = { mode: "index", intersect: true };
    if (horizontal) {
      opts.indexAxis = "y";
      [opts.scales.x, opts.scales.y] = [opts.scales.y, opts.scales.x];
    }
    mount(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: series.map((s) => ({
          label: s.label, data: s.data, backgroundColor: token(s.color), hoverBackgroundColor: token(s.color),
          maxBarThickness: 24, borderRadius: 4, borderSkipped: "start",
          borderColor: token("--surface"), borderWidth: series.length > 1 ? { top: 0, right: 2, left: 0, bottom: 0 } : 0,
        })),
      },
      options: opts,
    });
  });
  return box;
}

/** Actual vs target (D-110): bars for the actual, a dashed line for the target (one y-axis). */
export function comboChart(labels, bar, line, { yFormat = (v) => v, height = 280 } = {}) {
  const canvas = el("canvas", { role: "img", "aria-label": `${bar.label} vs ${line ? line.label : ""}` });
  const box = el("div", { class: "chart-box", style: `height:${height}px` }, canvas);
  requestAnimationFrame(() => {
    const opts = baseOptions(yFormat, !!line);
    const datasets = [{ type: "bar", label: bar.label, data: bar.data, backgroundColor: token(bar.color), hoverBackgroundColor: token(bar.color), maxBarThickness: 26, borderRadius: 4, borderSkipped: "start", order: 2 }];
    if (line) datasets.push({ type: "line", label: line.label, data: line.data, borderColor: token(line.color), backgroundColor: token(line.color), borderWidth: 2, borderDash: [5, 4],
      pointRadius: 3, pointHoverRadius: 5, pointBorderColor: token("--surface"), pointBorderWidth: 2, tension: 0, spanGaps: false, order: 1 });
    mount(canvas, { type: "bar", data: { labels, datasets }, options: opts });
  });
  return box;
}

// "Show table" toggle: every chart's numbers stay reachable without hovering.
export function withTable(chartNode, columns, rows) {
  const holder = el("div");
  const tableNode = dataTable(columns, rows, { limit: 100, maxHeight: 260 });
  let showing = false;
  const btn = el("button", { class: "small-btn", type: "button", text: "Show table" });
  btn.addEventListener("click", () => {
    showing = !showing;
    btn.textContent = showing ? "Show chart" : "Show table";
    holder.replaceChildren(showing ? tableNode : chartNode);
  });
  holder.append(chartNode);
  return { node: holder, button: btn };
}
