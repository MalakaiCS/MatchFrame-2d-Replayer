-- Compact per-replay positions, kills and grenades for heatmaps and the lineup library.
-- Built by the web app from the published round payloads on first use; rebuilt for a new revision.
create table replay_insights (
  replay_id  text primary key references replays(id) on delete cascade,
  revision   integer not null,
  data       jsonb not null,
  built_at   timestamptz not null default now()
);
