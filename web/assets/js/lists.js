// Project lists behind the numbers (D-94 drill-down): one column set per published source.
// Each returns {cols, row}: cols for projectList(), row(x) turns a fact row into a display object. SSE IDs only, no customer fields.
import { label, fmtDay } from "./data.js";

const dim = (f, c, k) => (x) => label(f, k, x[c[k]]);
const day = { fmt: fmtDay, csv: fmtDay };
const base = [{ key: "sseid", label: "SSE ID" }, { key: "cluster", label: "Cluster" }, { key: "cell", label: "Cell" }, { key: "lane", label: "Lane" }, { key: "com", label: "COM" }, { key: "zoh", label: "ZOH" }];
const baseRow = (f, c, x) => ({ sseid: x[c.sseid], cluster: dim(f, c, "cluster")(x), cell: dim(f, c, "cell")(x), lane: dim(f, c, "lane")(x), com: dim(f, c, "com")(x), zoh: dim(f, c, "zoh")(x) });

export function p1FactList(f, installStage) {
  const c = f.ci;
  return {
    cols: [...base, { key: "hoto", label: "HOTO", ...day }, { key: "installed", label: "Installed", ...day }, { key: "state", label: "Project state" }],
    row: (x) => { const d = installStage ? x[c[installStage]] : null; return { ...baseRow(f, c, x), hoto: x[c.hoto_day], installed: d != null && d >= 0 ? x[c.hoto_day] + d : null, state: dim(f, c, "state")(x) }; },
  };
}
export function p2FactList(f) {
  const c = f.ci;
  return {
    cols: [...base, { key: "hoto", label: "HOTO", ...day }, { key: "installed", label: "Installed", ...day }, { key: "commissioned", label: "Commissioned", ...day },
      { key: "tat", label: "Install → comm. days", num: true }],
    row: (x) => ({ ...baseRow(f, c, x), hoto: x[c.hoto_day], installed: x[c.installed_day], commissioned: x[c.commissioned_day], tat: x[c.tat_days] }),
  };
}
export function p1PendingList(f) {
  const c = f.pci;
  return {
    cols: [...base, { key: "hoto", label: "HOTO", ...day }, { key: "days", label: "Days since HOTO", num: true }, { key: "next", label: "Waiting for" },
      ...(c.status != null ? [{ key: "oms", label: "OMS status" }] : []), { key: "state", label: "State" }],
    row: (x) => ({ ...baseRow(f, c, x), hoto: x[c.hoto_day], days: x[c.days_since_hoto], next: label(f, "next_stage", x[c.next_stage]),
      oms: c.status != null ? label(f, "status", x[c.status]) : "", state: label(f, "state", x[c.state]) }),
  };
}
export function p2PendingList(f) {
  const c = f.pci;
  return {
    cols: [...base, { key: "installed", label: "Installed", ...day }, { key: "days", label: "Days since install", num: true }, { key: "step", label: "Current step" }, { key: "reason", label: "CT reason" }],
    row: (x) => ({ ...baseRow(f, c, x), installed: x[c.installed_day], days: x[c.aging_days], step: label(f, "substage", x[c.substage]), reason: label(f, "ct_reason", x[c.ct_reason]) }),
  };
}
export function qhseSiteList(f) {
  const c = f.ci;
  return {
    cols: [...base, { key: "ic", label: "IC" }, { key: "vendor", label: "Vendor" }, { key: "audit", label: "Audited", ...day }, { key: "open", label: "Open points", num: true }, { key: "mech", label: "Open Z+H mech.", num: true }],
    row: (x) => ({ ...baseRow(f, c, x), ic: dim(f, c, "ic")(x), vendor: dim(f, c, "vendor")(x), audit: x[c.audit_day], open: x[c.n_open], mech: x[c.open_mech] }),
  };
}
export function escTicketList(f) {
  const c = f.ci;
  return {
    cols: [{ key: "ticket", label: "Ticket" }, ...base, { key: "level", label: "Level" }, { key: "created", label: "Created", ...day }, { key: "status", label: "Status" }, { key: "age", label: "Days open", num: true }],
    row: (x) => ({ ticket: x[c.ticket_id], ...baseRow(f, c, x), level: dim(f, c, "level")(x), created: x[c.created_day], status: dim(f, c, "status")(x), age: x[c.is_open] ? null : x[c.closure_tat] }),
  };
}
// D-122: NBFC / PSU cases waiting for the next loan step. Lender and step only: no bank or loan-amount fields.
export function nbfcList(f, asOf) {
  const c = f.ci;
  return {
    cols: [...base, { key: "lender", label: "Lender" }, { key: "step", label: "Lender step" }, { key: "tag", label: "EMI tag" }, { key: "tag2", label: "Sub-reason" },
      { key: "hoto", label: "HOTO", ...day }, { key: "days", label: "Days since HOTO", num: true }, { key: "inStep", label: "Days in step", num: true }],
    row: (x) => ({ ...baseRow(f, c, x), lender: dim(f, c, "lender")(x), step: dim(f, c, "step")(x), tag: dim(f, c, "tag")(x), tag2: dim(f, c, "tag2")(x),
      hoto: x[c.hoto_day], days: x[c.hoto_day] == null ? null : asOf - x[c.hoto_day], inStep: x[c.step_day] == null ? null : asOf - x[c.step_day] }),
  };
}
export function psuList(f, asOf) {
  const c = f.ci;
  return {
    cols: [...base, { key: "lender", label: "Bank" }, { key: "step", label: "Waiting for" }, { key: "hoto", label: "HOTO", ...day },
      { key: "days", label: "Days since HOTO", num: true }, { key: "inStep", label: "Days in step", num: true },
      { key: "rfd", label: "RFD", ...day }, { key: "d70", label: "70% received", ...day }, { key: "inst", label: "Installed", ...day }],
    row: (x) => ({ ...baseRow(f, c, x), lender: dim(f, c, "lender")(x), step: dim(f, c, "step")(x), hoto: x[c.hoto_day],
      days: x[c.hoto_day] == null ? null : asOf - x[c.hoto_day], inStep: x[c.step_day] == null ? null : asOf - x[c.step_day],
      rfd: x[c.rfd_day], d70: x[c.d70_day], inst: x[c.installed_day] }),
  };
}
export function subsidyList(f, asOf) {
  const c = f.ci;
  return {
    cols: [...base, { key: "stage", label: "Stage" }, { key: "days", label: "Days in stage", num: true }, { key: "comm", label: "Commissioned", ...day }],
    row: (x) => ({ ...baseRow(f, c, x), stage: dim(f, c, "stage")(x), days: x[c.stage_day] == null ? null : asOf - x[c.stage_day], comm: x[c.comm_day] }),
  };
}
