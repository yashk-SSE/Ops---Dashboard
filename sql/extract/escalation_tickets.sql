-- Purpose: Operations customer tickets / escalations from Freshdesk (synced into freshdesk_ticket), for pipeline/jobs/escalations.py.
-- Rule D-75 is applied in the job: not merged, has an SSE ID, assigned group not 'CT Team' (matches the PAN India Escalation DB within ~1%).
-- Created = freshdesk_created_at (createdAt is only the OMS sync time). Counts and categories only: no subject, description,
-- customer name or contact fields.
SELECT ticket_id,
       freshdesk_created_at AS created_at,
       closed_time,
       resolved_time,
       status,
       severity_level,
       assigned_group,
       source_channel,
       priority,
       issue_category,
       issue_detail,
       sse_id,
       is_merged,
       is_escalated
FROM freshdesk_ticket
WHERE lower(line_of_business) LIKE 'operation%'
  AND ticket_id ~ '^[0-9]+$'
