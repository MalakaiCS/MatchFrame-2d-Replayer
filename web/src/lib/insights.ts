/**
 * Insights: a compact summary of where things happened in a replay, for heatmaps and the grenade
 * lineup library. Built from the published round payloads (so older replays work too), cached in
 * replay_insights per revision.
 *
 * - pos: every alive player's position once per POS_STEP_S seconds from freeze end until the round
 *   is decided.
 * - kills: killer and victim positions, weapon, headshot.
 * - nades: thrower position at the throw (first recorded point of the flight) and where it landed.
 */
import { gunzipSync } from "node:zlib";
import type { GrenadeType, Manifest, RoundPayload, Side, TeamKey } from "@/shared/contract";
import { q, q1 } from "./db";
import { loadManifest } from "./manifest";
import { getStorage } from "./storage";

export const POS_STEP_S = 2;

export interface Insights {
  v: 1;
  mapId: string;
  tickMs: number;
  players: { id: string; name: string; team: TeamKey; steamId: string | null }[];
  rounds: { id: string; n: number; sides: Record<TeamKey, Side>; winner: TeamKey | null; freeze: number; startTick: number }[];
  /** Columnar: round index, player index, seconds since freeze end, x, y, z (rounded). */
  pos: { r: number[]; p: number[]; s: number[]; x: number[]; y: number[]; z: number[] };
  kills: { r: number; s: number; k: number; v: number; kx: number | null; ky: number | null; kz: number | null; vx: number; vy: number; vz: number; w: string | null; hs: boolean }[];
  nades: { r: number; s: number; p: number; type: GrenadeType; ox: number; oy: number; oz: number; lx: number; ly: number; lz: number; tick: number }[];
}

const r0 = (v: number) => Math.round(v);

export function buildInsights(m: Manifest, payloads: Map<string, RoundPayload>): Insights {
  const tickS = m.tickIntervalMs / 1000;
  const players = m.players.map((p) => ({ id: p.id, name: p.name, team: p.team, steamId: p.steamId ?? null }));
  const pIdx = new Map(players.map((p, i) => [p.id, i]));
  const out: Insights = {
    v: 1, mapId: m.map.id, tickMs: m.tickIntervalMs, players,
    rounds: m.rounds.map((r) => ({ id: r.id, n: r.displayNumber, sides: r.sides, winner: r.winner, freeze: r.freezeEndTick ?? r.startTick, startTick: r.startTick })),
    pos: { r: [], p: [], s: [], x: [], y: [], z: [] },
    kills: [],
    nades: [],
  };
  m.rounds.forEach((round, ri) => {
    const pl = payloads.get(round.id);
    if (!pl) return;
    const from = round.freezeEndTick ?? round.startTick;
    const to = round.decidedTick ?? round.endTick;
    const step = Math.max(1, Math.round(POS_STEP_S / tickS));
    for (const tr of pl.tracks) {
      const pi = pIdx.get(tr.playerId);
      if (pi === undefined) continue;
      let next = from;
      for (let i = 0; i < tr.t.length; i++) {
        const t = tr.t[i];
        if (t < next) continue;
        if (t >= to) break;
        next = t + step;
        if (!tr.alive[i]) continue;
        out.pos.r.push(ri); out.pos.p.push(pi); out.pos.s.push(Math.round((t - from) * tickS));
        out.pos.x.push(r0(tr.x[i])); out.pos.y.push(r0(tr.y[i])); out.pos.z.push(r0(tr.z[i]));
      }
    }
    for (const e of pl.events) {
      if (e.type !== "kill" || !e.position || !e.target) continue;
      const v = pIdx.get(e.target);
      if (v === undefined) continue;
      out.kills.push({
        r: ri, s: Math.round((e.tick - from) * tickS), k: e.actor ? pIdx.get(e.actor) ?? -1 : -1, v,
        kx: e.actorPosition ? r0(e.actorPosition.x) : null, ky: e.actorPosition ? r0(e.actorPosition.y) : null, kz: e.actorPosition ? r0(e.actorPosition.z) : null,
        vx: r0(e.position.x), vy: r0(e.position.y), vz: r0(e.position.z), w: e.weapon ?? null, hs: !!e.headshot,
      });
    }
    for (const g of pl.grenades) {
      const p = g.throwerId ? pIdx.get(g.throwerId) : undefined;
      if (p === undefined || !g.path.length) continue;
      const o = g.path[0];
      const land = g.detonation ?? { x: g.path[g.path.length - 1][1], y: g.path[g.path.length - 1][2], z: g.path[g.path.length - 1][3] };
      out.nades.push({
        r: ri, s: Math.round((g.throwTick - from) * tickS), p, type: g.type,
        ox: r0(o[1]), oy: r0(o[2]), oz: r0(o[3]), lx: r0(land.x), ly: r0(land.y), lz: r0(land.z), tick: g.throwTick,
      });
    }
  });
  return out;
}

async function loadPayloads(prefix: string, m: Manifest): Promise<Map<string, RoundPayload>> {
  const st = getStorage();
  const out = new Map<string, RoundPayload>();
  for (const r of m.rounds) {
    try {
      const buf = await st.read(`${prefix}/rounds/${r.id}.json.gz`);
      out.set(r.id, JSON.parse(gunzipSync(buf).toString("utf8")) as RoundPayload);
    } catch (e) {
      console.error("[insights] missing round", prefix, r.id, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

/** Insights for a ready replay, built on first use and cached per revision. */
export async function insightsFor(row: { id: string; published_revision: number; published_prefix: string }): Promise<Insights> {
  const hit = await q1<{ revision: number; data: Insights }>("select revision, data from replay_insights where replay_id = $1", [row.id]);
  if (hit && hit.revision === row.published_revision) return hit.data;
  const m = await loadManifest(row.published_prefix);
  const data = buildInsights(m, await loadPayloads(row.published_prefix, m));
  await q(
    `insert into replay_insights(replay_id, revision, data) values ($1,$2,$3)
     on conflict (replay_id) do update set revision = excluded.revision, data = excluded.data, built_at = now()`,
    [row.id, row.published_revision, JSON.stringify(data)],
  );
  return data;
}

export type Layer = "pos" | "kills" | "deaths" | "nades";
export interface InsightFilter {
  layer: Layer;
  side: "all" | Side;
  /** Seconds since freeze end. */
  from: number;
  to: number;
  /** Player key (steam id or player id); null = whole team. */
  player: string | null;
  nadeType: GrenadeType | null;
}

export interface Point { x: number; y: number; z: number }
export interface NadePoint {
  type: GrenadeType; ox: number; oy: number; oz: number; lx: number; ly: number; lz: number;
  replayId: string; roundId: string; roundNumber: number; ms: number; won: boolean; player: string; side: Side;
}

/** Points for one team (by key in that replay) under a filter. */
export function selectPoints(ins: Insights, replayId: string, team: TeamKey, f: InsightFilter, out: { points: Point[]; nades: NadePoint[] }) {
  const key = (i: number) => ins.players[i].steamId ?? ins.players[i].id;
  const sideOf = (ri: number) => ins.rounds[ri].sides[team];
  const okRound = (ri: number) => f.side === "all" || sideOf(ri) === f.side;
  const okPlayer = (pi: number) => pi >= 0 && ins.players[pi].team === team && (!f.player || key(pi) === f.player);
  const okTime = (s: number) => s >= f.from && s <= f.to;
  if (f.layer === "pos") {
    const P = ins.pos;
    for (let i = 0; i < P.r.length; i++) {
      if (okRound(P.r[i]) && okPlayer(P.p[i]) && okTime(P.s[i])) out.points.push({ x: P.x[i], y: P.y[i], z: P.z[i] });
    }
  } else if (f.layer === "kills") {
    for (const k of ins.kills) {
      if (k.kx !== null && okRound(k.r) && okPlayer(k.k) && okTime(k.s) && ins.players[k.v].team !== team) out.points.push({ x: k.kx, y: k.ky!, z: k.kz! });
    }
  } else if (f.layer === "deaths") {
    for (const k of ins.kills) {
      if (okRound(k.r) && okPlayer(k.v) && okTime(k.s)) out.points.push({ x: k.vx, y: k.vy, z: k.vz });
    }
  } else {
    for (const n of ins.nades) {
      if (!okRound(n.r) || !okPlayer(n.p) || !okTime(n.s) || (f.nadeType && n.type !== f.nadeType)) continue;
      const rd = ins.rounds[n.r];
      out.nades.push({
        type: n.type, ox: n.ox, oy: n.oy, oz: n.oz, lx: n.lx, ly: n.ly, lz: n.lz, replayId, roundId: rd.id, roundNumber: rd.n,
        ms: Math.max(0, Math.round((n.tick - rd.startTick) * ins.tickMs)), won: rd.winner === team, player: ins.players[n.p].name, side: sideOf(n.r),
      });
    }
  }
}
