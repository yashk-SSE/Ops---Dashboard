-- Purpose: HOTO mismatch from the RM verification checklist (welcome call, task SC008), D-91; replaces the
-- project.*_mismatch flags, which stopped being filled after Sep 2026. One row per project with a checklist.
-- latest_not_aligned = section keys not ALIGNED in the project's latest checklist (latest SC008 task, then latest attempt);
-- "not ALIGNED" includes PENDING, as Metabase Q-4204. ever_not_aligned = the same over all attempts: the dashboard's
-- mismatch (D-91), because HOTO waits for an approved checklist, so the latest attempt is almost always clean.
-- Link: usertasks.parameters_projectId, else project.lead_id = parameters_lead_id. No customer data.
WITH t AS (
  SELECT u."_id" AS task_id, u."createdAt" AS created,
         COALESCE(NULLIF(u."parameters_projectId", ''), p."_id") AS project_id
  FROM "public"."usertasks" u
  LEFT JOIN "public"."project" p
    ON (u."parameters_projectId" IS NULL OR u."parameters_projectId" = '')
   AND p.lead_id = u."parameters_lead_id" AND p."isDelete" = '0'
  WHERE u.key = 'SC008' AND u."createdAt" >= '2026-06-01'
),
c AS (
  SELECT t.project_id, c.sections, c."finalVerdict" AS verdict, c."attemptNo" AS attempt,
         row_number() OVER (PARTITION BY t.project_id ORDER BY t.created DESC, c."attemptNo" DESC) AS rn
  FROM t JOIN "public"."rm_verification_checklist" c ON c."taskId" = t.task_id
  WHERE t.project_id IS NOT NULL
),
bad AS (
  SELECT s."sections__rid_" AS rid, string_agg(DISTINCT s."sections_sectionKey", ',') AS keys
  FROM "public"."rm_verification_checklist_sections" s
  WHERE s."sections_status" <> 'ALIGNED'
  GROUP BY s."sections__rid_"
)
SELECT c.project_id,
       max(CASE WHEN c.rn = 1 THEN c.verdict END) AS latest_verdict,
       max(CASE WHEN c.rn = 1 THEN bad.keys END) AS latest_not_aligned,
       string_agg(bad.keys, ',') AS ever_not_aligned,
       count(*) AS attempts
FROM c LEFT JOIN bad ON bad.rid = c.sections
GROUP BY c.project_id
