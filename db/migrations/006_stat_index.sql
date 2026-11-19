-- Per-replay summary used by the cross-demo stats pages (team overview, opponents, players).
-- Filled lazily by the web app from the published manifest; re-filled when a new revision is published.
create table replay_stat_index (
  replay_id   text primary key references replays(id) on delete cascade,
  revision    integer not null,
  map_id      text,
  has_players boolean not null default false,
  -- {"A": TeamSummary, "B": TeamSummary}; see web/src/lib/statIndex.ts
  teams       jsonb not null,
  -- [PlayerSummary]
  players     jsonb not null,
  indexed_at  timestamptz not null default now()
);
