-- Purpose: NBFC "payment ready" = the lender's RFD (D-76), built as Metabase Q-2369 "NBFC HA & 5.0 Base" builds final_rfd_date:
--   application = the project's latest finalized, non-PSU EMI application that is not skipped on the EMI portal;
--   CreditFair / Fibe / Caprion: when the application log reached stage 'loan-application-ready-for-disbursement';
--   other lenders (Ecofy, Ratnaafin, …): when the tag 'RFD Done' was set. Q-2369 takes the latest time (MAX); we also keep the first.
-- One row per project. Timestamps as stored (UTC); the pipeline converts to IST. No customer / bank fields.
WITH app AS (
  SELECT DISTINCT ON (ea."projectId")
         ea."projectId"        AS project_id,
         ea._id                AS app_id,
         ea."emiPartner"       AS emi_partner,
         ea."applicationStage" AS application_stage
  FROM emiapplicants ea
  WHERE ea."projectId" IS NOT NULL AND ea."projectId" <> ''
    AND (ea."psuFlow" IS NULL OR ea."psuFlow" <> 'true')
    AND ea."isFinalized" = TRUE
    AND (ea."emiPortalSkip" IS NULL OR ea."emiPortalSkip" <> TRUE)
  ORDER BY ea."projectId", ea."createdAt" DESC
),
lender_stage AS (
  SELECT "emiApplicationId" AS app_id, MIN("createdAt"::timestamptz) AS first_at, MAX("createdAt"::timestamptz) AS last_at
  FROM "emiApplicationLog"
  WHERE stage = 'loan-application-ready-for-disbursement'
    AND "emiApplicationId" IN (SELECT app_id FROM app)
  GROUP BY 1
),
rfd_tag AS (
  SELECT "emiApplicationId" AS app_id, MIN("createdAt"::timestamptz) AS first_at, MAX("createdAt"::timestamptz) AS last_at
  FROM "emiApplicationLog"
  WHERE "tagDetails_tags_l1" = 'RFD Done'
    AND "emiApplicationId" IN (SELECT app_id FROM app)
  GROUP BY 1
)
SELECT a.project_id,
       a.emi_partner,
       p.emi_details_loan_partner AS project_loan_partner,
       a.application_stage,
       ls.first_at AS lender_stage_first_at,
       ls.last_at  AS lender_stage_last_at,
       rt.first_at AS rfd_tag_first_at,
       rt.last_at  AS rfd_tag_last_at
FROM app a
JOIN project p ON p._id = a.project_id
LEFT JOIN lender_stage ls ON ls.app_id = a.app_id
LEFT JOIN rfd_tag rt ON rt.app_id = a.app_id
