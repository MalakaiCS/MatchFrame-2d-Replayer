import { requireUser } from "@/lib/access";
import { q } from "@/lib/db";
import { badRequest, json, notFound, route } from "@/lib/http";
import { insightsFor, INSIGHTS_VERSION } from "@/lib/insights";
import { roundView, type Tag } from "@/lib/roundTags";
import { indexedReplays, teamKey } from "@/lib/statIndex";
import { statReplays } from "@/lib/statQuery";
import type { TeamKey } from "@/shared/contract";

export const dynamic = "force-dynamic";

const MAX_DEMOS = 60;
const BUILD_BUDGET = 6;

interface Rate { n: number; of: number }
const rate = (): Rate => ({ n: 0, of: 0 });

/**
 * How a team tends to play, from the round tags across its demos (optionally one map):
 * T-side pace and site choice, post-plant conversion, CT retakes, pistol / eco / force results,
 * saves and opening duels.
 */
export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const u = new URL(req.url);
  const name = (u.searchParams.get("name") ?? "").trim();
  const map = (u.searchParams.get("map") ?? "").trim();
  if (!name) throw badRequest("Give a team name.");
  let rows = await statReplays(user, u);
  if (map) rows = rows.filter((r) => r.map_id === map);
  const { replays } = await indexedReplays(rows.slice(0, 500));
  const key = teamKey(name);
  const matched = replays
    .map((r) => ({ r, team: (["A", "B"] as TeamKey[]).find((k) => r.summary.teams[k].nameSource !== "fallback" && teamKey(r.summary.teams[k].name) === key) }))
    .filter((x): x is { r: (typeof replays)[number]; team: TeamKey } => !!x.team)
    .slice(0, MAX_DEMOS);
  if (!matched.length) throw notFound();
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const fresh = new Set((await q<{ replay_id: string; revision: number; v: number }>(
    "select replay_id, revision, (data->>'v')::int as v from replay_insights where replay_id = any($1::text[])", [matched.map((m) => m.r.id)],
  )).filter((c) => rowById.get(c.replay_id)?.published_revision === c.revision && c.v === INSIGHTS_VERSION).map((c) => c.replay_id));

  const t = {
    rounds: 0, fast: 0, execute: 0, late: 0, noPlant: 0, siteA: 0, siteB: 0,
    plantWin: rate(), noPlantWin: rate(), avgPlantS: 0, plants: 0,
  };
  const ct = { rounds: 0, retake: rate(), won: rate() };
  const econ = { pistol: rate(), eco: rate(), half: rate(), full: rate(), antiEco: rate() };
  const save = rate();
  const opening = rate();
  let budget = BUILD_BUDGET;
  let pending = 0;
  let used = 0;
  for (const { r, team } of matched) {
    if (!fresh.has(r.id)) {
      if (budget <= 0) { pending += 1; continue; }
      budget -= 1;
    }
    const ins = await insightsFor(rowById.get(r.id)!);
    used += 1;
    for (let ri = 0; ri < ins.rounds.length; ri++) {
      const v = roundView(ins, ri, team);
      const has = (x: Tag) => v.tags.includes(x);
      const add = (x: Rate, ok: boolean) => { x.of += 1; if (ok) x.n += 1; };
      if (v.side === "T") {
        t.rounds += 1;
        if (has("fast_plant")) t.fast += 1;
        if (has("execute")) t.execute += 1;
        if (has("late_plant")) t.late += 1;
        if (has("no_plant")) { t.noPlant += 1; add(t.noPlantWin, v.won); }
        else { add(t.plantWin, v.won); t.plants += 1; t.avgPlantS += v.plantS ?? 0; }
        if ((v.plantSite ?? "").toUpperCase() === "A") t.siteA += 1;
        if ((v.plantSite ?? "").toUpperCase() === "B") t.siteB += 1;
      } else {
        ct.rounds += 1;
        add(ct.won, v.won);
        // Retake chances: the bomb was planted against them.
        if (ins.rounds[ri].plant) add(ct.retake, has("retake_won"));
      }
      if (has("pistol")) add(econ.pistol, v.won);
      if (has("eco")) add(econ.eco, v.won);
      if (has("half_buy")) add(econ.half, v.won);
      if (has("full_buy")) add(econ.full, v.won);
      if (has("anti_eco")) add(econ.antiEco, v.won);
      if (!v.won) add(save, has("save"));
      if (has("opening_kill") || has("opening_death")) add(opening, has("opening_kill"));
    }
  }
  return json({
    demos: used, pending,
    tSide: { ...t, avgPlantS: t.plants ? Math.round(t.avgPlantS / t.plants) : null },
    ctSide: ct, economy: econ, saves: save, opening,
  });
});
