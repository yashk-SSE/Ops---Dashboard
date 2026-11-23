// Needs action (D-110): the exception board that used to sit on the Overview, now its own page. Steps in the order to
// act (D-109): plan -> push to install -> unblock -> after installation -> quality -> customer. Click a card for the list.
import { el, card, dataTable } from "../ui.js";
import { label, matcher, fmtDay, activeFilterDims } from "../data.js";
import { fmtInt, fmtPct, tatSummary, pct, percentile } from "../stats.js";
import * as M from "../metrics.js";
import { glance, momTables, rankings, block, exceptions, pace, openList, fmtKind } from "../layout.js";
import { pushModel, openClusterPanel, countBtn } from "../push.js";
import { p1FactList, p2FactList, p1PendingList, p2PendingList, qhseSiteList, escTicketList, subsidyList } from "../lists.js";

const PLAN_FILTERS = new Set(["region", "cluster"]);  // the plan is per cluster: other filters can't be applied to it

export function render(main, { data, state, setState, ctx }) {
  const { p1, p2, qhse, esc, sub } = data;
  const c1 = p1.ci, c2 = p2.ci, cq = qhse.ci, ce = esc.ci, cs = sub.ci, pci1 = p1.pci, pci2 = p2.pci, asOf = data.meta.as_of_day;
  const p1r = M.p1Rows(data, state), p2r = M.p2Rows(data, state), qr = M.qhseRows(data, state);
  const er = esc.facts.filter(matcher(esc, state.filters, ce)), sr = sub.facts.filter(matcher(sub, state.filters, cs));
  // pre-install cards count ACTIVE projects only, like the pages (on-hold / seeking cancellation can't be pushed; D-112 review)
  const pipe = M.p1Pending(data, state, "active"), pend = M.p2Pending(data, state);
  const inR = M.inRange, last = ctx.last;
  const installStage = (p1.stages.find((s) => s.id === "F07") || p1.stages.at(-1)).id;

  // ---------- metric definitions (one list feeds the tiles, both month-on-month tables and the rankings)
  const inCol = (col) => (rs, r) => rs.filter((x) => inR(x[col], r));
  const closed = (rs, r) => rs.filter((x) => inR(x[c2.commissioned_day], r) && x[c2.tat_days] != null).map((x) => x[c2.tat_days]);
  const audited = inCol(cq.audit_day);
  const trueEsc = (rs, r) => rs.filter((x) => x[ce.true_esc] && inR(x[ce.created_day], r));
  const h2i = (q) => (rs, r) => M.hotoToInstall(data, rs, r)[q];
  const i2c = (q) => (rs, r) => tatSummary(closed(rs, r))[q];
  const pipeAt = (rs, d) => { // not installed as of day d, rebuilt from today's list + HOTO / install dates (cancellations ignored)
    let n = rs.length;
    for (const x of p1r) {
      const h = x[c1.hoto_day], v = x[c1[installStage]], i = v != null && v >= 0 ? h + v : null;
      if (h > d && i == null) n -= 1; else if (h <= d && i != null && i > d) n += 1;
    }
    return n;
  };
  const pendAt = (rs, d) => {
    let n = rs.length;
    for (const x of p2r) {
      const i = x[c2.installed_day], c = x[c2.commissioned_day];
      if (i != null && i > d && c == null) n -= 1; else if (i != null && i <= d && c != null && c > d) n += 1;
    }
    return n;
  };
  const metrics = [
    { id: "hotos", label: "HOTOs", src: "p1", kind: "count", good: "up", kpi: true, value: (rs, r) => inCol(c1.hoto_day)(rs, r).length, pick: inCol(c1.hoto_day), hint: "Sales handover date" },
    { id: "inst", label: "Installations", src: "p2", kind: "count", good: "up", kpi: true, value: (rs, r) => inCol(c2.installed_day)(rs, r).length, pick: inCol(c2.installed_day), hint: "Installation task 039B done" },
    { id: "comm", label: "Commissioned", src: "p2", kind: "count", good: "up", kpi: true, value: (rs, r) => inCol(c2.commissioned_day)(rs, r).length, pick: inCol(c2.commissioned_day) },
    { id: "h2i", label: "HOTO → install P50", src: "p2", kind: "days", good: "down", kpi: true, also: ["h2i75", "h2i90"], value: h2i("p50"), base: (rs, r) => M.hotoToInstall(data, rs, r).count, hint: "Projects installed in the period: days from HOTO to installation" },
    { id: "h2i75", label: "HOTO → install P75", short: "P75", src: "p2", kind: "days", good: "down", value: h2i("p75"), base: (rs, r) => M.hotoToInstall(data, rs, r).count },
    { id: "h2i90", label: "HOTO → install P90", short: "P90", src: "p2", kind: "days", good: "down", value: h2i("p90"), base: (rs, r) => M.hotoToInstall(data, rs, r).count },
    { id: "i2c", label: "Install → commissioning P50", src: "p2", kind: "days", good: "down", kpi: true, also: ["i2c75", "i2c90"], value: i2c("p50"), base: (rs, r) => closed(rs, r).length, hint: "Projects commissioned in the period: days from installation" },
    { id: "i2c75", label: "Install → commissioning P75", short: "P75", src: "p2", kind: "days", good: "down", value: i2c("p75"), base: (rs, r) => closed(rs, r).length },
    { id: "i2c90", label: "Install → commissioning P90", short: "P90", src: "p2", kind: "days", good: "down", value: i2c("p90"), base: (rs, r) => closed(rs, r).length },
    { id: "audited", label: "QHSE sites audited", src: "q", kind: "count", good: "up", kpi: true, value: (rs, r) => audited(rs, r).length, pick: audited },
    { id: "zt", label: "QHSE % sites with ZT", src: "q", kind: "pct", good: "down", value: (rs, r) => { const a = audited(rs, r); return a.length ? pct(a.filter((x) => x[cq.zt]).length, a.length) : null; }, base: (rs, r) => audited(rs, r).length, hint: "Physical-audit Zero Tolerance punch points" },
    { id: "esc", label: "True escalations raised", src: "e", kind: "count", good: "down", kpi: true, minBase: 3, value: (rs, r) => trueEsc(rs, r).length, pick: trueEsc, hint: "L2–L5 + Red Alert" },
    { id: "pipe", label: "Not yet installed", src: "pp", kind: "now", good: "down", kpi: true, value: (rs) => rs.length, pick: (rs) => rs, at: pipeAt, hint: "Handed over, not installed, not cancelled. The 'hide cancelled / on-hold' filter keeps active projects only",
      foot: (rs) => { const n = (s) => rs.filter((x) => label(p1, "state", x[pci1.state]) === s).length; return state.hideCancelled ? `active only · ${fmtInt(rs.filter((x) => x[pci1.days_since_hoto] > 90).length)} over 90 days` : `active ${fmtInt(n("active"))} · on-hold ${fmtInt(n("on-hold"))} · seeking cancellation ${fmtInt(n("seeking-cancellation"))}`; } },
    { id: "pend", label: "Pending commissioning", src: "pc", kind: "now", good: "down", kpi: true, value: (rs) => rs.length, pick: (rs) => rs, at: pendAt, foot: (rs) => `${fmtInt(rs.filter((x) => x[pci2.aging_days] > 30).length)} over 30 days since install` },
    { id: "openMech", label: "Open Z+H mechanical sites", src: "q", kind: "now", good: "down", kpi: true, value: (rs) => rs.filter((x) => x[cq.open_mech] > 0).length, pick: (rs) => rs.filter((x) => x[cq.open_mech] > 0) },
    { id: "subBack", label: "Subsidy backlog", src: "s", kind: "now", good: "down", kpi: true, value: (rs) => rs.filter((x) => x[cs.in_backlog]).length, pick: (rs) => rs.filter((x) => x[cs.in_backlog]) },
  ];
  const sources = {
    p1: { file: p1, ci: c1, rows: p1r, list: p1FactList(p1, installStage) }, p2: { file: p2, ci: c2, rows: p2r, list: p2FactList(p2) },
    q: { file: qhse, ci: cq, rows: qr, list: qhseSiteList(qhse) }, e: { file: esc, ci: ce, rows: er, list: escTicketList(esc) },
    s: { file: sub, ci: cs, rows: sr, list: subsidyList(sub, asOf) },
    pp: { file: p1, ci: pci1, rows: pipe, list: p1PendingList(p1) }, pc: { file: p2, ci: pci2, rows: pend, list: p2PendingList(p2) },
  };
  const links = { hotos: "#/hotos", inst: "#/inst", comm: "#/p2", h2i: "#/p1", i2c: "#/p2", audited: "#/qhse", esc: "#/esc", pipe: "#/p1", pend: "#/p2", openMech: "#/qhse", subBack: "#/sub" };
  const listOf = (src, rows, title, sub2) => () => openList({ title, sub: sub2 || `${fmtInt(rows.length)} projects`, cols: sources[src].list.cols, rows: rows.map(sources[src].list.row), noun: src === "e" ? "tickets" : src === "q" ? "sites" : "projects", filename: `${title.replace(/\W+/g, "_").toLowerCase()}.csv` });

  // ---------- plan (D-98: base = target, aggressive = stretch), per cluster, only when the filters are region / cluster
  const planMonth = (data.plan.months || {})[ctx.key];
  const otherFilters = activeFilterDims(state.filters).filter((k) => !PLAN_FILTERS.has(k));
  const presentClusters = new Set([...p2r.map((x) => label(p2, "cluster", x[c2.cluster])), ...p1r.map((x) => label(p1, "cluster", x[c1.cluster]))]);
  const planClusters = planMonth && !otherFilters.length ? Object.entries(planMonth.clusters).filter(([k]) => presentClusters.has(k)) : [];
  const inPlan = new Set(planClusters.map(([k]) => k));
  const dIdx = Math.min(ctx.dayN, 30) - 1;
  const planRows = planClusters.map(([name, pc]) => {
    const rowsC = p2r.filter((x) => label(p2, "cluster", x[c2.cluster]) === name);
    const mtd = rowsC.filter((x) => inR(x[c2.installed_day], ctx.cur)).length, lm = rowsC.filter((x) => inR(x[c2.installed_day], ctx.prevSame)).length;
    const yday = rowsC.filter((x) => x[c2.installed_day] === last).length;
    const exp = pc.base_cum ? pc.base_cum[dIdx] : Math.round((pc.base_total * ctx.dayN) / ctx.days);
    const proj = exp ? Math.round((mtd / exp) * pc.base_total) : Math.round((mtd / Math.max(1, ctx.dayN)) * ctx.days), projPct = Math.round((100 * proj) / pc.base_total);  // follows the plan curve
    const need = Math.max(0, (pc.base_total - mtd) / Math.max(1, ctx.days - ctx.dayN)), rate = mtd / Math.max(1, ctx.dayN);
    return { name, group: pc.group, plan: pc.base_total, stretch: pc.aggr_total, mtd, exp, gap: mtd - exp, proj, projPct, ready: 0, stuck: 0, ach: pc.base_total ? Math.round((100 * mtd) / pc.base_total) : null, lm, d: lm ? Math.round((1000 * (mtd - lm)) / lm) / 10 : null, need, rate, yday, mop: pc.hoto_mop };
  });
  const sumP = (k) => planRows.reduce((a, r) => a + (r[k] || 0), 0);
  const instPlanMtd = sumP("mtd"), hotoPlanMtd = p1r.filter((x) => inPlan.has(label(p1, "cluster", x[c1.cluster])) && inR(x[c1.hoto_day], ctx.cur)).length;

  // ---------- 2 · needs action (D-99 starting rules)
  const sixFrom = ctx.cols.at(0).range[0], sixTo = ctx.cols.at(-1).range[1];
  const stageP90 = M.stageP90s(data, ctx);  // India-wide yardstick (D-107)
  const push = pushModel(data, state, ctx);
  const goToP1 = (name) => () => { setState({ filters: { cluster: [name] } }); location.hash = "#/p1"; };
  const panelFor = (r) => () => openClusterPanel(r.name, push, data, { planRow: r, goToP1: goToP1(r.name) });
  planRows.forEach((r) => { r.ready = push.ready(r.name).length; r.stuck = push.stuck(r.name).length; });
  const stuck = pipe.filter((x) => { const b = stageP90.get(label(p1, "next_stage", x[pci1.next_stage])); return b != null && x[pci1.days_since_hoto] > b; });
  const stuckBy = new Map(); stuck.forEach((x) => { const k = label(p1, "next_stage", x[pci1.next_stage]); stuckBy.set(k, (stuckBy.get(k) || 0) + 1); });
  const topStuck = [...stuckBy.entries()].sort((a, b) => b[1] - a[1])[0];
  const commP90 = M.commStuckLimit(data, ctx);  // India-wide, by the stuck rule (D-111)
  const R = M.stuckShort(ctx);
  const pendLate = commP90 == null ? [] : pend.filter((x) => x[pci2.aging_days] > commP90);
  const old90 = pipe.filter((x) => x[pci1.days_since_hoto] > 90);
  const r2iP90 = M.rtiInstallP90(data, ctx);
  const rtiWaiting = r2iP90 == null ? [] : pipe.filter((x) => x[pci1.E_RTI] != null && asOf - x[pci1.E_RTI] > r2iP90);
  const ztY = qr.filter((x) => x[cq.zt] && x[cq.audit_day] === last), ztY2 = qr.filter((x) => x[cq.zt] && x[cq.audit_day] === last - 1);
  const escY = er.filter((x) => x[ce.true_esc] && x[ce.created_day] === last), escY2 = er.filter((x) => x[ce.true_esc] && x[ce.created_day] === last - 1);
  const escOpen = er.filter((x) => x[ce.true_esc] && x[ce.is_open]);
  const sub30 = sr.filter((x) => x[cs.in_backlog] && x[cs.stage_day] != null && asOf - x[cs.stage_day] > 30);
  const repeat = (dimKey) => {
    const g = new Map();
    for (const x of qr) {
      if (!x[cq.zt] || x[cq.audit_day] == null || x[cq.audit_day] < last - 29 || x[cq.audit_day] > last) continue;
      const k = `${label(qhse, dimKey, x[cq[dimKey]])}|${label(qhse, "cluster", x[cq.cluster])}`;
      if (!g.has(k)) g.set(k, []); g.get(k).push(x);
    }
    return [...g.entries()].filter(([k, xs]) => xs.length >= 2 && !k.startsWith("|") && !k.startsWith("Not mapped")).map(([k, xs]) => ({ name: k.split("|")[0], cluster: k.split("|")[1], zt: xs.length, sites: xs.map((x) => x[cq.sseid]).join(", ") }));
  };
  const icRep = repeat("ic"), venRep = repeat("vendor");
  const behind = planRows.filter((r) => r.projPct < 90), behindBad = planRows.filter((r) => r.projPct < 75);
  const nameList = (title, rows, cols) => () => openList({ title, sub: `${rows.length} rows`, cols, rows, filename: `${title.replace(/\W+/g, "_").toLowerCase()}.csv` });
  const exc = [];
  if (ctx.live && planRows.length) exc.push({ group: "plan", label: "Clusters behind the install plan", value: behind.length, tone: behindBad.length ? "bad" : behind.length ? "warn" : "ok",
    sub: behindBad.length ? `${behindBad.length} below 75% of install plan MTD` : behind.length ? "below 90% of install plan MTD" : "all at 90%+ of install plan MTD",
    rule: "Installations vs the base install plan (Install Plan sheet; not the HOTO MOP): installs so far below 90% of the plan MTD (red below 75%). Plan MTD follows the plan's daily curve. The list shows each cluster's ready-to-install and stuck projects",
    onClick: nameList("Clusters behind the install plan", behind.sort((a, b) => a.projPct - b.projPct).map((r) => ({ ...r, ready: push.ready(r.name).length, stuck: push.stuck(r.name).length })),
      [{ key: "name", label: "Cluster" }, { key: "plan", label: "Month plan", num: true }, { key: "exp", label: "Plan MTD", num: true }, { key: "mtd", label: "Installs MTD", num: true },
        { key: "projPct", label: "% achieved", num: true }, { key: "gap", label: "Behind by", num: true },
        { key: "ready", label: "Ready to install", num: true }, { key: "stuck", label: "Stuck", num: true },
        { key: "rate", label: "Now / day", num: true, fmt: (x) => x.toFixed(1) }, { key: "need", label: "Required Run Rate", num: true, tip: "(Month target − done so far) ÷ days left in the month", fmt: (x) => x.toFixed(1) }]) });
  const rtiDays = r2iP90 == null ? null : Math.round(r2iP90);
  exc.push({ group: "push", label: rtiDays == null ? "Ready to install, waiting too long" : `Ready to install, waiting > ${rtiDays} days`, value: rtiWaiting.length, tone: rtiWaiting.length ? "bad" : "ok",
    sub: rtiDays != null ? `active · RTI done more than ${rtiDays} days ago (${M.stuckShort(ctx)} of RTI → install)` : null,
    rule: `Active projects with design approved, sanction letter and payment ready (RTI) that are still not installed beyond the RTI → install limit (${M.stuckShort(ctx)}, India, HOTOs of the last 6 full months): schedule these first. All ready-to-install projects, however recent, are in the Installations page's 'Ready to install' column`,
    onClick: listOf("pp", [...rtiWaiting].sort((a, b) => a[pci1.E_RTI] - b[pci1.E_RTI]), rtiDays == null ? "Ready to install, waiting too long" : `Ready to install, waiting more than ${rtiDays} days`) });
  exc.push({ group: "unblock", label: "Stuck before installation", value: stuck.length, tone: stuck.length ? "bad" : "ok", sub: topStuck ? `most at ${topStuck[0]} (${fmtInt(topStuck[1])})` : null,
    rule: `Active projects waiting longer than their stage's limit in days from HOTO (${M.stuckShort(ctx)}, India, HOTOs of the last 6 full months)`, onClick: listOf("pp", stuck.sort((a, b) => b[pci1.days_since_hoto] - a[pci1.days_since_hoto]), "Stuck before installation") });
  exc.push({ group: "unblock", label: "Not installed > 90 days", value: old90.length, tone: old90.length ? "bad" : "ok", sub: "active", rule: "Active projects handed over more than 90 days ago, still not installed", onClick: listOf("pp", old90, "Not installed more than 90 days after HOTO") });
  exc.push({ group: "after", label: `Commissioning past ${R}`, value: pendLate.length, tone: pendLate.length ? "bad" : "ok", sub: commP90 != null ? `${R} = ${Math.round(commP90)} days after install` : null,
    rule: `Installed, not commissioned, waiting longer than the install → commissioning ${R} (India, last 6 full months)`, onClick: listOf("pc", pendLate, "Commissioning past P90") });
  exc.push({ group: "quality", label: "ZT punch points yesterday", value: ztY.length, tone: ztY.length ? "bad" : "ok", sub: `day before: ${fmtInt(ztY2.length)}`, rule: `Sites audited on ${fmtDay(last)} with a Zero Tolerance point (physical audit)`, onClick: listOf("q", ztY, "Sites with ZT punch points yesterday") });
  exc.push({ group: "quality", label: "ICs with 2+ ZT in 30 days", value: icRep.length, tone: icRep.length ? "bad" : "ok", sub: "consider warning / PIP", rule: "Same IC name in the same cluster, 2+ sites with ZT in the trailing 30 days",
    onClick: nameList("ICs with 2+ ZT in 30 days", icRep, [{ key: "name", label: "IC" }, { key: "cluster", label: "Cluster" }, { key: "zt", label: "ZT sites", num: true }, { key: "sites", label: "SSE IDs" }]) });
  exc.push({ group: "quality", label: "Vendors with 2+ ZT in 30 days", value: venRep.length, tone: venRep.length ? "bad" : "ok", sub: "put under training", rule: "Same vendor in the same cluster, 2+ sites with ZT in the trailing 30 days",
    onClick: nameList("Vendors with 2+ ZT in 30 days", venRep, [{ key: "name", label: "Vendor" }, { key: "cluster", label: "Cluster" }, { key: "zt", label: "ZT sites", num: true }, { key: "sites", label: "SSE IDs" }]) });
  exc.push({ group: "customer", label: "True escalations yesterday", value: escY.length, tone: escY.length ? "bad" : "ok", sub: `day before: ${fmtInt(escY2.length)} · open now: ${fmtInt(escOpen.length)}`, rule: "L2–L5 or Red Alert tickets raised yesterday", onClick: listOf("e", escY.concat(escOpen.filter((x) => !escY.includes(x))), "True escalations: yesterday and open") });
  exc.push({ group: "after", label: "Subsidy stuck > 30 days", value: sub30.length, tone: sub30.length ? "warn" : "ok", rule: "In the same subsidy stage for more than 30 days", onClick: listOf("s", sub30, "Subsidy stuck more than 30 days in a stage") });
  main.append(block(1, "Needs action", "In the order to act · worst first in each row · click a card for the list · hover for the rule",
    exceptions(exc, [["plan", "Plan"], ["push", "Push to install"], ["unblock", "Unblock the pipeline"], ["after", "After installation"], ["quality", "Quality"], ["customer", "Customer"]])));

}
