import { requireUser } from "@/lib/access";
import { q } from "@/lib/db";
import { badRequest, json, route } from "@/lib/http";
import { insightsFor, INSIGHTS_VERSION } from "@/lib/insights";
import { roundView, type Tag, TAGS } from "@/lib/roundTags";
import { indexedReplays, teamKey } from "@/lib/statIndex";
import { statReplays } from "@/lib/statQuery";
import type { TeamKey } from "@/shared/contract";

export const dynamic = "force-dynamic";

/** Demos searched per request (newest first) and insights built per request (the rest are pending). */
const MAX_DEMOS = 200;
const BUILD_BUDGET = 6;
const MAX_RESULTS = 300;

/**
 * Find rounds across your demos: map, team (by in-game name; both teams when empty), side, buy, tags
 * (all must match), plant site and result. Each result links to the round in the replay.
 */
export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const u = new URL(req.url);
  const map = (u.searchParams.get("map") ?? "").trim();
  const name = (u.searchParams.get("team") ?? "").trim();
  const side = u.searchParams.get("side") ?? "";
  const result = u.searchParams.get("result") ?? "";
  const site = (u.searchParams.get("site") ?? "").trim().toUpperCase();
  const tags = (u.searchParams.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean) as Tag[];
  if (side && side !== "CT" && side !== "T") throw badRequest("Side must be CT or T.");
  if (result && result !== "won" && result !== "lost") throw badRequest("Result must be won or lost.");
  if (tags.some((t) => !TAGS.includes(t))) throw badRequest("Unknown tag.");

  let rows = await statReplays(user, u);
  if (map) rows = rows.filter((r) => r.map_id === map);
  rows = rows.slice(0, MAX_DEMOS);
  const { replays } = await indexedReplays(rows);
  const key = name ? teamKey(name) : null;
  const wanted = replays
    .map((r) => ({
      r,
      teams: (["A", "B"] as TeamKey[]).filter((k) => !key || (r.summary.teams[k].nameSource !== "fallback" && teamKey(r.summary.teams[k].name) === key)),
    }))
    .filter((x) => x.teams.length);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const fresh = new Set((await q<{ replay_id: string; revision: number; v: number }>(
    "select replay_id, revision, (data->>'v')::int as v from replay_insights where replay_id = any($1::text[])", [wanted.map((w) => w.r.id)],
  )).filter((c) => rowById.get(c.replay_id)?.published_revision === c.revision && c.v === INSIGHTS_VERSION).map((c) => c.replay_id));

  let budget = BUILD_BUDGET;
  let pending = 0;
  let searched = 0;
  const results: unknown[] = [];
  for (const { r, teams } of wanted) {
    if (!fresh.has(r.id)) {
      if (budget <= 0) { pending += 1; continue; }
      budget -= 1;
    }
    const ins = await insightsFor(rowById.get(r.id)!);
    searched += 1;
    for (const team of teams) {
      const opp: TeamKey = team === "A" ? "B" : "A";
      for (let ri = 0; ri < ins.rounds.length; ri++) {
        const v = roundView(ins, ri, team);
        if (side && v.side !== side) continue;
        if (result && (result === "won") !== v.won) continue;
        if (site && (v.plantSite ?? "").toUpperCase() !== site) continue;
        if (tags.some((t) => !v.tags.includes(t))) continue;
        if (results.length >= MAX_RESULTS) break;
        results.push({
          replayId: r.id, title: r.title, mapId: r.mapId, when: r.playedAt ?? r.createdAt,
          team: r.summary.teams[team].name, opponent: r.summary.teams[opp].name, ...v,
          ms: Math.max(0, Math.round((ins.rounds[ri].freeze - ins.rounds[ri].startTick) * ins.tickMs)),
        });
      }
    }
  }
  return json({ searched, pending, truncated: results.length >= MAX_RESULTS, results });
});
