-- =============================================================================
-- Extract: order journey per lead (Order -> HOTO page, D-124)
-- Grain     : lead with an order (lead.order_closure_datetime) since {since} ({since} filled by pipeline/jobs/orders.py)
-- Columns   : order time, Opening Act flag, current lead stage, cancellation markers, place (city / cluster / cell, COM by cell
--             roles as project_dim.sql, SOH / ZOH from the speed-order fields), the RM, and the RM welcome call (task SC008)
--             from rm_verification_checklist: attempts, first / latest verdict, when the SC008 task was created, when the
--             first checklist was saved, and the sections not ALIGNED in the first attempt (incl. PENDING, as Q-4204) with
--             their rejection reasons (fixed list).
-- Join to project (HOTO date, project dims) happens in Python on the trimmed SSE ID: project.lead_id is not lead._id.
-- Times     : lead / checklist timestamps as stored (UTC); converted to IST in Python.
-- PII       : no customer name, phone, email, address or free-text comment.
-- =============================================================================
with cell_roles as (
  select c._id as cell_id,
         string_agg(distinct case when ur.roles__val_ = 'COM' then trim(coalesce(u."firstName", '')) || ' ' || trim(coalesce(u."lastName", '')) end, ', ') as com
  from "public"."cell" c
  left join "public"."cell_users" cu on c.users = cu.users__rid_
  left join "public"."users" u on cu.users__val_ = u._id
  left join "public"."users_roles" ur on u.roles = ur.roles__rid_
  where ur.roles__val_ = 'COM'
  group by c._id
), l as (
  select l._id as lead_id, nullif(trim(l.sseid), '') as sseid, l.order_closure_datetime as order_at, l.opening_act, l.stage,
         l.pre_hoto_cancellation, nullif(trim(l.order_cancellation_id), '') as cancellation_id, nullif(trim(l."assignedRmId"), '') as rm_id,
         trim(l.site_address_city) as city, trim(l.site_address_cluster) as cluster, trim(l.site_address_state) as legal_state,
         nullif(trim(l.cell_id), '') as cell_id, nullif(trim(l.speed_order_user_soh), '') as soh_ref, nullif(trim(l.speed_order_user_zoh), '') as zoh_ref,
         l.document_verification_approved_date as verified_at, l.hoto_initiated_timestamp as hoto_initiated_at
  from "public"."lead" l
  where l.order_closure_datetime >= '{since}'
), c as (
  select c."leadId" as lead_id, c."finalVerdict" as verdict, c."createdAt" as at, c.sections::text as rid, c."assignedRmId" as rm_id, c."taskId"::text as task_id
  from "public"."rm_verification_checklist" c
  where c."leadId" in (select lead_id from l)
), ca as (
  select c.lead_id, count(*) as attempts, min(c.at) as first_call_at,
         (array_agg(c.verdict order by c.at))[1]      as first_verdict,
         (array_agg(c.verdict order by c.at desc))[1] as latest_verdict,
         (array_agg(c.rid order by c.at))[1]          as first_rid,
         (array_agg(c.rm_id order by c.at))[1]        as first_rm_id,
         min(u."createdAt"::timestamptz)              as sc008_created_at
  from c left join "public"."usertasks" u on u._id::text = c.task_id
  group by 1
), bad as (
  select s."sections__rid_"::text as rid,
         string_agg(distinct s."sections_sectionKey", ',') as keys,
         string_agg(distinct s."sections_sectionKey" || ':' || coalesce(r."sections_rejectionReasons__val_", ''), '|') as reasons
  from "public"."rm_verification_checklist_sections" s
  left join "public"."rm_verification_checklist_sections_rejectionReasons" r
    on r."sections_rejectionReasons__rid_"::text = s."sections_rejectionReasons"::text
  where s."sections_status" <> 'ALIGNED' and s."sections__rid_"::text in (select first_rid from ca)
  group by 1
)
select l.lead_id, l.sseid, l.order_at, l.opening_act, l.stage, l.pre_hoto_cancellation, l.cancellation_id,
       l.city, l.cluster, l.legal_state, trim(cl.name) as cell_name, cr.com,
       case when l.soh_ref ~ '^[0-9a-f]{24}$' then nullif(trim(trim(coalesce(us."firstName", '')) || ' ' || trim(coalesce(us."lastName", ''))), '') else l.soh_ref end as soh,
       case when l.zoh_ref ~ '^[0-9a-f]{24}$' then nullif(trim(trim(coalesce(uz."firstName", '')) || ' ' || trim(coalesce(uz."lastName", ''))), '') else l.zoh_ref end as zoh,
       nullif(trim(trim(coalesce(rm."firstName", '')) || ' ' || trim(coalesce(rm."lastName", ''))), '') as rm,
       l.verified_at, l.hoto_initiated_at,
       ca.attempts, ca.first_call_at, ca.first_verdict, ca.latest_verdict, ca.sc008_created_at,
       bad.keys as first_not_aligned, bad.reasons as first_reasons
from l
left join ca on ca.lead_id = l.lead_id
left join bad on bad.rid = ca.first_rid
left join "public"."cell" cl on cl._id = l.cell_id
left join cell_roles cr on cr.cell_id = l.cell_id
left join "public"."users" us on us._id = l.soh_ref
left join "public"."users" uz on uz._id = l.zoh_ref
left join "public"."users" rm on rm._id = coalesce(nullif(trim(ca.first_rm_id), ''), l.rm_id)
