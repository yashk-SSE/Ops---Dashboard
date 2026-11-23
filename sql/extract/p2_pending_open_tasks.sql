-- =============================================================================
-- Extract: open (todo) usertasks of P2-pending projects
-- Grain     : usertask. Used to find each pending project's current step and blocker (D-41).
-- Template  : {project_ids} is filled by pipeline/jobs/p2_install_to_commissioning.py with the
--             project _ids from p2_installed_projects that are installed (039B), not commissioned,
--             and active / on-hold / seeking-cancellation (D-42). Sent in chunks; the IDs are
--             validated as 24-hex ObjectIds before they're inserted.
-- Why       : the same filter written as a usertasks scan took >120 s (Cloudflare timeout).
--             "parameters_projectId" is indexed, so an IN list returns in about 1 s.
-- Timestamps: UTC; converted to IST in Python. No customer fields.
-- =============================================================================
select
  t."parameters_projectId"        as project_id,
  t.parameters_sseid              as sseid,
  t.key,
  t.summary                       as task_name,
  t."processDefinitionKey"        as process,
  t."createdAt"                   as task_created_at,
  t.assigned_at,
  t.dependency,
  t.sub_dependency,
  t.dependency_reason,
  t.dependency_on,
  t.dependency_updated_at,
  t.escalation_stage,
  t.tat                           as system_tat
from usertasks t
where t.status = 'todo'
  and t."parameters_projectId" in ({project_ids})
