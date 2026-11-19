import { VISIBLE_REPLAYS_SQL } from "./access";
import type { SessionUser } from "./auth";
import { billing, coverage, paymentRequired } from "./billing";
import { q } from "./db";

/**
 * Ready replays the user can open, limited to a space (personal / one team / all) and, when plans
 * are enforced, to what their plan covers. Newest first.
 */
export async function statReplays(user: SessionUser, url: URL) {
  const space = url.searchParams.get("space") ?? "all";
  const teamId = (url.searchParams.get("teamId") ?? "").trim();
  const params: unknown[] = [user.id];
  const where = [VISIBLE_REPLAYS_SQL, "r.status = 'ready'", "r.published_prefix is not null"];
  if (space === "personal") {
    where.push(`((r.owner_id = $1 and (r.team_id is null or r.visibility = 'private'))
      or exists (select 1 from replay_grants g where g.replay_id = r.id and g.user_id = $1))`);
  } else if (space === "team" && teamId) {
    params.push(teamId);
    const i = params.length;
    where.push(`((r.team_id = $${i} and r.visibility = 'team') or exists (select 1 from replay_grants g where g.replay_id = r.id and g.team_id = $${i}))`);
  }
  if (billing.enabled()) {
    const c = await coverage(user.id);
    if (!c.personal) {
      if (!c.teams.size) throw paymentRequired("Stats across demos need a personal or team plan.");
      params.push([...c.teams]);
      const i = params.length;
      where.push(`((r.team_id = any($${i}::text[]) and r.visibility = 'team') or exists (select 1 from replay_grants g where g.replay_id = r.id and g.team_id = any($${i}::text[])))`);
    }
  }
  return q<{
    id: string; title: string | null; map_id: string | null; created_at: string; played_at: string | null; series_id: string | null;
    published_revision: number; published_prefix: string; team_a_override: string | null; team_b_override: string | null;
  }>(
    `select r.id, r.title, r.map_id, r.created_at, r.played_at, r.series_id, r.published_revision, r.published_prefix,
            r.team_a_override, r.team_b_override
       from replays r where ${where.join(" and ")} order by coalesce(r.played_at, r.created_at) desc limit 500`,
    params,
  );
}
