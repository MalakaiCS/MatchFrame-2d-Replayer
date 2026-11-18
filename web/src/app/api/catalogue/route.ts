import { requireUser } from "@/lib/access";
import { q } from "@/lib/db";
import { json, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Public / competition catalogue. Entries come only from licensed, project-owned
 * or approved provider feeds (see docs/catalogue.md). Entries the user is not
 * entitled to are listed as locked, without a replay id.
 */
export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const u = new URL(req.url);
  const search = (u.searchParams.get("q") ?? "").trim().slice(0, 100).replace(/[%_\\]/g, (m) => "\\" + m);
  const map = (u.searchParams.get("map") ?? "").trim();
  const rows = await q<{
    id: string; provider: string; event_name: string | null; match_name: string; series_id: string | null; map_index: number | null;
    map_id: string | null; licence: string; provenance_url: string | null; entitlement: string; replay_id: string | null;
    played_at: string | null; status: string | null; entitled: boolean;
  }>(
    `select c.*, r.status,
            (c.entitlement = 'public' or exists (
               select 1 from catalogue_entitlements e where e.provider = c.provider and (e.user_id = $1 or exists (
                 select 1 from team_members m where m.team_id = e.team_id and m.user_id = $1)))) as entitled
       from catalogue_entries c left join replays r on r.id = c.replay_id and r.deleted_at is null
      where ($2 = '' or c.match_name ilike '%' || $2 || '%' or c.event_name ilike '%' || $2 || '%')
        and ($3 = '' or c.map_id = $3)
      order by c.played_at desc nulls last, c.series_id, c.map_index limit 300`,
    [user.id, search, map],
  );
  return json({
    entries: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      eventName: r.event_name,
      matchName: r.match_name,
      seriesId: r.series_id,
      mapIndex: r.map_index,
      mapId: r.map_id,
      licence: r.licence,
      provenanceUrl: r.provenance_url,
      playedAt: r.played_at,
      entitled: r.entitled,
      replayId: r.entitled && r.status === "ready" ? r.replay_id : null,
      status: r.entitled ? (r.status ?? "unavailable") : "locked",
    })),
  });
});
