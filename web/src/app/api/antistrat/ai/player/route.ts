import { requireUser } from "@/lib/access";
import { aiEnabled, writePlayerBrief } from "@/lib/antistratAi";
import { areaReport, Callouts, findDefaults } from "@/lib/areas";
import { badRequest, body, HttpError, json, route } from "@/lib/http";
import { loadTeamDemos, ReportsReq } from "@/lib/teamDemos";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** AI anti-strat sheet for one of your players, written from their area report. */
export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!aiEnabled()) throw new HttpError(503, "AI_DISABLED", "AI briefs are not enabled on this server.");
  const r = await body(req, ReportsReq);
  if (r.players.length !== 1) throw badRequest("Ask for one player at a time.");
  const p = r.players[0];
  if (!p.CT.length && !p.T.length) throw badRequest("Give the player's area first.");
  const u = new URL(req.url);
  u.searchParams.set("space", r.space);
  if (r.teamId) u.searchParams.set("teamId", r.teamId);
  const { demos, pending } = await loadTeamDemos(user, u, r.opponent, r.map, r.ids);
  if (pending) throw new HttpError(409, "PENDING", "Some demos are still being prepared. Wait for the reports to finish loading.");
  const co = new Callouts(demos);
  const brief = await writePlayerBrief(r.opponent, r.map, p,
    p.CT.length ? areaReport(demos, co, p.CT, "CT") : null, p.T.length ? areaReport(demos, co, p.T, "T") : null, findDefaults(demos, co));
  return json({ brief });
});
