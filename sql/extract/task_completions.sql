-- =============================================================================
-- Extract: first / last completion time of selected task keys, one row per project
-- Grain     : project (parameters_projectId)
-- Template  : filled by pipeline/common/stage_model.py
--               {pivot_columns} = for each key K:
--                   min(case when t.key = 'K' then nullif(t."timeCompleted", '-1')::numeric end) as "first_K",
--                   max(...)                                                                  as "last_K"
--               {task_keys}     = the keys needed by the configured events (config/seed/events.csv)
--               {project_ids}   = a chunk of project _ids (validated 24-hex ObjectIds)
-- Why       : "parameters_projectId" is indexed, so project-id chunks return in ~1-2 s each,
--             while a scan by key alone risks the 120 s Cloudflare timeout.
-- Times     : epoch milliseconds (UTC) as numbers; converted to IST in Python.
-- Status    : only status = 'done' completions count (same as Q-517 for 039B, D-34).
-- =============================================================================
select
  t."parameters_projectId" as project_id,
{pivot_columns}
from usertasks t
where t.status = 'done'
  and t.key in ({task_keys})
  and t."parameters_projectId" in ({project_ids})
group by t."parameters_projectId"
