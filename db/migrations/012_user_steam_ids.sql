-- Steam accounts a user says are theirs (not verified), used for their personal stats across demos.
create table user_steam_ids (
  user_id    text not null references "auth_user"(id) on delete cascade,
  steam_id   text not null check (steam_id ~ '^7656119[0-9]{10}$'),
  created_at timestamptz not null default now(),
  primary key (user_id, steam_id)
);
