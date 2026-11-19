import { requireUser } from "@/lib/access";
import { badRequest, json, notFound, route } from "@/lib/http";
import { indexedReplays, teamDetail, teamKey } from "@/lib/statIndex";
import { statReplays } from "@/lib/statQuery";

export const dynamic = "force-dynamic";

/** One in-game team across your demos: record per map, players, matches and opponents. */
export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const name = (url.searchParams.get("name") ?? "").trim();
  if (!name || name.length > 80) throw badRequest("Give a team name.");
  const map = (url.searchParams.get("map") ?? "").trim() || null;
  const { replays, pending } = await indexedReplays(await statReplays(user, url));
  const detail = teamDetail(replays, teamKey(name), map);
  if (!detail) throw notFound();
  return json({ pending, ...detail });
});
