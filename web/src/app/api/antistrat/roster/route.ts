import { requireUser } from "@/lib/access";
import { Callouts, calloutList, yourAreas } from "@/lib/areas";
import { badRequest, HttpError, json, route } from "@/lib/http";
import { loadTeamDemos } from "@/lib/teamDemos";

export const dynamic = "force-dynamic";

/**
 * Your team's players on a map with the area each one usually plays (CT at 0:15, T at 0:20), worked
 * out from your own demos. No demos of your team on this map: an empty roster to fill in by hand.
 */
export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const u = new URL(req.url);
  const name = (u.searchParams.get("name") ?? "").trim();
  const map = (u.searchParams.get("map") ?? "").trim();
  if (!name || !map) throw badRequest("Give your team name and a map.");
  try {
    const { demos, pending } = await loadTeamDemos(user, u, name, map, null);
    const co = new Callouts(demos);
    return json({ team: name, map, demos: demos.length, pending, players: yourAreas(demos, co), callouts: calloutList(co) });
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return json({ team: name, map, demos: 0, pending: 0, players: [], callouts: [] });
    throw e;
  }
});
