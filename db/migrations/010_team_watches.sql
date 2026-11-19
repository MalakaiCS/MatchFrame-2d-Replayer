-- Teams a user follows on the Stats pages; last_seen_at drives the "new demos" count.
create table team_watches (
  user_id      text not null references "auth_user"(id) on delete cascade,
  team_key     text not null check (length(team_key) between 1 and 80),
  team_name    text not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (user_id, team_key)
);
