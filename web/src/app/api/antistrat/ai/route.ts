import { z } from "zod";
import { requireUser } from "@/lib/access";
import { aiEnabled, writeBrief } from "@/lib/antistratAi";
import { badRequest, body, HttpError, json, route } from "@/lib/http";
import { findPatterns } from "@/lib/patterns";
import { loadTeamDemos } from "@/lib/teamDemos";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Req = z.object({
  name: z.string().trim().min(1).max(80),
  map: z.string().trim().min(1).max(64),
  ids: z.array(z.string().regex(/^[\w-]{1,64}$/)).max(100).nullable().default(null),
  space: z.enum(["all", "personal", "team"]).default("all"),
  teamId: z.string().max(64).optional(),
});

/** AI anti-strat brief written from the same patterns the page shows. */
export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!aiEnabled()) throw new HttpError(503, "AI_DISABLED", "AI briefs are not enabled on this server.");
  const r = await body(req, Req);
  const u = new URL(req.url);
  u.searchParams.set("space", r.space);
  if (r.teamId) u.searchParams.set("teamId", r.teamId);
  const { demos, pending } = await loadTeamDemos(user, u, r.name, r.map, r.ids);
  if (pending) throw new HttpError(409, "PENDING", "Some demos are still being prepared. Wait for the patterns to finish loading.");
  const report = findPatterns(demos);
  if (!report.patterns.length) throw badRequest("No patterns found yet: add more demos of this team on this map.");
  return json({ brief: await writeBrief(r.name, r.map, report) });
});
