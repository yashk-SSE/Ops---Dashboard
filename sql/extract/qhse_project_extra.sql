-- Purpose: per-project QHSE context not in project_dim.sql: installation champion (IC, D-49), first installation vendor (as Q-5424),
--          QHSE inspection type. Used by pipeline/jobs/qhse.py. Staff and vendor names only; no customer fields.
WITH vendors AS (
  SELECT p._id AS project_id, vd.installation_details_vendor_details_vendor AS vendor,
         row_number() OVER (PARTITION BY vd.installation_details_vendor_details__rid_ ORDER BY vd.installation_details_vendor_details__index_) AS rn  -- first vendor in the list (Q-5424 sorted on p."createdAt", i.e. no real order)
  FROM project_installation_details_vendor_details vd
  JOIN project p ON vd.installation_details_vendor_details__rid_ = p.installation_details_vendor_details
)
SELECT p._id AS project_id,
       NULLIF(trim(coalesce(ic."firstName", '') || ' ' || coalesce(ic."lastName", '')), '') AS ic_name,
       v.vendor AS vendor,
       q.installation_info_installation_type AS inspection_type
FROM project p
LEFT JOIN users ic ON ic._id = p.installation_supervisor
LEFT JOIN vendors v ON v.project_id = p._id AND v.rn = 1
LEFT JOIN qhse q ON q.sseid = p.sseid
WHERE p."isDelete" = '0'
