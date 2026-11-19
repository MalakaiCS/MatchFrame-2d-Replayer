/**
 * Authorisation for replays and everything anchored to them.
 * Every manifest, payload, review and audio request goes through replayAccess().
 */
import { getUser, type SessionUser } from "./auth";
import { q, q1 } from "./db";
import { forbidden, notFound, unauthorized } from "./http";
import { sha256 } from "./ids";

export const SHARE_HEADER = "x-share-token";

export type TeamRole = "owner" | "coach" | "analyst" | "player" | "viewer";
export const REVIEW_ROLES: TeamRole[] = ["owner", "coach", "analyst", "player"];
export const MANAGE_ROLES: TeamRole[] = ["owner", "coach"];

export interface ReplayRow {
  id: string;
  owner_id: string;
  team_id: string | null;
  title: string | null;
  status: string;
  failure_code: string | null;
  failure_detail: string | null;
  visibility: "private" | "team" | "unlisted" | "catalogue";
  source_type: string | null;
  source_key: string | null;
  source_filename: string | null;
  revision: number;
  published_revision: number | null;
  published_prefix: string | null;
  map_id: string | null;
  team_a_name: string | null;
  team_b_name: string | null;
  team_a_override: string | null;
  team_b_override: string | null;
  score_a: number | null;
  score_b: number | null;
  round_count: number | null;
  series_id: string | null;
  series_map_index: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Access {
  replay: ReplayRow;
  user: SessionUser | null;
  via: "owner" | "team" | "grant" | "catalogue" | "share";
  canManage: boolean;
  canReview: boolean;
  shareLinkId: string | null;
  /** Set when the share link only opens one round (a "round link"). */
  shareRoundId?: string | null;
  /** Teams of the viewer (empty for share-link viewers). */
  teams: { team_id: string; role: TeamRole }[];
}

export async function userTeams(userId: string) {
  return q<{ team_id: string; role: TeamRole }>("select team_id, role from team_members where user_id = $1", [userId]);
}

export async function shareLinkFor(replayId: string, token: string | null) {
  if (!token || token.length < 20 || token.length > 100) return null;
  return q1<{ id: string; round_id: string | null }>(
    "select id, round_id from share_links where replay_id = $1 and token_hash = $2 and revoked_at is null",
    [replayId, sha256(token)],
  );
}

export async function replayAccess(req: Request, replayId: string, opts: { user?: SessionUser | null } = {}): Promise<Access> {
  if (!/^[A-Za-z0-9]{8,64}$/.test(replayId)) throw notFound();
  const replay = await q1<ReplayRow>("select * from replays where id = $1 and deleted_at is null", [replayId]);
  const user = opts.user !== undefined ? opts.user : await getUser(req.headers);
  const shareToken = req.headers.get(SHARE_HEADER);
  if (!replay) throw user || shareToken ? notFound() : unauthorized();

  if (user) {
    const teams = await userTeams(user.id);
    const base = { replay, user, teams, shareLinkId: null };
    if (replay.owner_id === user.id) return { ...base, via: "owner", canManage: true, canReview: true };
    const roleIn = (teamId: string | null) => teams.find((t) => t.team_id === teamId)?.role;
    if (replay.team_id && replay.visibility !== "private") {
      const role = roleIn(replay.team_id);
      if (role) return { ...base, via: "team", canManage: MANAGE_ROLES.includes(role), canReview: REVIEW_ROLES.includes(role) };
    }
    const grants = await q<{ team_id: string | null; user_id: string | null }>(
      "select team_id, user_id from replay_grants where replay_id = $1", [replayId]);
    for (const g of grants) {
      if (g.user_id === user.id) return { ...base, via: "grant", canManage: false, canReview: true };
      const role = roleIn(g.team_id);
      if (role) return { ...base, via: "grant", canManage: false, canReview: REVIEW_ROLES.includes(role) };
    }
    if (replay.visibility === "catalogue") {
      const entry = await q1<{ entitlement: string; provider: string }>(
        "select entitlement, provider from catalogue_entries where replay_id = $1", [replayId]);
      if (entry?.entitlement === "public") return { ...base, via: "catalogue", canManage: false, canReview: true };
      if (entry) {
        const ent = await q1(
          "select 1 from catalogue_entitlements where provider = $1 and (user_id = $2 or team_id = any($3::text[]))",
          [entry.provider, user.id, teams.map((t) => t.team_id)]);
        if (ent) return { ...base, via: "catalogue", canManage: false, canReview: true };
        throw forbidden("Your account is not entitled to this catalogue demo.");
      }
    }
  }
  const link = await shareLinkFor(replayId, shareToken);
  if (link) return { replay, user, teams: [], via: "share", canManage: false, canReview: false, shareLinkId: link.id, shareRoundId: link.round_id };
  // A supplied but invalid/revoked link reads as "not found", not as a sign-in prompt.
  if (!user && !shareToken) throw unauthorized();
  throw notFound();
}

export async function requireUser(req: Request): Promise<SessionUser> {
  const u = await getUser(req.headers);
  if (!u) throw unauthorized();
  return u;
}

/** SQL fragment: replays visible to $1 (user id) without a share link. */
export const VISIBLE_REPLAYS_SQL = `
  r.deleted_at is null and (
    r.owner_id = $1
    or (r.team_id is not null and r.visibility <> 'private' and exists (select 1 from team_members m where m.team_id = r.team_id and m.user_id = $1))
    or exists (select 1 from replay_grants g where g.replay_id = r.id and (g.user_id = $1 or exists (select 1 from team_members m where m.team_id = g.team_id and m.user_id = $1)))
    or (r.visibility = 'catalogue' and exists (
      select 1 from catalogue_entries c where c.replay_id = r.id and (c.entitlement = 'public' or exists (
        select 1 from catalogue_entitlements e where e.provider = c.provider and (e.user_id = $1 or exists (select 1 from team_members m where m.team_id = e.team_id and m.user_id = $1)))))
    )
  )`;
