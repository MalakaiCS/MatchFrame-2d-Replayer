-- Paid accounts' demos are processed first when plans are enforced (0 = normal, 1 = priority).
alter table jobs add column priority smallint not null default 0;
create index jobs_claim_idx on jobs(priority desc, next_run_at, id) where status in ('queued', 'running');
