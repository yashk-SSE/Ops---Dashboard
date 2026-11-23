-- Purpose: when each project entered each subsidy status (first and latest time), for "days in current stage" and
-- "disbursed on" (D-87). One row per (project, status).
SELECT "projectId"   AS project_id,
       subsidy_status,
       MIN("createdAt") AS first_at,
       MAX("createdAt") AS last_at,
       COUNT(*)         AS times
FROM subsidy_status_history
WHERE "projectId" IS NOT NULL AND "projectId" <> ''
GROUP BY 1, 2
