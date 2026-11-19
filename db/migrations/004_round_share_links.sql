-- Round links: a share link may be limited to one round. Null keeps the old whole-replay behaviour.
alter table share_links add column round_id text check (round_id is null or round_id ~ '^r[0-9]{2,3}$');
create unique index share_links_round_uq on share_links(replay_id, round_id) where round_id is not null and revoked_at is null;
