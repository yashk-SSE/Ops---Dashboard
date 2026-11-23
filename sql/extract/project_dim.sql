-- =============================================================================
-- Extract: project dimension, one row per non-deleted project (shared by P1 and later sections)
-- Grain     : project (sseid)
-- Rules     : D-36 COM / SPO = cell roles, all names comma-separated
--             D-50 SOH / ZOH = project.soh / project.zoh (user ids -> names)
--             D-37 region = project.site_address_cluster_state (business region)
--             D-38 lane inputs = payment lane (Q-1529 psu_tag rule) + LC / NC / PC flags
-- Dates     : returned as the raw ISO text stored on project (UTC). Parsed + converted to IST once in Python,
--             so one malformed value cannot fail the whole query.
-- PII       : no customer name / phone / email / address.
-- =============================================================================
with cell_roles as (
  select c._id as cell_id,
         string_agg(distinct case when ur.roles__val_ = 'COM' then trim(coalesce(u."firstName", '')) || ' ' || trim(coalesce(u."lastName", '')) end, ', ') as com,
         string_agg(distinct case when ur.roles__val_ = 'SPO' then trim(coalesce(u."firstName", '')) || ' ' || trim(coalesce(u."lastName", '')) end, ', ') as spo
  from cell c
  left join cell_users cu on c.users = cu.users__rid_
  left join users u on cu.users__val_ = u._id
  left join users_roles ur on u.roles = ur.roles__rid_
  where ur.roles__val_ in ('COM', 'SPO')
  group by c._id
)
select
  trim(p.sseid)                                        as sseid,
  p._id                                                as project_id,
  p.project_state,
  p.project_status,
  trim(p.site_address_city)                            as city,
  trim(p.site_address_cluster)                         as cluster,      -- D-86: dashboard uses Cluster, not City
  nullif(trim(p.site_address_cluster_state), '')       as region,
  trim(p.site_address_state)                           as legal_state,
  p.cell_id,
  trim(c.name)                                         as cell_name,
  cr.com, cr.spo,
  nullif(trim(trim(coalesce(us."firstName", '')) || ' ' || trim(coalesce(us."lastName", ''))), '') as soh,
  nullif(trim(trim(coalesce(uz."firstName", '')) || ' ' || trim(coalesce(uz."lastName", ''))), '') as zoh,
  nullif(p.project_size_kw, '')                        as project_size_kw,
  case when p.finance_mode_payment_sched ilike '%Direct%' then 'DIRECT'
       when p.finance_mode_payment_sched ilike '%EMI%'
            and lower(p.emi_details_loan_partner) in ('pnb','canerabank','canera bank','otherpsu','canara','ubi','sbi','bob','other psu bank') then 'PSU'
       else 'NBFC' end                                 as payment_lane,
  case when p.bill_correction_load_change  ilike '%Yes%' then 'Yes' else 'No' end as lc,
  case when p.bill_correction_name_change  ilike '%Yes%' then 'Yes' else 'No' end as nc,
  case when p.bill_correction_phase_change ilike '%Yes%' then 'Yes' else 'No' end as pc,
  p.subsidy_type,
  p.project_type,
  nullif(p.order_closure_datetime, '')                 as order_at,
  nullif(p.sales_handover_datetime, '')                as hoto_at,
  nullif(p.commissioning_date, '')                     as commissioned_at,
  nullif(p.cancellation_timestamp, '')                 as cancellation_ts,
  nullif(p.hold_timestamp, '')                         as hold_ts
from project p
left join cell c on c._id = p.cell_id
left join cell_roles cr on cr.cell_id = p.cell_id
left join users us on us._id = nullif(p.soh, '')
left join users uz on uz._id = nullif(p.zoh, '')
where coalesce(p."isDelete", '0') = '0'
