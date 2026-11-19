import { requireUser } from "@/lib/access";
import { json, route } from "@/lib/http";
import { q } from "@/lib/db";
import { indexedReplays, listTeams, teamKey } from "@/lib/statIndex";
import { statReplays } from "@/lib/statQuery";

export const dynamic = "force-dynamic";

/** In-game teams found in the demos you can open, with demo counts and records. */
export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const rows = await statReplays(user, new URL(req.url));
  const { replays, pending } = await indexedReplays(rows);
  // Watched teams, with demos added since you last opened their page.
  const watches = await q<{ team_key: string; team_name: string; last_seen_at: Date }>(
    "select team_key, team_name, last_seen_at from team_watches where user_id = $1 order by team_name", [user.id]);
  const watched = watches.map((w) => {
    const seen = new Date(w.last_seen_at).toISOString();
    const mine = replays.filter((r) => Object.values(r.summary.teams).some((t) => t.nameSource !== "fallback" && teamKey(t.name) === w.team_key));
    return { key: w.team_key, name: w.team_name, demos: mine.length, newDemos: mine.filter((r) => r.createdAt > seen).length };
  });
  return json({
    watched,
    demos: replays.length,
    withPlayerStats: replays.filter((r) => r.summary.hasPlayers).length,
    unnamed: replays.filter((r) => Object.values(r.summary.teams).every((t) => t.nameSource === "fallback")).length,
    pending,
    teams: listTeams(replays),
  });
});
