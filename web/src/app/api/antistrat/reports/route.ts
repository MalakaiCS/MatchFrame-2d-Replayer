import { requireUser } from "@/lib/access";
import { areaReport, Callouts } from "@/lib/areas";
import { body, json, route } from "@/lib/http";
import { loadTeamDemos, ReportsReq } from "@/lib/teamDemos";

export const dynamic = "force-dynamic";

/** One report per player of yours: what the opponent does in that player's area, on each side. */
export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  const r = await body(req, ReportsReq);
  const u = new URL(req.url);
  u.searchParams.set("space", r.space);
  if (r.teamId) u.searchParams.set("teamId", r.teamId);
  const { demos, pending } = await loadTeamDemos(user, u, r.opponent, r.map, r.ids);
  const co = new Callouts(demos);
  return json({
    opponent: r.opponent, map: r.map, demos: demos.length, pending, callouts: co.real,
    reports: r.players.map((p) => ({
      name: p.name, role: p.role,
      CT: p.CT.length ? areaReport(demos, co, p.CT, "CT") : null,
      T: p.T.length ? areaReport(demos, co, p.T, "T") : null,
    })),
  });
});
