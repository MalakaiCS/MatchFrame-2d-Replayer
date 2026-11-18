import { requireUser, VISIBLE_REPLAYS_SQL, type ReplayRow } from "@/lib/access";
import { q } from "@/lib/db";
import { json, route } from "@/lib/http";
import { publicReplay } from "@/lib/replay-view";

export const dynamic = "force-dynamic";

/** Library: replays the signed-in user can open (own, team, granted, entitled catalogue). */
export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const u = new URL(req.url);
  const search = (u.searchParams.get("q") ?? "").trim().slice(0, 100);
  const map = (u.searchParams.get("map") ?? "").trim();
  const scope = u.searchParams.get("scope") ?? "all"; // all | mine | team | catalogue
  const params: unknown[] = [user.id];
  const where = [VISIBLE_REPLAYS_SQL];
  if (search) {
    params.push(`%${search.replace(/[%_\\]/g, (m) => "\\" + m)}%`);
    const i = params.length;
    where.push(`(r.title ilike $${i} or r.team_a_name ilike $${i} or r.team_b_name ilike $${i} or r.team_a_override ilike $${i} or r.team_b_override ilike $${i} or r.source_filename ilike $${i} or r.map_id ilike $${i})`);
  }
  if (map) {
    params.push(map);
    where.push(`r.map_id = $${params.length}`);
  }
  if (scope === "mine") where.push("r.owner_id = $1");
  if (scope === "team") where.push("r.team_id is not null and r.visibility = 'team'");
  if (scope === "catalogue") where.push("r.visibility = 'catalogue'");
  const rows = await q<ReplayRow & { owner_name: string; team_name: string | null; event_name: string | null; provider: string | null; licence: string | null }>(
    `select r.*, u.name as owner_name, t.name as team_name, c.event_name, c.provider, c.licence
       from replays r
       join "auth_user" u on u.id = r.owner_id
       left join teams t on t.id = r.team_id
       left join catalogue_entries c on c.replay_id = r.id
      where ${where.join(" and ")}
      order by r.created_at desc limit 200`,
    params,
  );
  return json({
    replays: rows.map((r) => ({
      ...publicReplay(r),
      ownerName: r.owner_name,
      teamName: r.team_name,
      isOwner: r.owner_id === user.id,
      catalogue: r.visibility === "catalogue" ? { eventName: r.event_name, provider: r.provider, licence: r.licence } : null,
    })),
  });
});
