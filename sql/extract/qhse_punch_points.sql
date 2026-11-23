-- Purpose: QHSE punch points (PP), built the way Metabase Q-5424 "QHSE V2 Report" builds them (the QHSE Version 1 sheet is an export of it).
-- Used by pipeline/jobs/qhse.py and pipeline/tools/reconcile_qhse.py (docs/reconciliation/qhse.md, D-71). No customer fields.
-- A PP = a qhse_checklist item answered "No" (physical audit), OR an IC-audit item that failed (IC said Fail / backend said No).
-- Grain: one row per (sseid, field code) from either side (FULL OUTER JOIN, as in Q-5424).
WITH qa AS (
  SELECT qc.checklist_sseid AS sseid, qc.checklist_field_code AS code, qc.checklist_field_severity AS severity,
         qc.checklist_priority AS priority, qc.checklist_rectification_status AS pp_status, qc.checklist_opted_for AS opted_for,
         qc.checklist_header AS component, qc.checklist_field_name AS issue
  FROM qhse_checklist qc
  WHERE qc."checklist_isDelete" = '0'
),
ia AS (
  SELECT ai.sseid, aic.checklist_field_code AS code, aic.checklist_severity AS severity,
         aic.checklist_response AS ic_response, aic.checklist_audit_response AS backend_response,
         aic.checklist_header AS component, aic.checklist_field_name AS issue
  FROM audit_instance ai
  LEFT JOIN audit_instance_checklist aic ON aic.checklist__rid_ = ai.checklist
  WHERE ai.audit_type = 'IC Audit' AND aic.checklist_field_code IS NOT NULL
)
SELECT COALESCE(qa.sseid, ia.sseid)         AS sseid,
       COALESCE(qa.code, ia.code)           AS code,
       COALESCE(qa.severity, ia.severity)   AS severity,
       qa.priority,
       qa.pp_status,
       COALESCE(qa.component, ia.component) AS component,
       COALESCE(qa.issue, ia.issue)         AS issue,
       CASE WHEN qa.sseid IS NOT NULL AND qa.opted_for = 'No' THEN 'physical' ELSE 'ic_only' END AS source
FROM qa
FULL OUTER JOIN ia ON ia.sseid = qa.sseid AND ia.code = qa.code
WHERE (qa.opted_for = 'No' OR ia.ic_response = 'Fail' OR ia.backend_response = 'No')
