// Yesterday (D-108): everything Ops did on one day (yesterday by default; any past day from the date picker),
// compared with the day before, the average of the 7 days before it and, where a plan exists, the day's plan.
// Counts are events dated that day (IST). Backlogs are rebuilt as of the end of that day from the dates.
import { el, card, dataTable } from "../ui.js";
import { label, fmtDay, monthKey, monthBounds, matcher, activeFilterDims, weekdayOf } from "../data.js";
import { fmtInt } from "../stats.js";
import * as M from "../metrics.js";
import { block, openList, wire } from "../layout.js";
import { p1FactList, p2FactList, qhseSiteList, escTicketList, subsidyList } from "../lists.js";

const PLAN_FILTERS = new Set(["region", "cluster"]);
const GROUP_COLOR = { flow: "--g-volume", quality: "--g-quality", backlog: "--g-now" };

export function render(main, { data, state, ctx }) {
  const day = ctx.day, asOf = data.meta.as_of_day;
  const { p1, p2, qhse, esc, sub } = data;
  const c1 = p1.ci, c2 = p2.ci, cq = qhse.ci, ce = esc.ci, cs = sub.ci, pci1 = p1.pci, pci2 = p2.pci;
  const p1r = M.p1Rows(data, state), p2r = M.p2Rows(data, state), qr = M.qhseRows(data, state);
  const er = esc.facts.filter(matcher(esc, state.filters, ce)), sr = sub.facts.filter(matcher(sub, state.filters, cs));
  const installStage = (p1.stages.find((s) => s.id === "F07") || p1.stages.at(-1)).id;
  const stageDay = (sid) => (x) => { const v = x[c1[sid]]; return v != null && v >= 0 ? x[c1.hoto_day] + v : null; };
  const lists = { p1: p1FactList(p1, installStage), p2: p2FactList(p2), q: qhseSiteList(qhse), e: escTicketList(esc), s: subsidyList(sub, asOf) };
  const files = { p1, p2, q: qhse, e: esc, s: sub }, cis = { p1: c1, p2: c2, q: cq, e: ce, s: cs };
  const rowsOf = { p1: p1r, p2: p2r, q: qr, e: er, s: sr };
  const dayTxt = (d) => `${weekdayOf(d)} ${fmtDay(d)}`;

  // ---------- plan for the day (install plan's daily figure; MOP / days in month), plan clusters, region / cluster filters only
  const mKey = monthKey(day), [mA, mB] = monthBounds(mKey), daysInMonth = mB - mA + 1, dIdx = day - mA;
  const planMonth = (data.plan.months || {})[mKey];
  const otherFilters = activeFilterDims(state.filters).filter((k) => !PLAN_FILTERS.has(k));
  const present = new Set([...p2r.map((x) => label(p2, "cluster", x[c2.cluster])), ...p1r.map((x) => label(p1, "cluster", x[c1.cluster]))]);
  const planClusters = planMonth && !otherFilters.length ? Object.entries(planMonth.clusters).filter(([k]) => present.has(k)) : [];
  const inPlan = new Set(planClusters.map(([k]) => k));
  const instPlanOf = (pc, d) => { const i = d - mA; if (i < 0 || i >= daysInMonth) return null; return pc.base_cum ? pc.base_cum[i] - (i ? pc.base_cum[i - 1] : 0) : pc.base_total / daysInMonth; };
  const hotoPlanOf = (pc) => (pc.hoto_mop || 0) / daysInMonth;
  const planFor = { inst: (d) => (planClusters.length && monthKey(d) === mKey ? planClusters.reduce((a, [, pc]) => a + (instPlanOf(pc, d) || 0), 0) : null),
    hotos: () => (planClusters.length ? planClusters.reduce((a, [, pc]) => a + hotoPlanOf(pc), 0) : null) };

  // ---------- metric definitions: events dated that day
  const hotoAge = (x) => { const a = monthKey(x[c2.installed_day]), b = monthKey(x[c2.hoto_day] ?? x[c2.installed_day]); const n = (Number(a.slice(0, 4)) - Number(b.slice(0, 4))) * 12 + Number(a.slice(5)) - Number(b.slice(5)); return Math.min(2, Math.max(0, n)); };
  const flow = [
    { id: "hotos", label: "HOTOs", src: "p1", at: (x) => x[c1.hoto_day], plan: "hotos", planRows: (x) => inPlan.has(label(p1, "cluster", x[c1.cluster])), hint: "Sales handover that day" },
    { id: "design", label: "Design approvals", src: "p1", at: (x) => x[c1.cx_design_day], hint: "Customer design approval (task 020) done that day" },
    { id: "sanction", label: "Sanctions", src: "p1", at: (x) => x[c1.sanction_day], hint: "Sanction letter (NM105 / NM105A / NM008) done that day" },
    { id: "payready", label: "Payment ready", src: "p1", at: stageDay("F03"), hint: "Payment 1 ready that day (Direct 025A / 025B; NBFC lender RFD or E004A; PSU PSUN004)" },
    { id: "erp", label: "ERP raised", src: "p1", at: stageDay("F05"), hint: "BOM created (task 022) that day" },
    { id: "planned", label: "Installations planned", src: "p1", at: stageDay("F06"), hint: "Installation scheduled (task 032B / NM054C) that day" },
    { id: "inst", label: "Installations", src: "p2", at: (x) => x[c2.installed_day], plan: "inst", planRows: (x) => inPlan.has(label(p2, "cluster", x[c2.cluster])), hint: "Installation (039B) done that day",
      foot: (xs) => { const a = [0, 1, 2].map((k) => xs.filter((x) => hotoAge(x) === k).length); return `M0 ${fmtInt(a[0])} · M1 ${fmtInt(a[1])} · M2+ ${fmtInt(a[2])}`; } },
    { id: "comm", label: "Commissioned", src: "p2", at: (x) => x[c2.commissioned_day], hint: "Commissioned that day" },
  ];
  const quality = [
    { id: "audited", label: "QHSE sites audited", src: "q", at: (x) => x[cq.audit_day], hint: "Physical audits done that day" },
    { id: "zt", label: "Sites with ZT", src: "q", at: (x) => (x[cq.zt] ? x[cq.audit_day] : null), good: "down", hint: "Audited that day with a Zero Tolerance punch point" },
    { id: "zh", label: "Sites with ZT + High", src: "q", at: (x) => (x[cq.zh] ? x[cq.audit_day] : null), good: "down", hint: "Audited that day with a ZT or High punch point" },
    { id: "rect", label: "Sites rectified", src: "q", at: (x) => x[cq.rect_day], hint: "Punch points closed (rectification done) that day" },
    { id: "escRaised", label: "Tickets raised", src: "e", at: (x) => x[ce.created_day], good: "down", hint: "Operations escalation tickets created that day (all levels)" },
    { id: "trueEsc", label: "True escalations raised", src: "e", at: (x) => (x[ce.true_esc] ? x[ce.created_day] : null), good: "down", hint: "L2–L5 + Red Alert tickets created that day" },
    { id: "escClosed", label: "Tickets closed", src: "e", at: (x) => x[ce.closed_day], hint: "Tickets closed or resolved that day" },
    { id: "disb", label: "Subsidy disbursed", src: "s", at: (x) => x[cs.disbursed_day], hint: "Moved to 'Subsidy Disbursed' that day (OMS records these in batches)" },
  ];

  // index each metric's rows by day for the window [day-7, day]
  const lo = day - 7;
  const indexed = (m) => {
    const by = new Map();
    for (const x of rowsOf[m.src]) { const d = m.at(x); if (d != null && d >= lo && d <= day) { if (!by.has(d)) by.set(d, []); by.get(d).push(x); } }
    return by;
  };
  const series = new Map([...flow, ...quality].map((m) => [m.id, indexed(m)]));
  const rowsAt = (m, d) => series.get(m.id).get(d) || [];
  const avg7 = (m) => { let s = 0; for (let d = day - 7; d <= day - 1; d++) s += rowsAt(m, d).length; return s / 7; };

  const openRows = (m, xs, title) => openList({ title, sub: `${fmtInt(xs.length)} ${m.src === "e" ? "tickets" : m.src === "q" ? "sites" : "projects"} · ${dayTxt(day)}`,
    cols: lists[m.src].cols, rows: xs.map(lists[m.src].row), noun: m.src === "e" ? "tickets" : m.src === "q" ? "sites" : "projects", filename: `${m.id}_${fmtDay(day).replace(/ /g, "")}.csv` });

  const pctTone = (p) => (p == null ? "flat" : p >= 90 ? "good" : p >= 75 ? "warn" : "bad");
  const tile = (m, group) => {
    const xs = rowsAt(m, day), v = xs.length, b = rowsAt(m, day - 1).length, a = avg7(m);
    const good = m.good || "up";
    const dB = M.delta(v, b, "count", good), dA = M.delta(v, a, "count", good);
    const node = el("div", { class: "card metric day-tile", style: { "--group": `var(${GROUP_COLOR[group]})` } }, [
      el("div", { class: "m-label", text: m.label }),
      el("div", { class: "m-row" }, [el("span", { class: "m-value", text: fmtInt(v) }), dB ? el("span", { class: `delta ${dB.tone}`, text: `${dB.arrow} ${dB.text}` }) : null]),
      el("div", { class: "m-prev", text: `day before: ${fmtInt(b)}` }),
      el("div", { class: "m-prev" }, [`7-day avg: ${a.toFixed(1)}`, dA ? el("span", { class: `delta small ${dA.tone}`, text: `${dA.arrow} ${dA.text}` }) : null]),
    ]);
    if (m.plan) {
      const plan = planFor[m.plan](day);
      if (plan != null) {
        const inP = xs.filter(m.planRows).length, p = plan ? Math.round((100 * inP) / plan) : null;
        node.append(el("div", { class: "m-foot day-plan" }, [`plan ${fmtInt(Math.round(plan))}${planClusters.length < present.size ? ` (${planClusters.length} plan clusters: ${fmtInt(inP)} done)` : ""} · `, el("b", { class: pctTone(p), text: p == null ? "–" : `${p}% achieved` })]));
      }
    }
    if (m.foot) node.append(el("div", { class: "m-foot", text: m.foot(xs) }));
    node.setAttribute("data-tip", [`${m.label} on ${dayTxt(day)}: ${fmtInt(v)}`, m.hint || "", `Day before (${dayTxt(day - 1)}): ${fmtInt(b)}`,
      `Average of the 7 days before (${fmtDay(day - 7)} – ${fmtDay(day - 1)}): ${a.toFixed(1)}`,
      m.plan === "inst" ? "Plan = the install plan's figure for that day (its daily curve), plan clusters only" : m.plan === "hotos" ? "Plan = the month's MOP ÷ days in the month, plan clusters only" : "",
      "Click the number for the list"].filter(Boolean).join("\n"));
    wire(node, xs.length ? () => openRows(m, xs, `${m.label} · ${dayTxt(day)}`) : null, null);
    return node;
  };

  if (day > asOf - 1) main.append(el("div", { class: "count", text: "Today is not complete yet; pick yesterday or an earlier day." }));

  // ---------- 1 · project flow
  main.append(block(1, `Project flow on ${dayTxt(day)}`, "Each number = events dated that day · chip = vs the day before · second chip = vs the average of the 7 days before · click a number for its projects",
    el("div", { class: "grid metrics" }, flow.map((m) => tile(m, "flow")))));

  // ---------- 2 · quality and customer
  main.append(block(2, "Quality and customer", "QHSE physical audits, escalation tickets (Operations) and subsidy disbursals that day",
    el("div", { class: "grid metrics" }, quality.map((m) => tile(m, "quality")))));

  // ---------- 3 · backlog at the end of the day (rebuilt from dates)
  const pipeNow = M.p1Pending(data, state), pendNow = M.p2Pending(data, state);
  const pipeAt = (d) => { let n = pipeNow.length; for (const x of p1r) { const h = x[c1.hoto_day], v = x[c1[installStage]], i = v != null && v >= 0 ? h + v : null; if (h > d && i == null) n -= 1; else if (h <= d && i != null && i > d) n += 1; } return n; };
  const pendAt = (d) => { let n = pendNow.length; for (const x of p2r) { const i = x[c2.installed_day], c = x[c2.commissioned_day]; if (i != null && i > d && c == null) n -= 1; else if (i != null && i <= d && c != null && c > d) n += 1; } return n; };
  const openEscAt = (d, onlyTrue) => er.filter((x) => (!onlyTrue || x[ce.true_esc]) && x[ce.created_day] != null && x[ce.created_day] <= d && (x[ce.closed_day] != null ? x[ce.closed_day] > d : x[ce.is_open]));
  const backlog = [
    { label: "Not yet installed", at: pipeAt, hint: "Handed over, not installed, at the end of the day. Rebuilt from today's list and the HOTO / install dates; projects cancelled since then can't be added back" },
    { label: "Pending commissioning", at: pendAt, hint: "Installed, not commissioned, at the end of the day. Rebuilt from today's list and the install / commissioning dates" },
    { label: "Open escalation tickets", at: (d) => openEscAt(d, false).length, list: (d) => openEscAt(d, false), hint: "Created on or before the day, not closed by its end" },
    { label: "Open true escalations", at: (d) => openEscAt(d, true).length, list: (d) => openEscAt(d, true), hint: "L2–L5 + Red Alert, created on or before the day, not closed by its end" },
  ];
  main.append(block(3, `Backlog at the end of ${dayTxt(day)}`, "As it stood that night · chip = vs the end of the day before · lower is better",
    el("div", { class: "grid metrics" }, backlog.map((b) => {
      const v = b.at(day), y = b.at(day - 1); let s = 0; for (let d = day - 7; d <= day - 1; d++) s += b.at(d); const a = s / 7;
      const dB = M.delta(v, y, "count", "down"), dA = M.delta(v, a, "count", "down");
      const node = el("div", { class: "card metric day-tile", style: { "--group": `var(${GROUP_COLOR.backlog})` }, "data-tip": `${b.label} at the end of ${dayTxt(day)}: ${fmtInt(v)}\n${b.hint}` }, [
        el("div", { class: "m-label", text: b.label }),
        el("div", { class: "m-row" }, [el("span", { class: "m-value", text: fmtInt(v) }), dB ? el("span", { class: `delta ${dB.tone}`, text: `${dB.arrow} ${dB.text}` }) : null]),
        el("div", { class: "m-prev", text: `end of day before: ${fmtInt(y)}` }),
        el("div", { class: "m-prev" }, [`7-day avg: ${fmtInt(Math.round(a))}`, dA ? el("span", { class: `delta small ${dA.tone}`, text: `${dA.arrow} ${dA.text}` }) : null]),
      ]);
      if (b.list) wire(node, () => { const xs = b.list(day); openList({ title: `${b.label} · end of ${dayTxt(day)}`, sub: `${fmtInt(xs.length)} tickets`, cols: lists.e.cols, rows: xs.map(lists.e.row), noun: "tickets", filename: `open_tickets_${fmtDay(day).replace(/ /g, "")}.csv` }); }, null);
      return node;
    }))));

  // ---------- 4 · by cluster
  const cols = [...flow.filter((m) => ["hotos", "design", "sanction", "payready", "inst", "comm"].includes(m.id)), ...quality.filter((m) => ["audited", "zt", "trueEsc"].includes(m.id))];
  const clusterOf = (m, x) => label(files[m.src], "cluster", x[cis[m.src].cluster]);
  const byCl = new Map();  // cluster -> metric id -> rows
  for (const m of cols) for (const x of rowsAt(m, day)) { const k = clusterOf(m, x); if (!k || k === "—" || k === "Not mapped") continue; if (!byCl.has(k)) byCl.set(k, {}); (byCl.get(k)[m.id] ||= []).push(x); }
  for (const k of present) if (k && k !== "—" && k !== "Not mapped" && !byCl.has(k)) byCl.set(k, {});
  const planOf = new Map(planClusters);
  const rows = [...byCl.entries()].map(([name, ms]) => {
    const r = { name, ms };
    for (const m of cols) r[m.id] = (ms[m.id] || []).length;
    const pc = planOf.get(name);
    r.instPlan = pc ? instPlanOf(pc, day) : null; r.hotoPlan = pc ? hotoPlanOf(pc) : null;
    r.instPct = r.instPlan ? Math.round((100 * r.inst) / r.instPlan) : null; r.hotoPct = r.hotoPlan ? Math.round((100 * r.hotos) / r.hotoPlan) : null;
    r.short = r.instPlan != null ? r.inst - r.instPlan : null;
    return r;
  }).filter((r) => cols.some((m) => r[m.id]) || r.instPlan);
  rows.sort((a, b) => (a.short == null) - (b.short == null) || (a.short ?? 0) - (b.short ?? 0) || b.inst - a.inst);
  const cnt = (m) => (n, r) => (r.footer ? fmtInt(n) : n ? el("button", { type: "button", class: "link-btn", text: fmtInt(n), onclick: (e) => { e.stopPropagation(); openRows(m, r.ms[m.id], `${r.name} · ${m.label} · ${dayTxt(day)}`); } }) : el("span", { class: "count", text: "0" }));
  const vsPlan = (key, planKey) => (p, r) => (r[planKey] == null ? "–" : el("span", { class: `band-${pctTone(p) === "flat" ? "good" : pctTone(p)}`, text: `${p}% of ${r[planKey] < 10 ? r[planKey].toFixed(1) : Math.round(r[planKey])}` }));
  const tot = { footer: true, name: "All clusters" };
  for (const m of cols) tot[m.id] = rows.reduce((a, r) => a + r[m.id], 0);
  const sumPlan = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  tot.instPlan = planClusters.length ? sumPlan("instPlan") : null; tot.hotoPlan = planClusters.length ? sumPlan("hotoPlan") : null;
  const instInPlan = rows.filter((r) => r.instPlan != null).reduce((a, r) => a + r.inst, 0), hotoInPlan = rows.filter((r) => r.hotoPlan != null).reduce((a, r) => a + r.hotos, 0);
  tot.instPct = tot.instPlan ? Math.round((100 * instInPlan) / tot.instPlan) : null; tot.hotoPct = tot.hotoPlan ? Math.round((100 * hotoInPlan) / tot.hotoPlan) : null;
  const byId = Object.fromEntries(cols.map((m) => [m.id, m]));
  const table = dataTable([
    { key: "name", label: "Cluster" },
    { key: "hotos", label: "HOTOs", num: true, fmt: cnt(byId.hotos) },
    { key: "hotoPct", label: "HOTOs vs MOP", num: true, tip: "HOTOs that day ÷ (the month's MOP ÷ days in month); plan clusters only", fmt: vsPlan("hotos", "hotoPlan") },
    { key: "design", label: "Design approvals", num: true, fmt: cnt(byId.design) },
    { key: "sanction", label: "Sanctions", num: true, fmt: cnt(byId.sanction) },
    { key: "payready", label: "Payment ready", num: true, fmt: cnt(byId.payready) },
    { key: "inst", label: "Installs", num: true, fmt: cnt(byId.inst) },
    { key: "instPct", label: "Installs vs plan", num: true, tip: "Installs that day ÷ the install plan's figure for that day; plan clusters only", fmt: vsPlan("inst", "instPlan") },
    { key: "comm", label: "Commissioned", num: true, fmt: cnt(byId.comm) },
    { key: "audited", label: "Sites audited", num: true, fmt: cnt(byId.audited) },
    { key: "zt", label: "ZT sites", num: true, fmt: cnt(byId.zt) },
    { key: "trueEsc", label: "True escalations", num: true, fmt: cnt(byId.trueEsc) },
  ], rows, { maxHeight: 620, footer: tot });
  main.append(block(4, `By cluster on ${dayTxt(day)}`, planClusters.length ? "Plan clusters furthest below the day's install plan first · click a number for its projects" : "Biggest first · click a number for its projects (no plan for this month or these filters)",
    (() => { const c = card("Every cluster that day", "Counts of events dated that day · % = done ÷ that day's plan", table); c.classList.add("day-cl"); return c; })()));
}
