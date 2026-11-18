-- Matchframe2D Replayer application schema.
-- Users and sessions live in the Better Auth tables from 001_auth.sql.

create type team_role as enum ('owner', 'coach', 'analyst', 'player', 'viewer');
create type replay_status as enum ('uploading', 'queued', 'processing', 'ready', 'failed', 'deleted');
create type replay_visibility as enum ('private', 'team', 'unlisted', 'catalogue');
create type job_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
create type job_kind as enum ('parse', 'cleanup');

create table teams (
  id          text primary key,
  name        text not null check (length(name) between 1 and 80),
  created_by  text not null references "auth_user"(id),
  created_at  timestamptz not null default now()
);

create table team_members (
  team_id    text not null references teams(id) on delete cascade,
  user_id    text not null references "auth_user"(id) on delete cascade,
  role       team_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_idx on team_members(user_id);

-- Upload slots. One slot produces at most one replay (finalisation is idempotent).
create table uploads (
  id           text primary key,
  owner_id     text not null references "auth_user"(id) on delete cascade,
  object_key   text not null unique,
  filename     text not null,
  declared_size bigint not null,
  max_bytes    bigint not null,
  status       text not null default 'pending' check (status in ('pending', 'completed', 'expired', 'rejected')),
  replay_id    text unique,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index uploads_pending_idx on uploads(expires_at) where status = 'pending';

create table replays (
  id                 text primary key,             -- opaque, random
  owner_id           text not null references "auth_user"(id) on delete cascade,
  team_id            text references teams(id) on delete set null,
  title              text,
  status             replay_status not null default 'queued',
  failure_code       text,
  failure_detail     text,
  visibility         replay_visibility not null default 'private',
  source_type        text check (source_type in ('gotv', 'pov')),
  source_key         text,                         -- temporary demo object, null once deleted
  source_size        bigint,
  source_expires_at  timestamptz,
  source_filename    text,
  revision           integer not null default 1,   -- current processing revision
  published_revision integer,                      -- revision the viewer reads
  published_prefix   text,                         -- object prefix of the published revision/attempt
  map_id             text,
  team_a_name        text,
  team_b_name        text,
  score_a            integer,
  score_b            integer,
  round_count        integer,
  played_at          timestamptz,
  parser_version     text,
  schema_version     integer,
  asset_version      text,
  series_id          text,
  series_map_index   integer,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index replays_owner_idx on replays(owner_id) where deleted_at is null;
create index replays_team_idx on replays(team_id) where deleted_at is null;
create index replays_series_idx on replays(series_id, series_map_index);

-- Durable processing jobs. (replay, revision, kind) is unique so that enqueue is idempotent.
create table jobs (
  id               bigserial primary key,
  replay_id        text not null references replays(id) on delete cascade,
  revision         integer not null,
  kind             job_kind not null default 'parse',
  status           job_status not null default 'queued',
  attempts         integer not null default 0,
  max_attempts     integer not null default 5,
  lease_owner      text,
  lease_expires_at timestamptz,
  next_run_at      timestamptz not null default now(),
  last_error       text,
  result           jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  finished_at      timestamptz,
  unique (replay_id, revision, kind)
);
create index jobs_ready_idx on jobs(next_run_at) where status in ('queued', 'running');

-- Explicit grants (in addition to owner and team membership).
create table replay_grants (
  replay_id  text not null references replays(id) on delete cascade,
  team_id    text references teams(id) on delete cascade,
  user_id    text references "auth_user"(id) on delete cascade,
  granted_by text not null references "auth_user"(id),
  created_at timestamptz not null default now(),
  check ((team_id is null) <> (user_id is null))
);
create unique index replay_grants_team_uq on replay_grants(replay_id, team_id) where team_id is not null;
create unique index replay_grants_user_uq on replay_grants(replay_id, user_id) where user_id is not null;

-- Unlisted read-only links. Only a SHA-256 hash of the token is stored.
create table share_links (
  id          text primary key,
  replay_id   text not null references replays(id) on delete cascade,
  token_hash  bytea not null unique,
  created_by  text not null references "auth_user"(id),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create index share_links_replay_idx on share_links(replay_id);

-- Review data. Every anchor stores replay, revision, round and tick.
create table bookmarks (
  id          text primary key,
  replay_id   text not null references replays(id) on delete cascade,
  revision    integer not null,
  round_id    text not null,
  tick        integer not null,
  end_tick    integer,
  title       text not null check (length(title) between 1 and 200),
  owner_id    text not null references "auth_user"(id) on delete cascade,
  team_id     text references teams(id) on delete cascade,  -- null = personal
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (end_tick is null or end_tick > tick)
);
create index bookmarks_replay_idx on bookmarks(replay_id);

create table notes (
  id          text primary key,
  replay_id   text not null references replays(id) on delete cascade,
  revision    integer not null,
  round_id    text not null,
  tick        integer not null,
  body        text not null check (length(body) between 1 and 5000),
  author_id   text not null references "auth_user"(id) on delete cascade,
  team_id     text references teams(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index notes_replay_idx on notes(replay_id);

create table playlists (
  id          text primary key,
  name        text not null check (length(name) between 1 and 120),
  description text,
  owner_id    text not null references "auth_user"(id) on delete cascade,
  team_id     text references teams(id) on delete cascade,
  version     integer not null default 1,      -- optimistic concurrency token
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table playlist_entries (
  id          text primary key,
  playlist_id text not null references playlists(id) on delete cascade,
  position    integer not null,
  replay_id   text references replays(id) on delete set null,  -- null = source removed
  revision    integer not null,
  round_id    text not null,
  tick        integer not null,
  end_tick    integer,
  label       text,
  created_by  text not null references "auth_user"(id),
  created_at  timestamptz not null default now(),
  unique (playlist_id, position) deferrable initially deferred
);

-- Voice comms. Private storage; link visibility is opt-in per track.
create table audio_tracks (
  id              text primary key,
  replay_id       text not null references replays(id) on delete cascade,
  object_key      text not null unique,
  label           text not null,
  mime_type       text not null,
  size_bytes      bigint not null,
  duration_ms     integer,
  offset_ms       integer not null default 0,     -- demo-time (ms from tick 0) at which the audio starts
  team_id         text references teams(id) on delete set null,
  uploaded_by     text not null references "auth_user"(id),
  share_with_link boolean not null default false,
  status          text not null default 'pending' check (status in ('pending', 'ready', 'deleted')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index audio_tracks_replay_idx on audio_tracks(replay_id);

-- Public / competition catalogue. Each entry records provenance and licence.
create table catalogue_entries (
  id             text primary key,
  provider       text not null,
  provider_ref   text not null,
  event_name     text,
  match_name     text not null,
  series_id      text,
  map_index      integer,
  map_id         text,
  licence        text not null,
  provenance_url text,
  entitlement    text not null default 'public' check (entitlement in ('public', 'entitled')),
  replay_id      text references replays(id) on delete set null,
  played_at      timestamptz,
  created_at     timestamptz not null default now(),
  unique (provider, provider_ref)
);

create table catalogue_entitlements (
  provider text not null,
  team_id  text references teams(id) on delete cascade,
  user_id  text references "auth_user"(id) on delete cascade,
  check ((team_id is null) <> (user_id is null))
);
