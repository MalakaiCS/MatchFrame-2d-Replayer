/**
 * Plans and access.
 *
 * - Personal plan: covers one account everywhere: its own library, uploads to it, replays shared
 *   with it, and any team library it belongs to.
 * - Team plan: covers every member of that team for the team's replays (uploading to the team
 *   library, opening and reviewing team replays and replays shared with the team). Members only
 *   need a free account.
 * - Read-only and round links are free to watch for anyone; catalogue demos keep their own
 *   entitlements.
 *
 * Nothing is enforced unless BILLING_ENABLED=1, so a server without Stripe keeps working as before.
 */
import Stripe from "stripe";
import { q, q1 } from "./db";
import { HttpError } from "./http";
import { newId } from "./ids";

export type PlanKind = "personal" | "team";

/** Statuses that grant access. past_due keeps access while Stripe retries the payment. */
const ACTIVE = ["active", "trialing", "past_due"];
const ACTIVE_SQL = `s.status = any($ACTIVE::text[]) and (s.current_period_end is null or s.current_period_end > now() - interval '1 day')`;
const activeSql = (n: number) => ACTIVE_SQL.replace("$ACTIVE", `$${n}`);

export const billing = {
  enabled: () => process.env.BILLING_ENABLED === "1",
  /** Stripe is usable: secret key and both prices are set. */
  configured: () => !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_PERSONAL && process.env.STRIPE_PRICE_TEAM),
  /** Optional cap on members of a team with a team plan (0 or unset: no cap). */
  teamMemberLimit: () => Number(process.env.TEAM_PLAN_MAX_MEMBERS ?? 0) || 0,
  /** Team plan charged per member (Stripe quantity = members, kept in sync). */
  perSeat: () => process.env.TEAM_PLAN_PER_SEAT === "1",
  /** Seats billed at least (per-seat mode). */
  minSeats: () => Math.max(1, Number(process.env.TEAM_PLAN_MIN_SEATS ?? 1) || 1),
};

export type Interval = "month" | "year";

/** Stripe price id for a plan and billing interval; yearly prices are optional. */
export function priceId(kind: PlanKind, interval: Interval): string | null {
  const env = process.env;
  if (interval === "year") return (kind === "personal" ? env.STRIPE_PRICE_PERSONAL_YEARLY : env.STRIPE_PRICE_TEAM_YEARLY) || null;
  return (kind === "personal" ? env.STRIPE_PRICE_PERSONAL : env.STRIPE_PRICE_TEAM) || null;
}

export const paymentRequired = (message: string) => new HttpError(402, "SUBSCRIPTION_REQUIRED", message);

let stripeClient: Stripe | null = null;
export function stripe(): Stripe {
  if (!billing.configured()) throw new HttpError(503, "BILLING_NOT_CONFIGURED", "Payments are not set up on this server yet.");
  if (!stripeClient) {
    // STRIPE_API_HOST/PORT/PROTOCOL exist only so tests can point the SDK at a local fake.
    const host = process.env.STRIPE_API_HOST;
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      ...(host ? { host, port: Number(process.env.STRIPE_API_PORT ?? 443), protocol: (process.env.STRIPE_API_PROTOCOL as "http" | "https") ?? "https" } : {}),
      maxNetworkRetries: 2,
      appInfo: { name: "Matchframe2D" },
    });
  }
  return stripeClient;
}

export interface Coverage {
  personal: boolean;
  /** Teams the user belongs to that have an active team plan. */
  teams: Set<string>;
}

/** Everything that covers this user right now. */
export async function coverage(userId: string): Promise<Coverage> {
  const rows = await q<{ kind: PlanKind; team_id: string | null }>(
    `select s.kind, s.team_id from subscriptions s
      where ${activeSql(2)} and (s.user_id = $1 or s.team_id in (select team_id from team_members where user_id = $1))`,
    [userId, ACTIVE],
  );
  return { personal: rows.some((r) => r.kind === "personal"), teams: new Set(rows.filter((r) => r.team_id).map((r) => r.team_id!)) };
}

/**
 * May this signed-in user use this replay (open, review, share)? Covered by a personal plan, or by a
 * team plan of the replay's team or of a team the replay is shared with.
 */
export async function assertReplayCovered(userId: string, replay: { id: string; team_id: string | null }) {
  if (!billing.enabled()) return;
  const c = await coverage(userId);
  if (c.personal) return;
  if (replay.team_id && c.teams.has(replay.team_id)) return;
  if (c.teams.size) {
    const g = await q1("select 1 from replay_grants where replay_id = $1 and team_id = any($2::text[])", [replay.id, [...c.teams]]);
    if (g) return;
  }
  throw paymentRequired(
    c.teams.size
      ? "This replay is outside your team's plan. A personal plan covers it, or move it into your team."
      : "Opening replays needs a personal or team plan.",
  );
}

/** May this user start an upload at all? */
export async function assertCanStartUpload(userId: string) {
  if (!billing.enabled()) return;
  const c = await coverage(userId);
  if (c.personal) return;
  if (c.teams.size) {
    const r = await q1("select 1 from team_members where user_id = $1 and role <> 'viewer' and team_id = any($2::text[])", [userId, [...c.teams]]);
    if (r) return;
  }
  throw paymentRequired("Uploading demos needs a personal plan, or a team plan for a team you upload to.");
}

/** May this user put a new replay in this place (their library, or a team)? */
export async function assertCanUploadTo(userId: string, teamId: string | null) {
  if (!billing.enabled()) return;
  const c = await coverage(userId);
  if (c.personal) return;
  if (teamId && c.teams.has(teamId)) return;
  throw paymentRequired(
    c.teams.size
      ? "Your team plan covers uploads to your team. Choose the team when uploading, or get a personal plan for your own library."
      : "Uploading demos needs a personal plan, or a team plan for the team you upload to.",
  );
}

export interface PlanView {
  active: boolean;
  status: string;
  provider: "stripe" | "manual";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/** The most relevant subscription for an account or team: an active one if any, else the latest. */
export async function planFor(owner: { userId: string } | { teamId: string }): Promise<PlanView | null> {
  const [col, val] = "userId" in owner ? ["user_id", owner.userId] : ["team_id", owner.teamId];
  const row = await q1<{ status: string; provider: "stripe" | "manual"; current_period_end: string | null; cancel_at_period_end: boolean; active: boolean }>(
    `select s.status, s.provider, s.current_period_end, s.cancel_at_period_end, (${activeSql(2)}) as active
       from subscriptions s where s.${col} = $1
      order by (${activeSql(2)}) desc, s.updated_at desc limit 1`,
    [val, ACTIVE],
  );
  if (!row) return null;
  return { active: row.active, status: row.status, provider: row.provider, currentPeriodEnd: row.current_period_end, cancelAtPeriodEnd: row.cancel_at_period_end };
}

/** Price shown on the plans page, read from Stripe and cached for ten minutes. */
const priceCache = new Map<string, { at: number; value: PriceView | null }>();
export interface PriceView { amount: number; currency: string; interval: string | null; intervalCount: number }
export async function priceFor(kind: PlanKind, interval: Interval = "month"): Promise<PriceView | null> {
  if (!billing.configured()) return null;
  const id = priceId(kind, interval);
  if (!id) return null;
  const hit = priceCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  let value: PriceView | null = null;
  try {
    const p = await stripe().prices.retrieve(id);
    if (p.unit_amount !== null) value = { amount: p.unit_amount, currency: p.currency, interval: p.recurring?.interval ?? null, intervalCount: p.recurring?.interval_count ?? 1 };
  } catch (e) {
    console.error("[billing] price lookup failed:", e instanceof Error ? e.message : e);
  }
  priceCache.set(id, { at: Date.now(), value });
  return value;
}

/** Stripe customer for an account or team, created on first checkout. */
export async function customerFor(owner: { userId: string; email: string; name: string } | { teamId: string; teamName: string }): Promise<string> {
  const isUser = "userId" in owner;
  const existing = await q1<{ stripe_customer_id: string }>(
    `select stripe_customer_id from billing_customers where ${isUser ? "user_id" : "team_id"} = $1`, [isUser ? owner.userId : owner.teamId]);
  if (existing) return existing.stripe_customer_id;
  const c = await stripe().customers.create(
    isUser
      ? { email: owner.email, name: owner.name, metadata: { kind: "personal", userId: owner.userId } }
      : { name: owner.teamName, metadata: { kind: "team", teamId: owner.teamId } },
  );
  await q(
    `insert into billing_customers(stripe_customer_id, user_id, team_id) values ($1,$2,$3) on conflict do nothing`,
    [c.id, isUser ? owner.userId : null, isUser ? null : owner.teamId],
  );
  const again = await q1<{ stripe_customer_id: string }>(
    `select stripe_customer_id from billing_customers where ${isUser ? "user_id" : "team_id"} = $1`, [isUser ? owner.userId : owner.teamId]);
  return again!.stripe_customer_id;
}

/** Apply a Stripe subscription object (from a webhook). Older events never overwrite newer ones. */
export async function applyStripeSubscription(sub: Stripe.Subscription, eventCreated: number) {
  const kind = sub.metadata?.kind as PlanKind | undefined;
  const userId = sub.metadata?.userId || null;
  const teamId = sub.metadata?.teamId || null;
  if (kind !== "personal" && kind !== "team") return { applied: false, reason: "no plan metadata" };
  if ((kind === "personal" && !userId) || (kind === "team" && !teamId)) return { applied: false, reason: "missing owner" };
  // The owner may have been deleted since checkout.
  const owner = kind === "personal"
    ? await q1('select 1 from "auth_user" where id = $1', [userId])
    : await q1("select 1 from teams where id = $1", [teamId]);
  if (!owner) return { applied: false, reason: "owner not found" };
  // API versions from 2025 keep the billing period on the subscription items.
  const legacyEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
  const itemEnd = sub.items?.data?.map((i) => (i as unknown as { current_period_end?: number }).current_period_end).filter((x): x is number => !!x);
  const periodEnd = legacyEnd ?? (itemEnd?.length ? Math.max(...itemEnd) : null);
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;
  const r = await q1<{ id: string }>(
    `insert into subscriptions(id, kind, user_id, team_id, provider, status, stripe_subscription_id, stripe_customer_id,
                               current_period_end, cancel_at_period_end, stripe_event_at)
     values ($1,$2,$3,$4,'stripe',$5,$6,$7, to_timestamp($8), $9, $10)
     on conflict (stripe_subscription_id) do update set
       status = excluded.status, stripe_customer_id = excluded.stripe_customer_id,
       current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
       stripe_event_at = excluded.stripe_event_at, updated_at = now()
     where subscriptions.stripe_event_at is null or subscriptions.stripe_event_at <= excluded.stripe_event_at
     returning id`,
    [newId(), kind, kind === "personal" ? userId : null, kind === "team" ? teamId : null, sub.status, sub.id, customer,
      periodEnd, sub.cancel_at_period_end ?? false, eventCreated],
  );
  return { applied: !!r, reason: r ? "ok" : "stale event" };
}

export function appOrigin() {
  return (process.env.APP_ORIGIN ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** Members to bill for a team (per-seat mode). */
export async function seatCount(teamId: string): Promise<number> {
  const r = await q1<{ n: number }>("select count(*)::int as n from team_members where team_id = $1", [teamId]);
  return Math.max(billing.minSeats(), r?.n ?? 0);
}

/**
 * Per-seat mode: set the team's active Stripe subscription quantity to its member count (prorated).
 * Best effort: a failure is logged and the next membership change (or a webhook) corrects it.
 */
export async function syncTeamSeats(teamId: string): Promise<void> {
  if (!billing.enabled() || !billing.configured() || !billing.perSeat()) return;
  const sub = await q1<{ stripe_subscription_id: string }>(
    `select stripe_subscription_id from subscriptions s where s.team_id = $1 and s.provider = 'stripe' and ${activeSql(2)}
      order by s.updated_at desc limit 1`, [teamId, ACTIVE]);
  if (!sub?.stripe_subscription_id) return;
  try {
    const st = stripe();
    const current = await st.subscriptions.retrieve(sub.stripe_subscription_id);
    const item = current.items.data[0];
    const want = await seatCount(teamId);
    if (!item || item.quantity === want) return;
    await st.subscriptions.update(sub.stripe_subscription_id, {
      items: [{ id: item.id, quantity: want }], proration_behavior: "create_prorations",
    });
  } catch (e) {
    console.error("[billing] seat sync failed for team", teamId, e instanceof Error ? e.message : e);
  }
}
