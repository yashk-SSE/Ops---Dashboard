// App shell: collapsible left navigation, sticky top bar (month picker + filter chips + Filters button),
// right-side filter drawer (D-64), router and global state. Pages use the month layout (D-81).
import { loadAll, FILTER_DIMS, DIM_LABELS, monthKey, monthLabel, asList, fmtDay, dayFromISO, isoOfDay, weekdayOf, planView } from "./data.js";
import { el, icon } from "./ui.js";
import { monthOptions, monthContext, defaultMonth, initTooltips } from "./layout.js";
import * as overview from "./pages/overview.js";
import * as p1 from "./pages/p1.js";
import * as p2 from "./pages/p2.js";
import * as qhse from "./pages/qhse.js";
import * as esc from "./pages/escalations.js";
import * as hotos from "./pages/hotos.js";
import * as sub from "./pages/subsidy.js";
import * as inst from "./pages/installs.js";
import * as tat from "./pages/tat.js";
import * as yesterday from "./pages/yesterday.js";
import * as actions from "./pages/actions.js";
import * as nbfc from "./pages/nbfc.js";
import * as psu from "./pages/psu.js";

const PAGES = {
  overview: { mod: overview, title: "Overview", icon: "home" },
  day: { mod: yesterday, title: "Yesterday", icon: "sun", daily: true },
  act: { mod: actions, title: "Needs action", icon: "alert" },
  p1: { mod: p1, title: "HOTO → Installation", icon: "funnel" },
  p2: { mod: p2, title: "Installation → Commissioning", nav: "Install → Commissioning", icon: "bolt" },
  qhse: { mod: qhse, title: "QHSE", icon: "shield" },
  esc: { mod: esc, title: "Escalations", icon: "alert" },
  hotos: { mod: hotos, title: "# of HOTOs", icon: "users" },
  sub: { mod: sub, title: "Subsidy backlog", icon: "receipt" },
  inst: { mod: inst, title: "Installations vs plan", icon: "calendar" },
  tat: { mod: tat, title: "TAT / SLA breach", icon: "clock" },
  nbfc: { mod: nbfc, title: "NBFC cases", icon: "coins" },
  psu: { mod: psu, title: "PSU cases", icon: "bank" },
};
const NAV = [
  { group: "Summary", items: [["overview"], ["act"], ["day"]] },
  { group: "Project journey", items: [["hotos"], ["inst"], ["p1"], ["p2"], ["sub"], ["tat"]] },
  { group: "Loan cases", items: [["nbfc"], ["psu"]] },  // D-122
  { group: "Quality and customer", items: [["qhse"], ["esc"]] },
  { group: "Coming next", items: [["soon", "Order → HOTO", "route"]] },
];
const STORE_KEY = "opsdash.state.v3";
const defaults = () => ({
  month: null,  // null = current month (D-67: every visit opens on the current month)
  filters: Object.fromEntries(FILTER_DIMS.map((d) => [d, []])),  // multi-select: list of labels per dim, empty = all
  hideCancelled: false,
  p1State: "all", p2State: "all", level: "cluster", rank: {}, qhseBase: "audited", qhsePP: "physical",
  p1StageView: "ours", stageHold: false,
  day: null,  // Yesterday page (D-108): null = yesterday; not restored between visits
  planMode: "base",  // D-110: install plan shown everywhere: "base" or "aggr"
  daySpan: 30,  // D-117: days in the Day view of trend charts: 30, 60 or 90
  momLane: "all",  // D-118: lane shown in the month-on-month tables: "all" or one lane label
  tier: "all",  // D-116: cluster tables show "all", "bau" or "exp" clusters (switch above each table)
  stuckRule: "p90",  // D-111: how 'stuck' is judged everywhere: "p90" (India P90) or "p50x2" (2 x India P50)  // cluster x stage (D-105): our stages or OMS status; active only or + on-hold
});

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    // the month is not restored: every visit opens on the current month (D-67)
    if (s) {
      const filters = Object.fromEntries(FILTER_DIMS.map((d) => [d, asList((s.filters || {})[d])]));  // old single values -> one-item lists
      return { ...defaults(), ...s, month: null, day: null, level: s.level === "city" ? "cluster" : (s.level || "cluster"), filters };
    }
  } catch { /* storage blocked */ }
  return defaults();
}
function store(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }
function read(key) { try { return localStorage.getItem(key); } catch { return null; } }

let state = loadState();
let data = null;
const $ = (id) => document.getElementById(id);

function currentPage() {
  const m = location.hash.match(/^#\/(\w+)/);
  return m && PAGES[m[1]] ? m[1] : "overview";
}

export function setState(patch) {
  state = { ...state, ...patch, filters: { ...state.filters, ...(patch.filters || {}) } };
  store(STORE_KEY, JSON.stringify(state));
  render();
}

// ---------------- sidebar ----------------
function renderNav() {
  const nav = $("side-nav");
  const page = currentPage();
  nav.replaceChildren();
  for (const g of NAV) {
    nav.append(el("div", { class: "nav-group", text: g.group }));
    for (const it of g.items) {
      if (it[0] === "soon") {
        nav.append(el("div", { class: "nav-item disabled", title: `${it[1]}: coming next`, "aria-disabled": "true" }, [icon(it[2]), el("span", { text: it[1] }), el("em", { class: "soon", text: "soon" })]));
      } else {
        const p = PAGES[it[0]];
        nav.append(el("a", { class: `nav-item${it[0] === page ? " active" : ""}`, href: `#/${it[0]}`, title: p.title, "aria-current": it[0] === page ? "page" : null,
          onclick: () => $("app").classList.remove("nav-open") }, [icon(p.icon), el("span", { text: p.nav || p.title })]));
      }
    }
  }
}

function initSidebar() {
  const app = $("app");
  if (read("opsdash.collapsed") === "1") app.classList.add("collapsed");
  $("collapse-toggle").append(icon("chevrons"));
  $("menu-toggle").append(icon("menu"));
  $("theme-toggle").append(icon("sun"));
  const syncCollapseIcon = () => { $("collapse-toggle").style.transform = app.classList.contains("collapsed") ? "scaleX(-1)" : ""; };
  syncCollapseIcon();
  $("collapse-toggle").addEventListener("click", () => {
    app.classList.toggle("collapsed");
    store("opsdash.collapsed", app.classList.contains("collapsed") ? "1" : "0");
    syncCollapseIcon();
    setTimeout(() => window.dispatchEvent(new Event("resize")), 220); // let charts re-fit
  });
  $("menu-toggle").addEventListener("click", () => app.classList.toggle("nav-open"));
}

// ---------------- filters: drawer + chips (D-64; multi-select) ----------------
// Each filter holds a list of labels (empty = all). Ticks in the drawer are staged in `draft` and applied together on
// Done, Escape or a click outside, so a big page isn't redrawn for every tick.
let draft = null;
const openDims = new Set();
const searchText = {};

function filterOptions(dim, filters) {
  const set = new Set();
  const regions = asList(filters.region), clusters = asList(filters.cluster);
  for (const f of [data.p1, data.p2]) {
    const values = f.dims[dim] || [];
    if (dim === "cell" && (regions.length || clusters.length)) {
      // cells only inside the selected regions / clusters
      const ri = f.ci.region, cli = f.ci.cluster, ci = f.ci.cell;
      const rSet = new Set(regions.map((r) => (f.dims.region || []).indexOf(r))), cSet = new Set(clusters.map((c) => (f.dims.cluster || []).indexOf(c)));
      for (const row of f.facts) if ((!regions.length || rSet.has(row[ri])) && (!clusters.length || cSet.has(row[cli]))) set.add(values[row[ci]]);
    } else if (dim === "cluster" && regions.length) {
      const ri = f.ci.region, cli = f.ci.cluster, rSet = new Set(regions.map((r) => (f.dims.region || []).indexOf(r)));
      for (const row of f.facts) if (rSet.has(row[ri])) set.add(values[row[cli]]);
    } else values.forEach((v) => set.add(v));
  }
  return [...set].filter((v) => v && v !== "—" && v !== "Not mapped" && v !== "No cell").sort((a, b) => a.localeCompare(b));
}

const summaryText = (dim, sel) => (!sel.length ? `All ${DIM_LABELS[dim] === "COM" || DIM_LABELS[dim] === "SOH" || DIM_LABELS[dim] === "ZOH" ? `${DIM_LABELS[dim]}s` : `${DIM_LABELS[dim].toLowerCase()}s`}`
  : sel.length <= 2 ? sel.join(", ") : `${sel.slice(0, 2).join(", ")} +${sel.length - 2}`);

function multiField(dim) {
  const sel = asList(draft[dim]);
  const options = filterOptions(dim, draft).concat(sel.filter((s) => !filterOptions(dim, draft).includes(s)));  // keep selections visible
  const summary = el("span", { class: "ms-summary", text: summaryText(dim, sel) });
  const count = el("span", { class: "ms-count", text: sel.length ? String(sel.length) : "" });
  const list = el("div", { class: "ms-list", role: "group", "aria-label": DIM_LABELS[dim] });
  const search = el("input", { type: "search", class: "ms-search", placeholder: `Search ${DIM_LABELS[dim].toLowerCase()}…`, value: searchText[dim] || "", "aria-label": `Search ${DIM_LABELS[dim]}` });
  const refreshSummary = () => { const s = asList(draft[dim]); summary.textContent = summaryText(dim, s); count.textContent = s.length ? String(s.length) : ""; };
  const draw = () => {
    const q = (searchText[dim] || "").toLowerCase(), cur = new Set(asList(draft[dim]));
    list.replaceChildren(...options.filter((o) => !q || o.toLowerCase().includes(q)).map((o) => el("label", { class: "ms-opt" }, [
      el("input", { type: "checkbox", checked: cur.has(o), onchange: (e) => {
        const s = new Set(asList(draft[dim]));
        if (e.target.checked) s.add(o); else s.delete(o);
        draft[dim] = options.filter((x) => s.has(x));
        refreshSummary();
        if (dim === "region" || dim === "cluster") rebuildDependents(dim);
      } }), el("span", { text: o })])));
    if (!list.children.length) list.append(el("div", { class: "count", text: "No match." }));
  };
  search.addEventListener("input", () => { searchText[dim] = search.value; draw(); });
  const allBtn = el("button", { type: "button", class: "ms-link", text: "Select shown", onclick: () => {
    const q = (searchText[dim] || "").toLowerCase(), s = new Set(asList(draft[dim]));
    options.filter((o) => !q || o.toLowerCase().includes(q)).forEach((o) => s.add(o));
    draft[dim] = options.filter((x) => s.has(x)); refreshSummary(); draw(); if (dim === "region" || dim === "cluster") rebuildDependents(dim);
  } });
  const clearBtn = el("button", { type: "button", class: "ms-link", text: "Clear", onclick: () => { draft[dim] = []; refreshSummary(); draw(); if (dim === "region" || dim === "cluster") rebuildDependents(dim); } });
  draw();
  const det = el("details", { class: "ms", "data-dim": dim, open: openDims.has(dim) }, [
    el("summary", {}, [el("span", { class: "ms-label", text: DIM_LABELS[dim] }), summary, count]),
    el("div", { class: "ms-body" }, [el("div", { class: "ms-tools" }, [search, allBtn, clearBtn]), list]),
  ]);
  det.addEventListener("toggle", () => { if (det.open) openDims.add(dim); else openDims.delete(dim); });
  return det;
}

// region narrows clusters and cells; cluster narrows cells: redraw those fields when the draft changes
function rebuildDependents(dim) {
  const body = $("drawer-body");
  for (const dep of dim === "region" ? ["cluster", "cell"] : ["cell"]) {
    const valid = new Set(filterOptions(dep, draft));
    draft[dep] = asList(draft[dep]).filter((v) => valid.has(v));
    const old = body.querySelector(`details.ms[data-dim="${dep}"]`);
    if (old) old.replaceWith(multiField(dep));
  }
}

function renderDrawer() {
  if (!draft) draft = JSON.parse(JSON.stringify(state.filters));
  const body = $("drawer-body");
  const cancelled = el("label", { class: "toggle" }, [
    el("input", { type: "checkbox", checked: state.hideCancelled, onchange: (e) => { applyDraft(); setState({ hideCancelled: e.target.checked }); } }),
    el("div", {}, ["Hide cancelled, on-hold and seeking-cancellation projects", el("small", { text: "HOTO counts drop projects now cancelled, on hold or seeking cancellation (D-42); live counts (not yet installed, pending commissioning, stuck) keep active projects only (D-107)" })]),
  ]);
  body.replaceChildren(el("div", { class: "count", style: { marginBottom: "6px" }, text: "Pick any number of values in each filter; they apply when you press Done." }), ...FILTER_DIMS.map(multiField), cancelled);
}

function renderChips() {
  const chips = $("chips");
  chips.replaceChildren();
  let n = 0;
  for (const dim of FILTER_DIMS) {
    const sel = asList(state.filters[dim]);
    if (!sel.length) continue;
    n += 1;
    const text = sel.length <= 2 ? sel.join(", ") : `${sel.length} selected`;
    chips.append(el("span", { class: "chip", "data-tip": `${DIM_LABELS[dim]}: ${sel.join(", ")}` }, [`${DIM_LABELS[dim]}: ${text}`,
      el("button", { type: "button", "aria-label": `Remove ${DIM_LABELS[dim]} filter`, text: "✕", onclick: () => { draft = null; setState({ filters: { [dim]: [] } }); } })]));
  }
  if (state.hideCancelled) {
    n += 1;
    chips.append(el("span", { class: "chip" }, ["Active projects only", el("button", { type: "button", "aria-label": "Show later-cancelled", text: "✕", onclick: () => setState({ hideCancelled: false }) })]));
  }
  const badge = $("filter-count");
  badge.hidden = n === 0;
  badge.textContent = String(n);
}

function sameFilters(a, b) { return FILTER_DIMS.every((d) => asList(a[d]).join("|") === asList(b[d]).join("|")); }
function applyDraft() {
  if (!draft) return false;
  const next = draft;
  draft = null;
  if (sameFilters(next, state.filters)) return false;
  state = { ...state, filters: { ...next } };  // replace whole lists, not merge
  store(STORE_KEY, JSON.stringify(state));
  return true;
}

function openDrawer(open) {
  $("drawer").classList.toggle("open", open);
  $("drawer").setAttribute("aria-hidden", String(!open));
  $("scrim").hidden = !open;
  if (open) { draft = JSON.parse(JSON.stringify(state.filters)); renderDrawer(); $("drawer").querySelector("summary")?.focus(); }
  else if (applyDraft()) render();
}
function initDrawer() {
  $("filter-open").querySelector(".filter-icon").append(icon("filter"));
  $("filter-open").addEventListener("click", () => openDrawer(true));
  $("filter-close").addEventListener("click", () => openDrawer(false));
  $("filter-done").addEventListener("click", () => openDrawer(false));
  $("scrim").addEventListener("click", () => openDrawer(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("drawer").classList.contains("open")) openDrawer(false); });
  $("filter-reset").addEventListener("click", () => { draft = defaults().filters; renderDrawer(); });
}

// ---------------- render ----------------
function render() {
  if (!data) return;
  const page = currentPage();
  const p = PAGES[page];
  // D-110: the Base / Aggressive switch swaps the install plan every page reads
  if (!data.planRaw) data.planRaw = data.plan;
  const mode = state.planMode === "aggr" ? "aggr" : "base";
  data.planViews = data.planViews || {};
  data.plan = data.planViews[mode] || (data.planViews[mode] = planView(data.planRaw, mode));
  renderNav();
  renderDrawer();
  renderChips();
  const current = defaultMonth(data.meta);  // D-97: the month of the last complete day
  const ctx = monthContext(data.meta, state.month || current);
  $("page-title").textContent = p.title;
  $("page-sub").textContent = ctx.sub;
  ctx.planMode = mode;
  ctx.planName = mode === "aggr" ? "aggressive" : "base";
  ctx.stuckRule = state.stuckRule === "p50x2" ? "p50x2" : "p90";
  const stuckSwitch = el("div", { class: "plan-switch", "data-tip": "How 'stuck' is judged on every page: past the India P90 of that stage (today), or past twice the India P50. 'Ideal TAT' (the team's per-lane target) comes once the per-lane targets are added." }, [
    el("span", { class: "lbl", text: "Stuck" }),
    el("div", { class: "seg", role: "group", "aria-label": "Stuck rule" }, [
      ...[["p90", "P90"], ["p50x2", "2× P50"]].map(([k, t]) => el("button", { type: "button", "aria-pressed": String(ctx.stuckRule === k), text: t, onclick: () => { if (ctx.stuckRule !== k) setState({ stuckRule: k }); } })),
      el("button", { type: "button", class: "seg-off", "aria-pressed": "false", text: "Ideal", "aria-disabled": "true", "data-tip": "Needs the team's ideal install TAT per lane (from Prasanna)" }),
    ]),
  ]);
  const planSwitch = el("div", { class: "plan-switch", "data-tip": "Install plan used across the dashboard: base (target) or aggressive (stretch). HOTO MOP has one version." }, [
    el("span", { class: "lbl", text: "Plan" }),
    el("div", { class: "seg", role: "group", "aria-label": "Install plan" }, [["base", "Base"], ["aggr", "Aggressive"]].map(([k, t]) =>
      el("button", { type: "button", "aria-pressed": String(mode === k), text: t, onclick: () => { if (mode !== k) setState({ planMode: k }); } }))),
  ]);
  if (p.daily) {
    // D-108: one day, yesterday by default; any complete day in the data
    const maxDay = data.meta.as_of_day - 1, minDay = (data.meta.since_day || maxDay - 365) + 7;
    const day = Math.min(maxDay, Math.max(minDay, state.day ?? maxDay));
    ctx.day = day;
    $("page-sub").textContent = `${weekdayOf(day)} ${fmtDay(day)}${day === maxDay ? " (yesterday)" : ""} · complete day · vs the day before and the average of the 7 days before (${fmtDay(day - 7)} – ${fmtDay(day - 1)})`;
    const inp = el("input", { type: "date", class: "month-select day-input", "aria-label": "Day", value: isoOfDay(day), min: isoOfDay(minDay), max: isoOfDay(maxDay) });
    inp.addEventListener("change", () => { const d = dayFromISO(inp.value); if (d != null) setState({ day: d >= maxDay ? null : Math.max(minDay, d) }); });
    const step = (n, txt, lbl) => el("button", { type: "button", class: "icon-btn day-step", text: txt, "aria-label": lbl, disabled: day + n > maxDay || day + n < minDay,
      onclick: () => setState({ day: day + n >= maxDay ? null : day + n }) });
    $("period").replaceChildren(el("div", { class: "day-pick" }, [planSwitch, stuckSwitch, step(-1, "‹", "Previous day"), el("label", { class: "month-pick" }, [icon("calendar"), inp]), step(1, "›", "Next day"),
      day !== maxDay ? el("button", { type: "button", class: "small-btn", text: "Yesterday", onclick: () => setState({ day: null }) }) : null]));
  } else {
    const sel = el("select", { class: "month-select", "aria-label": "Month" },
      monthOptions(data.meta).map((k) => el("option", { value: k, text: k === current ? `${monthLabel(k)} · this month` : monthLabel(k), selected: k === ctx.key })));
    sel.addEventListener("change", () => setState({ month: sel.value === current ? null : sel.value }));
    $("period").replaceChildren(el("div", { class: "day-pick" }, [planSwitch, stuckSwitch, el("label", { class: "month-pick" }, [icon("calendar"), sel])]));
  }
  document.title = `${p.title} · Ops Dashboard`;
  const main = $("page");
  main.replaceChildren();
  try {
    p.mod.render(main, { data, state, setState, ctx });
  } catch (err) {
    console.error(err);
    main.replaceChildren(el("div", { class: "empty", text: `Something went wrong drawing this page: ${err.message}` }));
  }
}

function initTheme() {
  const saved = read("opsdash.theme");
  if (saved) document.documentElement.dataset.theme = saved;
  $("theme-toggle").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store("opsdash.theme", next);
    render();
  });
}

async function init() {
  initTheme();
  initSidebar();
  initDrawer();
  initTooltips();
  try {
    data = await loadAll();
  } catch (err) {
    $("page").replaceChildren(el("div", { class: "empty", text: `Could not load data (${err.message}). Run python -m pipeline.run_all, then reload.` }));
    return;
  }
  const m = data.meta;
  const ext = (m.sections.p1.extracted_at || "").replace("T", " ").slice(0, 16);
  $("asof").textContent = `Data as of ${ext} IST · ${m.fy}`;
  $("footer-src").textContent = `Source: Metabase (SolarSquare DB) · published ${m.generated_at.replace("T", " ").slice(0, 16)}`;
  window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });
  if (!location.hash) location.hash = "#/overview";
  render();
}

init();
