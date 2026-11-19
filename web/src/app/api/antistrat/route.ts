import { requireUser } from "@/lib/access";
import { aiEnabled } from "@/lib/antistratAi";
import { badRequest, json, route } from "@/lib/http";
import { Callouts, calloutList, findDefaults } from "@/lib/areas";
import { findPatterns } from "@/lib/patterns";
import { idsParam, loadTeamDemos } from "@/lib/teamDemos";

export const dynamic = "force-dynamic";

/**
 * Pattern finder for one in-game team on one map. Automatic: all of the team's demos (newest 40).
 * Manual: only the demos in `ids`. The demo list always comes back so the page can show it.
 */
export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const u = new URL(req.url);
  const name = (u.searchParams.get("name") ?? "").trim();
  const map = (u.searchParams.get("map") ?? "").trim();
  if (!name || !map) throw badRequest("Give a team name and a map.");
  const { demos, list, pending } = await loadTeamDemos(user, u, name, map, idsParam(u));
  const co = new Callouts(demos);
  return json({
    team: name, map, list, pending, ai: aiEnabled(), report: findPatterns(demos),
    defaults: findDefaults(demos, co), callouts: calloutList(co),
  });
});
