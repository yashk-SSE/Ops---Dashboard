// Push list (D-107): for clusters behind the install plan, which projects to push and which to clean up.
// Ready to install = RTI done (design approved, sanction letter, payment ready), not installed: push these to installation now.
// Stuck = waiting longer than the P90 days from HOTO for its 'waiting for' stage (India-wide yardstick, M.stageP90s): clean up.
// Active projects only (on-hold and seeking-cancellation projects are not pushed).
import { el, dataTable } from "./ui.js";
import { label } from "./data.js";
import { fmtInt } from "./stats.js";
import * as M from "./metrics.js";
import { openList, openPanel } from "./layout.js";
import { p1PendingList } from "./lists.js";

export function pushModel(data, state, ctx) {
  const f = data.p1, pci = f.pci;
  const p90 = M.stageP90s(data, ctx);
  const act = M.p1Pending(data, state, "active");
  const stageOf = (x) => label(f, "next_stage", x[pci.next_stage]);
  const isStuck = (x) => { const b = p90.get(stageOf(x)); return b != null && x[pci.days_since_hoto] > b; };
  const isReady = (x) => x[pci.E_RTI] != null;
  const byCluster = new Map();
  for (const x of act) {
    const k = label(f, "cluster", x[pci.cluster]);
    if (!byCluster.has(k)) byCluster.set(k, []);
    byCluster.get(k).push(x);
  }
  const list = p1PendingList(f);
  const sortOld = (xs) => [...xs].sort((a, b) => b[pci.days_since_hoto] - a[pci.days_since_hoto]);
  const of = (name) => byCluster.get(name) || [];
  const model = {
    p90, stageOf, isStuck, isReady, of, clusters: [...byCluster.keys()],
    ready: (name) => of(name).filter(isReady),
    stuck: (name) => of(name).filter(isStuck),
    openRows: (title, xs, back) => openList({ title, sub: `${fmtInt(xs.length)} projects · active · oldest HOTO first`, cols: list.cols, rows: sortOld(xs).map(list.row),
      filename: `${title.replace(/\W+/g, "_").toLowerCase()}.csv`, back }),
  };
  return model;
}

/** Clickable count that opens the list (stops the click reaching the table row). */
export function countBtn(n, onClick) {
  if (!n) return el("span", { class: "count", text: "0" });
  return el("button", { type: "button", class: "link-btn", text: fmtInt(n), onclick: (e) => { e.stopPropagation(); onClick(); } });
}

/**
 * Cluster panel: plan line, ready / stuck / all tiles, and where the cluster's pipeline waits by stage (each count opens its list,
 * with Back to this panel). `planRow` (optional) = {mtd, exp, plan, need, rate}; `goToP1` (optional) opens the HOTO -> Install page for it.
 */
export function openClusterPanel(name, model, data, { planRow, goToP1 } = {}) {
  const show = () => {
    const all = model.of(name), ready = all.filter(model.isReady), stuck = all.filter(model.isStuck);
    const back = () => show();
    const open = (title, xs) => () => model.openRows(`${name} · ${title}`, xs, back);
    const tile = (n, lbl, hint, xs, tone) => el("button", { type: "button", class: `push-tile ${tone || ""}`, onclick: open(lbl, xs), disabled: !n },
      [el("span", { class: "push-n", text: fmtInt(n) }), el("span", { class: "push-l", text: lbl }), el("small", { text: hint })]);
    const order = data.p1.stages.map((s) => s.name);
    const stages = [...new Set(all.map(model.stageOf))].sort((a, b) => ((order.indexOf(a) + 100) % 100) - ((order.indexOf(b) + 100) % 100));
    const rows = stages.map((s) => {
      const xs = all.filter((x) => model.stageOf(x) === s), st = xs.filter(model.isStuck), b = model.p90.get(s);
      return { stage: s.replace(" (P1 collected / RFD)", ""), xs, st, n: xs.length, nStuck: st.length, p90: b == null ? null : Math.round(b),
        oldest: xs.length ? Math.max(...xs.map((x) => x[data.p1.pci.days_since_hoto])) : null };
    });
    const table = dataTable([
      { key: "stage", label: "Waiting for" },
      { key: "n", label: "Projects", num: true, fmt: (n, r) => countBtn(n, open(`waiting for ${r.stage}`, r.xs)) },
      { key: "nStuck", label: "Stuck", num: true, tip: "Waiting longer than the stage's limit in days from HOTO (the stuck rule in the top bar: India P90 or 2 × P50, HOTOs of the last 6 full months)", fmt: (n, r) => countBtn(n, open(`stuck at ${r.stage}`, r.st)) },
      { key: "p90", label: "Limit (days from HOTO)", num: true, fmt: (v) => (v == null ? "–" : String(v)) },
      { key: "oldest", label: "Oldest (days)", num: true, fmt: (v) => (v == null ? "–" : String(v)) },
    ], rows, { maxHeight: 420 });
    const planLine = planRow ? el("div", { class: "push-plan" }, [
      el("b", { text: `${fmtInt(planRow.mtd)} installed` }), ` of plan MTD ${fmtInt(planRow.exp)} (${planRow.exp ? Math.round((100 * planRow.mtd) / planRow.exp) : "–"}%) · month plan ${fmtInt(planRow.plan)} · needs ${planRow.need.toFixed(1)}/day vs ${planRow.rate.toFixed(1)}/day now`]) : null;
    openPanel({ title: `${name}: what to push`, sub: "Active projects not yet installed · live · click a number for its projects",
      body: el("div", { class: "push-panel" }, [
        planLine,
        el("div", { class: "push-tiles" }, [
          tile(ready.length, "Ready to install", "RTI done: design, sanction and payment ready. Push to install now", ready, "good"),
          tile(stuck.length, "Stuck", "Past its stage's limit (stuck rule in the top bar). Clean up or escalate", stuck, "bad"),
          tile(all.length, "Not installed", "All active projects handed over and not installed", all, ""),
        ]),
        el("h3", { class: "push-h", text: "Where it waits" }),
        table,
        goToP1 ? el("button", { type: "button", class: "small-btn", style: { marginTop: "12px" }, text: `Open HOTO → Installation filtered to ${name}`, onclick: goToP1 }) : null,
      ]) });
  };
  show();
}
