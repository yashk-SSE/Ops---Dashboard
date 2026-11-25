-- =============================================================================
-- Extract: loan journey per project (NBFC and PSU cases, D-122)
-- Grain     : project (its latest finalized EMI application that is not skipped on the EMI portal, as Q-2369)
-- Scope     : non-Direct projects handed over since {since} or still alive ({since} filled by pipeline/jobs/loans.py)
-- Columns   : lender, current application stage and since when (first log entry of the current run of that stage),
--             current EMI-team tags (L1 / L2), and the FIRST time the application entered each lender / PSU stage
--             or got a key EMI-team tag, from emiApplicationLog.
-- Times     : as stored (UTC); converted to IST in Python.
-- PII       : no customer, bank, address or loan-amount fields.
-- =============================================================================
with p as (
  select p._id as project_id
  from "public"."project" p
  where coalesce(p."isDelete", '0') = '0'
    and coalesce(p.finance_mode_payment_sched, '') not ilike '%Direct%'
    and (p.sales_handover_datetime >= '{since}' or p.project_state in ('active', 'on-hold', 'seeking-cancellation'))
), a as (
  select distinct on (ea."projectId")
         ea._id                as app_id,
         ea."projectId"        as project_id,
         ea."emiPartner"       as emi_partner,
         ea."applicationStage" as application_stage,
         ea."psuFlow"          as psu_flow,
         ea.tags_l1, ea.tags_l2
  from "public"."emiapplicants" ea
  where ea."projectId" in (select project_id from p)
    and ea."isFinalized" = true
    and (ea."emiPortalSkip" is null or ea."emiPortalSkip" <> true)
  order by ea."projectId", ea."createdAt" desc
), l as (
  select g."emiApplicationId" as app_id, g.stage, g."tagDetails_tags_l1" as tag, g."createdAt"::timestamptz as at
  from "public"."emiApplicationLog" g
  where g."emiApplicationId" in (select app_id from a)
), last_other as (  -- last log entry in a different stage: the current stage's run starts after it
  select l.app_id, max(l.at) as at
  from l join a on a.app_id = l.app_id
  where l.stage is not null and l.stage <> coalesce(a.application_stage, '')
  group by 1
), cur as (
  select l.app_id, min(l.at) as stage_since
  from l join a on a.app_id = l.app_id left join last_other o on o.app_id = l.app_id
  where l.stage = a.application_stage and (o.at is null or l.at > o.at)
  group by 1
), s as (
  select app_id,
    -- lender stages (NBFC)
    min(at) filter (where stage = 'loan-application-created')                                         as created_at,
    min(at) filter (where stage = 'loan-application-submitted')                                       as submitted_at,
    min(at) filter (where stage in ('loan-application-approved', 'loan-application-partially-approved')) as approved_at,
    min(at) filter (where stage = 'loan-application-enach-pending')                                   as enach_pending_at,
    min(at) filter (where stage = 'loan-application-enach-completed')                                 as enach_done_at,
    min(at) filter (where stage = 'loan-application-pre-disbursal-documents')                         as predisb_at,
    min(at) filter (where stage = 'loan-application-ready-for-disbursement')                          as lender_rfd_at,
    min(at) filter (where stage = 'loan-application-disbursed')                                       as lender_disbursed_at,
    -- PSU steps (each "... Pending" stage is entered when the step before it is done)
    min(at) filter (where stage = 'Document Verification')                                            as docver_at,
    min(at) filter (where stage = 'Select NBFC')                                                      as select_lender_at,
    min(at) filter (where stage = 'Jan Samarth Application Pending')                                  as js_pending_at,
    min(at) filter (where stage = 'Assign Runner')                                                    as runner_at,
    min(at) filter (where stage = 'Bank Visit Pending')                                               as bank_visit_pending_at,
    min(at) filter (where stage = 'Bank Inspection Pending')                                          as bank_insp_pending_at,
    min(at) filter (where stage ilike 'Final CX Visit Pending%')                                      as final_visit_pending_at,
    min(at) filter (where stage = 'First Disbursal Pending')                                          as first_disb_pending_at,
    min(at) filter (where stage = 'Pending Disbursal Verification')                                   as disb_verif_at,
    min(at) filter (where stage = 'First Disbursal Received')                                         as first_disb_recv_at,
    min(at) filter (where stage = 'Submit Installation Documents')                                    as install_docs_at,
    min(at) filter (where stage = 'Second Disbursal Pending')                                         as second_disb_pending_at,
    min(at) filter (where stage = 'Disbursed')                                                        as disbursed_at,
    -- EMI-team tags (set by hand; not every application is tagged)
    min(at) filter (where tag = 'PAP Pending')                                                        as pap_pending_at,
    min(at) filter (where tag in ('PAP Done', 'TFR Received - RFD Pending', 'RFD Check in process Lender', 'RFD Done')) as pap_done_at
  from l
  group by app_id
)
select a.project_id, a.app_id, a.emi_partner, a.application_stage, a.psu_flow, a.tags_l1, a.tags_l2,
       cur.stage_since,
       s.created_at, s.submitted_at, s.approved_at, s.enach_pending_at, s.enach_done_at, s.predisb_at, s.lender_rfd_at, s.lender_disbursed_at,
       s.docver_at, s.select_lender_at, s.js_pending_at, s.runner_at, s.bank_visit_pending_at, s.bank_insp_pending_at, s.final_visit_pending_at,
       s.first_disb_pending_at, s.disb_verif_at, s.first_disb_recv_at, s.install_docs_at, s.second_disb_pending_at, s.disbursed_at,
       s.pap_pending_at, s.pap_done_at
from a
left join cur on cur.app_id = a.app_id
left join s on s.app_id = a.app_id
