// DOM helpers and dashboard components. All data text goes in via textContent (labels are untrusted data).
import { icon } from "./icons.js";

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function section(title, sub, ...children) {
  return el("section", { class: "section" }, [
    el("div", { class: "section-head" }, [el("h2", { text: title }), sub ? el("span", { class: "sub", text: sub }) : null]),
    ...children,
  ]);
}

export function card(title, sub, body, actions) {
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("div", {}, [el("h3", { text: title }), sub ? el("div", { class: "card-sub", text: sub }) : null]),
      actions ? el("div", { class: "card-actions" }, actions) : null,
    ]),
    body,
  ]);
}

export function segmented(options, value, onChange, ariaLabel) {
  const wrap = el("div", { class: "seg", role: "group", "aria-label": ariaLabel || "" });
  for (const [val, text] of options) {
    wrap.append(el("button", { type: "button", "aria-pressed": String(val === value), text, onclick: () => onChange(val) }));
  }
  return wrap;
}

// ---------------- metric card ----------------
// opts: {label, value, unit, delta:{tone,text,arrow}|null, prevText, foot, group, now, title}. No sparkline (D-67).
export function metricCard(o) {
  const node = el("div", { class: `card metric${o.now ? " now" : ""}`, style: { "--group": `var(${o.group || "--accent"})` }, title: o.title || null });
  node.append(el("div", { class: "m-label", text: o.label }));
  const row = el("div", { class: "m-row" }, [
    el("span", { class: "m-value" }, [o.value, o.unit ? el("span", { class: "m-unit", text: o.unit }) : null]),
  ]);
  if (o.delta) row.append(el("span", { class: `delta ${o.delta.tone}`, title: "Change vs previous period" }, [o.delta.arrow, " ", o.delta.text]));
  node.append(row);
  if (o.prevText) node.append(el("div", { class: "m-prev", text: o.prevText }));
  if (o.foot) node.append(el("div", { class: "m-foot", text: o.foot }));
  return node;
}

// ---------------- brief ----------------
// items: [{tone:'good'|'bad'|'info', parts:[string | {b:string}]}]
export function briefCard(title, items, sub) {
  const ul = el("ul");
  for (const it of items) {
    const p = el("div");
    for (const part of it.parts) p.append(typeof part === "string" ? document.createTextNode(part) : el("b", { text: part.b }));
    ul.append(el("li", {}, [el("span", { class: `dot ${it.tone}`, text: it.tone === "good" ? "✓" : it.tone === "bad" ? "!" : "i" }), p]));
  }
  return el("div", { class: "card brief" }, [el("div", { class: "card-head" }, [el("div", {}, [el("h3", { text: title }), sub ? el("div", { class: "card-sub", text: sub }) : null])]), ul]);
}

// ---------------- needs-attention list ----------------
// rows: [{name, value, valueText, sub, ctx}] ; bar width = value / max
export function attentionCard(title, sub, rows, emptyText = "Nothing to flag for this selection.") {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const list = el("div", { class: "att-list" });
  if (!rows.length) list.append(el("div", { class: "count", text: emptyText }));
  rows.forEach((r, i) => list.append(el("div", { class: "att-row" }, [
    el("span", { class: "att-rank", text: String(i + 1) }),
    el("div", { class: "att-name" }, [el("div", { text: r.name, title: r.name }), r.ctx ? el("div", { class: "att-ctx", text: r.ctx }) : null,
      el("div", { class: "att-bar" }, el("i", { style: { width: `${Math.max(3, (100 * r.value) / max)}%` } }))]),
    el("div", { class: "att-val" }, [r.valueText, r.sub ? el("small", { text: r.sub }) : null]),
  ])));
  return card(title, sub, list);
}

// ---------------- tables ----------------
// a column's fmt may return text or a DOM node (e.g. an in-cell progress bar)
function cell(c, r) {
  const v = c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? "");
  return v instanceof Node ? el("td", { class: c.num ? "num" : null }, v) : el("td", { class: c.num ? "num" : null, text: v });
}

export function dataTable(columns, rows, opts = {}) {
  const state = { key: opts.sortKey || null, dir: opts.sortDir || -1 };
  const wrap = el("div", { class: "table-wrap", style: opts.maxHeight ? { maxHeight: `${opts.maxHeight}px` } : null });
  const table = el("table", { class: "data" });
  const thead = el("thead"), tbody = el("tbody");
  table.append(thead, tbody);
  wrap.append(table);
  const limit = opts.limit || 500;
  function render() {
    thead.replaceChildren(el("tr", {}, columns.map((c) => el("th", {
      class: `${c.num ? "num " : ""}sortable`, text: c.label + (state.key === c.key ? (state.dir > 0 ? " ▲" : " ▼") : ""), "data-tip": c.tip || null,
      onclick: () => { state.dir = state.key === c.key ? -state.dir : (c.num ? -1 : 1); state.key = c.key; render(); },
    }))));
    let data = rows;
    if (state.key) {
      data = [...rows].sort((a, b) => {
        const x = a[state.key], y = b[state.key];
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x > y ? 1 : x < y ? -1 : 0) * state.dir;
      });
    }
    const frag = document.createDocumentFragment();
    for (const r of data.slice(0, limit)) {
      frag.append(el("tr", {}, columns.map((c) => cell(c, r))));
    }
    if (data.length > limit) frag.append(el("tr", {}, el("td", { colspan: String(columns.length), class: "count", text: `Showing ${limit} of ${data.length} rows; search, filter or export CSV for all.` })));
    if (opts.footer) frag.append(el("tr", { class: "total-row" }, columns.map((c) => cell(c, opts.footer))));
    tbody.replaceChildren(frag);
  }
  render();
  return wrap;
}

export function heatTable(rowLabels, colLabels, cells, opts = {}) {
  const max = Math.max(1, ...cells.flat());
  const shade = (v) => {
    if (!v) return { bg: "transparent", fg: "var(--muted)" };
    const step = Math.min(6, Math.max(1, Math.ceil((v / max) * 6)));
    return { bg: `var(--ramp-${step})`, fg: step >= 4 ? "#ffffff" : "var(--text)" };
  };
  const table = el("table", { class: "data heat" });
  table.append(el("thead", {}, el("tr", {}, [el("th", { text: opts.corner || "" }), ...colLabels.map((c) => el("th", { class: "num", text: c })), el("th", { class: "num", text: "Total" })])));
  const tb = el("tbody");
  rowLabels.forEach((rl, i) => {
    const total = cells[i].reduce((a, b) => a + b, 0);
    tb.append(el("tr", {}, [
      el("td", { text: rl }),
      ...cells[i].map((v) => { const s = shade(v); return el("td", { class: "cell", text: v ? v.toLocaleString("en-IN") : "·", style: { background: s.bg, color: s.fg }, title: `${rl} · ${v}` }); }),
      el("td", { class: "num", text: total.toLocaleString("en-IN") }),
    ]));
  });
  table.append(tb);
  return el("div", { class: "table-wrap" }, table);
}

export function downloadCSV(filename, columns, rows) {
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [columns.map((c) => esc(c.label)).join(",")];
  for (const r of rows) lines.push(columns.map((c) => esc(c.csv ? c.csv(r[c.key], r) : r[c.key])).join(","));
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = el("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---- list filters (D-104): multi-select Cluster / Lane / Cell on every project list.
// Options are the values present in the list, counted after the other list filters (so Cluster narrows Cell).
const LIST_FACETS = ["cluster", "lane", "cell", "late"];  // "late": Late / Not late (D-117)
let facetCloser = false;
function facetMenu(labelText, getOptions, sel, onChange) {
  const value = el("span", { class: "facet-val" });
  const det = el("details", { class: "facet" });
  const search = el("input", { type: "search", class: "ms-search", placeholder: `Search ${labelText.toLowerCase()}…`, "aria-label": `Search ${labelText}` });
  const list = el("div", { class: "ms-list", role: "group", "aria-label": labelText });
  const sync = () => { value.textContent = !sel.size ? "All" : sel.size === 1 ? [...sel][0] : `${sel.size} selected`; det.classList.toggle("on", sel.size > 0); };
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = getOptions().filter(([v]) => !q || v.toLowerCase().includes(q));
    list.replaceChildren(...shown.map(([v, n]) => el("label", { class: "ms-opt" }, [
      el("input", { type: "checkbox", checked: sel.has(v), onchange: (e) => { if (e.target.checked) sel.add(v); else sel.delete(v); sync(); onChange(); } }),
      el("span", { text: v }), el("span", { class: "facet-n", text: n.toLocaleString("en-IN") })])));
    if (!shown.length) list.append(el("div", { class: "count", text: "No match." }));
  };
  search.addEventListener("input", draw);
  det.addEventListener("toggle", () => {
    if (!det.open) return;
    document.querySelectorAll("details.facet[open]").forEach((d) => { if (d !== det) d.open = false; });
    draw(); search.focus();
    // open leftwards when the menu would run past the right edge of its drawer or the window (e.g. the Late filter, last in the row)
    const pop = det.querySelector(".facet-pop"); pop.classList.remove("flip");
    const edge = Math.min(window.innerWidth, (det.closest(".list-panel, .drawer, aside") || document.body).getBoundingClientRect().right);
    if (pop.getBoundingClientRect().right > edge - 8) pop.classList.add("flip");
  });
  const clear = el("button", { type: "button", class: "ms-link", text: "Clear", onclick: () => { sel.clear(); sync(); draw(); onChange(); } });
  det.append(el("summary", {}, [el("span", { class: "facet-label", text: labelText }), value]),
    el("div", { class: "facet-pop" }, [el("div", { class: "ms-tools" }, [search, clear]), list]));
  sync();
  det.redraw = () => { sync(); if (det.open) draw(); };
  return det;
}

export function projectList(columns, rows, opts) {
  const box = el("div");
  const input = el("input", { class: "search", type: "search", placeholder: opts.placeholder || "Search SSE ID, cell, city…", "aria-label": "Search list" });
  const count = el("span", { class: "count" });
  const holder = el("div");
  const exportBtn = el("button", { class: "small-btn", type: "button", text: "Export CSV" });
  const noun = opts.noun || "projects";
  // filters: only columns this list has, and only when they hold 2+ values
  const keys = (opts.facets || LIST_FACETS).filter((k) => columns.some((c) => c.key === k) && new Set(rows.map((r) => r[k])).size > 1);
  const sel = Object.fromEntries(keys.map((k) => [k, new Set()]));
  const passes = (r, except) => keys.every((k) => k === except || !sel[k].size || sel[k].has(String(r[k] ?? "")));
  const optionsFor = (k) => {
    const m = new Map();
    for (const r of rows) if (passes(r, k)) { const v = String(r[k] ?? ""); if (v) m.set(v, (m.get(v) || 0) + 1); }
    for (const v of sel[k]) if (!m.has(v)) m.set(v, 0);  // keep ticked values visible
    return [...m].sort((a, b) => a[0].localeCompare(b[0]));
  };
  const clearAll = el("button", { type: "button", class: "ms-link facet-clear", text: "Clear filters", hidden: true,
    onclick: () => { keys.forEach((k) => sel[k].clear()); changed(); } });
  const menus = keys.map((k) => facetMenu(columns.find((c) => c.key === k).label, () => optionsFor(k), sel[k], () => changed()));
  function changed() { menus.forEach((m) => m.redraw()); clearAll.hidden = !keys.some((k) => sel[k].size); render(); }
  let current = rows;
  function render() {
    const q = input.value.trim().toLowerCase();
    const base = keys.some((k) => sel[k].size) ? rows.filter((r) => passes(r, null)) : rows;
    current = q ? base.filter((r) => opts.searchKeys.some((k) => String(r[k] ?? "").toLowerCase().includes(q))) : base;
    count.textContent = current.length === rows.length ? `${current.length.toLocaleString("en-IN")} ${noun}` : `${current.length.toLocaleString("en-IN")} of ${rows.length.toLocaleString("en-IN")} ${noun}`;
    holder.replaceChildren(dataTable(columns, current, { sortKey: opts.sortKey, sortDir: opts.sortDir, limit: 300, maxHeight: 460 }));
  }
  input.addEventListener("input", render);
  exportBtn.addEventListener("click", () => downloadCSV(opts.filename, columns, current));
  if (menus.length) box.append(el("div", { class: "facet-bar", role: "group", "aria-label": "List filters" }, [el("span", { class: "facet-title", text: "Filter list" }), ...menus, clearAll]));
  box.append(el("div", { class: "table-tools" }, [input, el("div", { class: "card-actions" }, [count, exportBtn])]), holder);
  if (!facetCloser) {  // one listener: a click outside an open filter closes it
    facetCloser = true;
    document.addEventListener("click", (e) => document.querySelectorAll("details.facet[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; }));
  }
  render();
  return box;
}

export { icon };
