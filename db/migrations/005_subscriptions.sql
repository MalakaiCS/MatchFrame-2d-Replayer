-- Subscriptions: a personal plan covers one account; a team plan covers every member of one team.
-- Rows come from Stripe webhooks (provider 'stripe') or are granted by an operator (provider 'manual',
-- see web/scripts/grant-plan.mjs). Access is decided from these rows only.
create table subscriptions (
  id                     text primary key,
  kind                   text not null check (kind in ('personal', 'team')),
  user_id                text references "auth_user"(id) on delete cascade,
  team_id                text references teams(id) on delete cascade,
  provider               text not null check (provider in ('stripe', 'manual')),
  -- Stripe statuses (active, trialing, past_due, canceled, unpaid, incomplete, ...); manual rows use 'active'/'canceled'.
  status                 text not null,
  stripe_subscription_id text unique,
  stripe_customer_id     text,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  -- Stripe event time of the last applied update, so a late, older webhook cannot undo a newer one.
  stripe_event_at        bigint,
  note                   text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check ((kind = 'personal' and user_id is not null and team_id is null) or (kind = 'team' and team_id is not null and user_id is null))
);
create index subscriptions_user_idx on subscriptions(user_id) where user_id is not null;
create index subscriptions_team_idx on subscriptions(team_id) where team_id is not null;

-- One Stripe customer per paying account or team, reused for every checkout and the billing portal.
create table billing_customers (
  stripe_customer_id text primary key,
  user_id            text references "auth_user"(id) on delete cascade,
  team_id            text references teams(id) on delete cascade,
  created_at         timestamptz not null default now(),
  check ((user_id is null) <> (team_id is null))
);
create unique index billing_customers_user_uq on billing_customers(user_id) where user_id is not null;
create unique index billing_customers_team_uq on billing_customers(team_id) where team_id is not null;
