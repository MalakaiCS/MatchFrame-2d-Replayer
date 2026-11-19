import { requireUser } from "@/lib/access";
import { json, route } from "@/lib/http";
import { indexedReplays, listTeams } from "@/lib/statIndex";
import { statReplays } from "@/lib/statQuery";

export const dynamic = "force-dynamic";

/** In-game teams found in the demos you can open, with demo counts and records. */
export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const rows = await statReplays(user, new URL(req.url));
  const { replays, pending } = await indexedReplays(rows);
  return json({
    demos: replays.length,
    withPlayerStats: replays.filter((r) => r.summary.hasPlayers).length,
    unnamed: replays.filter((r) => Object.values(r.summary.teams).every((t) => t.nameSource === "fallback")).length,
    pending,
    teams: listTeams(replays),
  });
});
