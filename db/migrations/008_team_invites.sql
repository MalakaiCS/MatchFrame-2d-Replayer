-- Invite links: anyone with the link and a Matchframe account can join the team with the given role.
-- Only a SHA-256 hash of the token is stored.
create table team_invites (
  id          text primary key,
  team_id     text not null references teams(id) on delete cascade,
  token_hash  bytea not null unique,
  role        team_role not null default 'player' check (role <> 'owner'),
  created_by  text not null references "auth_user"(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  max_uses    integer check (max_uses is null or max_uses > 0),
  uses        integer not null default 0,
  revoked_at  timestamptz
);
create index team_invites_team_idx on team_invites(team_id);
