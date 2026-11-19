-- Tactic boards: tokens, utility and drawings on a map, personal or shared with a team.
create table tactic_boards (
  id          text primary key,
  owner_id    text not null references "auth_user"(id) on delete cascade,
  team_id     text references teams(id) on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  map_id      text not null,
  data        jsonb not null,
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index tactic_boards_owner_idx on tactic_boards(owner_id);
create index tactic_boards_team_idx on tactic_boards(team_id) where team_id is not null;
