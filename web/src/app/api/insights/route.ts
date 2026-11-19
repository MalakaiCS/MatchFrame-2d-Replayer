import { replayAccess, requireUser } from "@/lib/access";
import { badRequest, json, notFound, route } from "@/lib/http";
import { insightsFor, type InsightFilter, type Layer, type NadePoint, type Point, selectPoints } from "@/lib/insights";
import { indexedReplays, teamKey } from "@/lib/statIndex";
import { statReplays } from "@/lib/statQuery";
import type { GrenadeType, TeamKey } from "@/shared/contract";

export const dynamic = "force-dynamic";

const LAYERS: Layer[] = ["pos", "kills", "deaths", "nades"];
const TYPES: GrenadeType[] = ["smoke", "flash", "he", "molotov", "incendiary", "decoy"];
/** Most recent demos of the map that go into a cross-demo heatmap. */
const MAX_DEMOS = 30;
/** Insights built per request; the rest are reported as pending (the page asks again). */
const BUILD_BUDGET = 6;

function filterFrom(u: URL): InsightFilter {
  const layer = (u.searchParams.get("layer") ?? "pos") as Layer;
  if (!LAYERS.includes(layer)) throw badRequest("Unknown layer.");
  const side = u.searchParams.get("side") ?? "all";
  if (!["all", "CT", "T"].includes(side)) throw badRequest("Unknown side.");
  const type = u.searchParams.get("type");
  if (type && !TYPES.includes(type as GrenadeType)) throw badRequest("Unknown grenade type.");
  const num = (k: string, d: number) => {
    const v = Number(u.searchParams.get(k));
    return u.searchParams.has(k) && Number.isFinite(v) ? v : d;
  };
  return {
    layer, side: side as InsightFilter["side"], from: num("from", 0), to: num("to", 10_000),
    player: u.searchParams.get("player") || null, nadeType: (type as GrenadeType) || null,
  };
}

/**
 * Heatmap points or grenade throws. Either one replay (`replay` + `team` A/B; read-only links work)
 * or one in-game team across your demos of a map (`name` + `map`, plus the usual space filter).
 */
export const GET = route(async (req: Request) => {
  const u = new URL(req.url);
  const f = filterFrom(u);
  const out = { points: [] as Point[], nades: [] as NadePoint[] };
  const players = new Map<string, string>();

  const replayId = u.searchParams.get("replay");
  if (replayId) {
    const team = u.searchParams.get("team") as TeamKey;
    if (team !== "A" && team !== "B") throw badRequest("Pick team A or B.");
    const a = await replayAccess(req, replayId);
    if (a.replay.status !== "ready" || !a.replay.published_prefix || !a.replay.published_revision) throw notFound();
    const ins = await insightsFor({ id: a.replay.id, published_revision: a.replay.published_revision, published_prefix: a.replay.published_prefix });
    // A round link only shows its round.
    if (a.shareRoundId) {
      const keep = ins.rounds.findIndex((r) => r.id === a.shareRoundId);
      const one = { ...ins, pos: { r: [] as number[], p: [] as number[], s: [] as number[], x: [] as number[], y: [] as number[], z: [] as number[] }, kills: ins.kills.filter((k) => k.r === keep), nades: ins.nades.filter((n) => n.r === keep) };
      ins.pos.r.forEach((r, i) => { if (r === keep) for (const c of ["r", "p", "s", "x", "y", "z"] as const) one.pos[c].push(ins.pos[c][i]); });
      selectPoints(one, a.replay.id, team, f, out);
    } else selectPoints(ins, a.replay.id, team, f, out);
    for (const p of ins.players) if (p.team === team) players.set(p.steamId ?? p.id, p.name);
    return json({ mapId: ins.mapId, demos: 1, pending: 0, players: [...players].map(([key, name]) => ({ key, name })), ...out });
  }

  const user = await requireUser(req);
  const name = (u.searchParams.get("name") ?? "").trim();
  const map = (u.searchParams.get("map") ?? "").trim();
  if (!name || !map) throw badRequest("Give a team name and a map.");
  const rows = (await statReplays(user, u)).filter((r) => r.map_id === map);
  const { replays } = await indexedReplays(rows);
  const key = teamKey(name);
  const matched = replays
    .map((r) => ({ r, side: (["A", "B"] as TeamKey[]).find((k) => r.summary.teams[k].nameSource !== "fallback" && teamKey(r.summary.teams[k].name) === key) }))
    .filter((x): x is { r: (typeof replays)[number]; side: TeamKey } => !!x.side)
    .slice(0, MAX_DEMOS);
  if (!matched.length) throw notFound();
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const cached = new Set((await import("@/lib/db").then(({ q }) => q<{ replay_id: string; revision: number }>(
    "select replay_id, revision from replay_insights where replay_id = any($1::text[])", [matched.map((x) => x.r.id)],
  ))).filter((c) => rowById.get(c.replay_id)?.published_revision === c.revision).map((c) => c.replay_id));
  let budget = BUILD_BUDGET;
  let pending = 0;
  let used = 0;
  for (const { r, side } of matched) {
    const row = rowById.get(r.id)!;
    if (!cached.has(r.id)) {
      if (budget <= 0) { pending += 1; continue; }
      budget -= 1;
    }
    const ins = await insightsFor(row);
    selectPoints(ins, r.id, side, f, out);
    for (const p of ins.players) if (p.team === side) players.set(p.steamId ?? p.id, p.name);
    used += 1;
  }
  return json({ mapId: map, demos: used, pending, players: [...players].map(([k, n]) => ({ key: k, name: n })), ...out });
});
