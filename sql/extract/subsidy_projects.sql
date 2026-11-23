-- Purpose: National DBT subsidy projects with their current OMS subsidy status (= "Subsidy Stage as per OMS" in the
-- New - Pending Subsidy Tracker_V1 sheet). Used by pipeline/jobs/subsidy.py (D-87). No customer fields.
SELECT p._id               AS project_id,
       p.subsidy_type,
       p.subsidy_status,
       p.project_state,
       p.commissioning_date AS commissioned_at
FROM project p
WHERE p."isDelete" = '0'
  AND p.subsidy_type ILIKE '%National DBT%'
