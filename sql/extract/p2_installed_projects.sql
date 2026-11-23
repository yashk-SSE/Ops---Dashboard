-- =============================================================================
-- Extract: P2 Installation -> Commissioning, one row per installed project
-- Grain     : project (sseid). Only projects with task 039B done (= installation completed, D-34).
-- Used by   : pipeline/metrics/p2_install_to_commissioning.py
-- Rules     : D-34 installation = MAX(timeCompleted) of usertask 039B with status 'done' (same as Q-517/1529/5896)
--             D-35 commissioning = project.commissioning_date
--             D-36 COM / SPO = cell roles, all names comma-separated
--             D-50 SOH / ZOH = project.soh / project.zoh (user ids -> names; ~99% filled vs 36% / 9% via cell roles)
--             D-37 region = project.site_address_cluster_state (business region, e.g. 'MH West')
--             D-38 lane inputs = payment lane (Q-1529 psu_tag rule) + LC / NC / PC flags
-- Timestamps: returned in UTC (timestamptz); converted to IST once in Python.
-- PII       : no customer name / phone / email / address selected.
-- =============================================================================
with inst as (
  select "parameters_projectId" as project_id,
         max(to_timestamp(nullif("timeCompleted", '-1')::numeric / 1000)) as installed_at
  from usertasks
  where key = '039B' and status = 'done'
  group by "parameters_projectId"
),
cell_roles as (
  select c._id as cell_id,
         string_agg(distinct case when ur.roles__val_ = 'COM' then trim(coalesce(u."firstName", '')) || ' ' || trim(coalesce(u."lastName", '')) end, ', ') as com,
         string_agg(distinct case when ur.roles__val_ = 'SPO' then trim(coalesce(u."firstName", '')) || ' ' || trim(coalesce(u."lastName", '')) end, ', ') as spo,
         string_agg(distinct case when ur.roles__val_ = 'SOH' then trim(coalesce(u."firstName", '')) || ' ' || trim(coalesce(u."lastName", '')) end, ', ') as soh,
         string_agg(distinct case when ur.roles__val_ = 'ZOH' then trim(coalesce(u."firstName", '')) || ' ' || trim(coalesce(u."lastName", '')) end, ', ') as zoh
  from cell c
  left join cell_users cu on c.users = cu.users__rid_
  left join users u on cu.users__val_ = u._id
  left join users_roles ur on u.roles = ur.roles__rid_
  where ur.roles__val_ in ('COM', 'SPO', 'SOH', 'ZOH')
  group by c._id
)
select
  trim(p.sseid)                                        as sseid,
  p._id                                                as project_id,
  p.project_state,
  p.project_status,
  trim(p.site_address_city)                            as city,
  trim(p.site_address_cluster)                         as cluster,      -- D-86
  nullif(trim(p.site_address_cluster_state), '')       as region,
  trim(p.site_address_state)                           as legal_state,
  trim(p.site_address_cluster)                         as cluster,
  p.cell_id,
  trim(c.name)                                         as cell_name,
  cr.com, cr.spo,
  nullif(trim(trim(coalesce(us."firstName", '')) || ' ' || trim(coalesce(us."lastName", ''))), '') as soh,
  nullif(trim(trim(coalesce(uz."firstName", '')) || ' ' || trim(coalesce(uz."lastName", ''))), '') as zoh,
  cr.soh as cell_soh, cr.zoh as cell_zoh,
  nullif(p.project_size_kw, '')                        as project_size_kw,
  case when p.finance_mode_payment_sched ilike '%Direct%' then 'DIRECT'
       when p.finance_mode_payment_sched ilike '%EMI%' then 'EMI'
       else p.finance_mode_payment_sched end           as payment_type,
  case when p.finance_mode_payment_sched ilike '%Direct%' then 'DIRECT'
       when p.finance_mode_payment_sched ilike '%EMI%'
            and lower(p.emi_details_loan_partner) in ('pnb','canerabank','canera bank','otherpsu','canara','ubi','sbi','bob','other psu bank') then 'PSU'
       else 'NBFC' end                                 as payment_lane,
  case when p.bill_correction_load_change  ilike '%Yes%' then 'Yes' else 'No' end as lc,
  case when p.bill_correction_name_change  ilike '%Yes%' then 'Yes' else 'No' end as nc,
  case when p.bill_correction_phase_change ilike '%Yes%' then 'Yes' else 'No' end as pc,
  p.subsidy_type,
  p.project_type,
  p.discom,
  nullif(p.sales_handover_datetime, '')::timestamptz   as hoto_at,
  i.installed_at,
  nullif(p.commissioning_date, '')::timestamptz        as commissioned_at,
  nullif(p.cancellation_timestamp, '')                 as cancellation_ts,
  nullif(p.hold_timestamp, '')                         as hold_ts
from project p
join inst i on i.project_id = p._id
left join cell c on c._id = p.cell_id
left join cell_roles cr on cr.cell_id = p.cell_id
left join users us on us._id = nullif(p.soh, '')
left join users uz on uz._id = nullif(p.zoh, '')
where coalesce(p."isDelete", '0') = '0'
