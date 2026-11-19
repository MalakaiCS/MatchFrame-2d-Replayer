/**
 * Cross-demo stats. Each ready replay is summarised once into replay_stat_index (lazily, on first
 * use, and again after a new revision is published). Pages then aggregate these small summaries
 * instead of opening every manifest.
 *
 * In-game teams are grouped by name (clan tag, or a name edited on the replay). Replays whose team
 * names are only the "Team Alpha"/"Team Bravo" fallbacks are left out of team pages.
 */
import type { Manifest, PlayerRoundStats, Side, TeamKey } from "@/shared/contract";
import { addRound, derive, type PlayerTotals, rating10 } from "@/viewer/stats";
import { q } from "./db";
import { loadManifest } from "./manifest";

export interface WL { w: number; p: number }
export interface TeamSummary {
  key: TeamKey; name: string; nameSource: string; score: number; oppScore: number;
  rounds: WL; ct: WL; t: WL; pistol: WL; opening: WL; clutch: WL; startSide: Side;
}
export interface PlayerSummary extends PlayerTotals { steamId: string | null; isBot: boolean }
export interface ReplaySummary { teams: Record<TeamKey, TeamSummary>; players: PlayerSummary[]; hasPlayers: boolean }

const wl = (): WL => ({ w: 0, p: 0 });

export function summarizeManifest(m: Manifest): ReplaySummary {
  const teams = {} as Record<TeamKey, TeamSummary>;
  for (const k of ["A", "B"] as TeamKey[]) {
    const o: TeamKey = k === "A" ? "B" : "A";
    teams[k] = {
      key: k, name: m.teams[k].name, nameSource: m.teams[k].nameSource, score: m.finalScore[k], oppScore: m.finalScore[o],
      rounds: wl(), ct: wl(), t: wl(), pistol: wl(), opening: wl(), clutch: wl(), startSide: m.teams[k].startSide,
    };
  }
  const teamOf = new Map(m.players.map((p) => [p.id, p.team]));
  const totals = new Map<string, PlayerSummary>();
  for (const p of m.players) {
    totals.set(p.id, {
      id: p.id, name: p.name, team: p.team, steamId: p.steamId ?? null, isBot: p.isBot, rounds: 0, k: 0, d: 0, a: 0, fa: 0, hs: 0, tk: 0,
      dmg: 0, ud: 0, ef: 0, fd: 0, ok: 0, od: 0, trk: 0, trd: 0, kast: 0, surv: 0, clutches: 0, clutchesWon: 0, clutchByVs: {},
      multi: { 2: 0, 3: 0, 4: 0, 5: 0 }, oneK: 0,
    });
  }
  let hasPlayers = false;
  for (const r of m.rounds) {
    for (const k of ["A", "B"] as TeamKey[]) {
      const t = teams[k];
      const side = r.sides[k];
      const won = r.winner === k ? 1 : 0;
      t.rounds.p += 1; t.rounds.w += won;
      t[side === "CT" ? "ct" : "t"].p += 1;
      t[side === "CT" ? "ct" : "t"].w += won;
      if (r.isPistol) { t.pistol.p += 1; t.pistol.w += won; }
    }
    for (const [pid, s] of Object.entries(r.playerStats ?? {}) as [string, PlayerRoundStats][]) {
      hasPlayers = true;
      const tot = totals.get(pid);
      if (tot) addRound(tot, s);
      const key = teamOf.get(pid);
      if (!key) continue;
      if (s.ok) { teams[key].opening.w += 1; teams[key].opening.p += 1; }
      if (s.od) teams[key].opening.p += 1;
      if (s.cl) { teams[key].clutch.p += 1; teams[key].clutch.w += s.cw; }
    }
  }
  return { teams, players: [...totals.values()].filter((p) => p.rounds > 0), hasPlayers };
}

export interface IndexedReplay {
  id: string; title: string | null; mapId: string | null; createdAt: string; playedAt: string | null;
  seriesId: string | null; summary: ReplaySummary;
}

interface ReplayRow {
  id: string; title: string | null; map_id: string | null; created_at: string; played_at: string | null; series_id: string | null;
  published_revision: number; published_prefix: string; team_a_override: string | null; team_b_override: string | null;
}

/**
 * Summaries for these replays, indexing at most `budget` missing or outdated ones per call
 * (the rest are reported as pending so the page can ask again).
 */
export async function indexedReplays(rows: ReplayRow[], budget = 40): Promise<{ replays: IndexedReplay[]; pending: number }> {
  if (!rows.length) return { replays: [], pending: 0 };
  const have = new Map((await q<{ replay_id: string; revision: number; teams: ReplaySummary["teams"]; players: PlayerSummary[]; has_players: boolean }>(
    "select replay_id, revision, teams, players, has_players from replay_stat_index where replay_id = any($1::text[])", [rows.map((r) => r.id)],
  )).map((x) => [x.replay_id, x]));
  const out: IndexedReplay[] = [];
  let pending = 0;
  for (const r of rows) {
    let s: ReplaySummary | null = null;
    const h = have.get(r.id);
    if (h && h.revision === r.published_revision) {
      s = { teams: h.teams, players: h.players, hasPlayers: h.has_players };
    } else if (budget > 0) {
      budget -= 1;
      try {
        s = summarizeManifest(await loadManifest(r.published_prefix));
        await q(
          `insert into replay_stat_index(replay_id, revision, map_id, has_players, teams, players)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (replay_id) do update set revision = excluded.revision, map_id = excluded.map_id,
             has_players = excluded.has_players, teams = excluded.teams, players = excluded.players, indexed_at = now()`,
          [r.id, r.published_revision, r.map_id, s.hasPlayers, JSON.stringify(s.teams), JSON.stringify(s.players)],
        );
      } catch (e) {
        console.error("[stats] could not index", r.id, e instanceof Error ? e.message : e);
        continue;
      }
    } else {
      pending += 1;
      continue;
    }
    // Names edited on the replay win over parsed names.
    const teams = {
      A: { ...s.teams.A, ...(r.team_a_override ? { name: r.team_a_override, nameSource: "edited" } : {}) },
      B: { ...s.teams.B, ...(r.team_b_override ? { name: r.team_b_override, nameSource: "edited" } : {}) },
    };
    // node-postgres returns timestamps as Date objects; the pages compare ISO strings.
    const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());
    out.push({ id: r.id, title: r.title, mapId: r.map_id, createdAt: iso(r.created_at)!, playedAt: iso(r.played_at), seriesId: r.series_id, summary: { ...s, teams } });
  }
  return { replays: out, pending };
}

export const teamKey = (name: string) => name.trim().toLowerCase();
const named = (t: TeamSummary) => t.nameSource !== "fallback";

export interface TeamListItem { key: string; name: string; demos: number; wins: number; losses: number; draws: number; maps: string[]; lastPlayed: string }

export function listTeams(replays: IndexedReplay[]): TeamListItem[] {
  const m = new Map<string, TeamListItem>();
  for (const r of replays) {
    for (const t of Object.values(r.summary.teams)) {
      if (!named(t)) continue;
      const k = teamKey(t.name);
      const e = m.get(k) ?? { key: k, name: t.name, demos: 0, wins: 0, losses: 0, draws: 0, maps: [], lastPlayed: r.playedAt ?? r.createdAt };
      e.demos += 1;
      if (t.score > t.oppScore) e.wins += 1; else if (t.score < t.oppScore) e.losses += 1; else e.draws += 1;
      if (r.mapId && !e.maps.includes(r.mapId)) e.maps.push(r.mapId);
      const when = r.playedAt ?? r.createdAt;
      if (when > e.lastPlayed) { e.lastPlayed = when; e.name = t.name; }
      m.set(k, e);
    }
  }
  return [...m.values()].sort((a, b) => b.demos - a.demos || a.name.localeCompare(b.name));
}

export interface MapRecord {
  mapId: string; played: number; wins: number; losses: number;
  rounds: WL; ct: WL; t: WL; pistol: WL; opening: WL; clutch: WL;
}
export interface MatchRow {
  replayId: string; mapId: string | null; title: string | null; when: string; opponent: string; score: number; oppScore: number;
  result: "W" | "L" | "D"; side: Side; rating: number | null;
}
export interface PlayerRow {
  key: string; name: string; maps: number; rounds: number; k: number; d: number; a: number;
  adr: number | null; kast: number; hs: number; rating: number; openingPct: number | null; clutches: string; multi: number;
}
export interface TeamDetail {
  name: string; demos: number; wins: number; losses: number; draws: number;
  overall: MapRecord; maps: MapRecord[]; matches: MatchRow[]; players: PlayerRow[]; opponents: { name: string; wins: number; losses: number; demos: number }[];
}

const addWL = (a: WL, b: WL) => { a.w += b.w; a.p += b.p; };
const emptyRecord = (mapId: string): MapRecord => ({ mapId, played: 0, wins: 0, losses: 0, rounds: wl(), ct: wl(), t: wl(), pistol: wl(), opening: wl(), clutch: wl() });

export function teamDetail(replays: IndexedReplay[], key: string, mapFilter: string | null): TeamDetail | null {
  const overall = emptyRecord("all");
  const byMap = new Map<string, MapRecord>();
  const matches: MatchRow[] = [];
  const players = new Map<string, PlayerSummary & { maps: number }>();
  const opponents = new Map<string, { name: string; wins: number; losses: number; demos: number }>();
  let name = "";
  let wins = 0, losses = 0, draws = 0;
  for (const r of replays) {
    const side = (["A", "B"] as TeamKey[]).find((k) => named(r.summary.teams[k]) && teamKey(r.summary.teams[k].name) === key);
    if (!side || (mapFilter && r.mapId !== mapFilter)) continue;
    const t = r.summary.teams[side];
    const opp = r.summary.teams[side === "A" ? "B" : "A"];
    name ||= t.name;
    const result = t.score > t.oppScore ? "W" : t.score < t.oppScore ? "L" : "D";
    if (result === "W") wins += 1; else if (result === "L") losses += 1; else draws += 1;
    for (const rec of [overall, byMap.get(r.mapId ?? "unknown") ?? (byMap.set(r.mapId ?? "unknown", emptyRecord(r.mapId ?? "unknown")), byMap.get(r.mapId ?? "unknown")!)]) {
      rec.played += 1;
      if (result === "W") rec.wins += 1;
      if (result === "L") rec.losses += 1;
      addWL(rec.rounds, t.rounds); addWL(rec.ct, t.ct); addWL(rec.t, t.t); addWL(rec.pistol, t.pistol);
      addWL(rec.opening, t.opening); addWL(rec.clutch, t.clutch);
    }
    let teamRating = 0, n = 0;
    for (const p of r.summary.players) {
      if (p.team !== side || p.isBot) continue;
      const pk = p.steamId ?? p.id;
      const acc = players.get(pk) ?? { ...structuredClone(p), rounds: 0, k: 0, d: 0, a: 0, fa: 0, hs: 0, tk: 0, dmg: 0, ud: 0, ef: 0, fd: 0, ok: 0, od: 0, trk: 0, trd: 0, kast: 0, surv: 0, clutches: 0, clutchesWon: 0, clutchByVs: {}, multi: { 2: 0, 3: 0, 4: 0, 5: 0 }, oneK: 0, maps: 0 };
      for (const f of ["rounds", "k", "d", "a", "fa", "hs", "tk", "dmg", "ud", "ef", "fd", "ok", "od", "trk", "trd", "kast", "surv", "clutches", "clutchesWon", "oneK"] as const) acc[f] += p[f];
      for (const m of [2, 3, 4, 5] as const) acc.multi[m] += p.multi[m];
      acc.maps += 1;
      acc.name = p.name;
      players.set(pk, acc);
      teamRating += rating10(p); n += 1;
    }
    matches.push({
      replayId: r.id, mapId: r.mapId, title: r.title, when: r.playedAt ?? r.createdAt, opponent: opp.name, score: t.score, oppScore: t.oppScore,
      result, side: t.startSide, rating: n && r.summary.hasPlayers ? teamRating / n : null,
    });
    const ok = teamKey(opp.name);
    const o = opponents.get(ok) ?? { name: opp.name, wins: 0, losses: 0, demos: 0 };
    o.demos += 1;
    if (result === "W") o.wins += 1;
    if (result === "L") o.losses += 1;
    opponents.set(ok, o);
  }
  if (!name) return null;
  const hasDamage = replays.some((r) => r.summary.players.some((p) => p.dmg > 0));
  return {
    name, demos: wins + losses + draws, wins, losses, draws, overall,
    maps: [...byMap.values()].sort((a, b) => b.played - a.played),
    matches: matches.sort((a, b) => b.when.localeCompare(a.when)),
    players: [...players.entries()].map(([k, p]) => {
      const d = derive(p, hasDamage);
      return {
        key: k, name: p.name, maps: p.maps, rounds: p.rounds, k: p.k, d: p.d, a: p.a, adr: d.adr, kast: d.kastPct, hs: d.hsPct,
        rating: d.rating, openingPct: d.openingPct, clutches: `${p.clutchesWon}/${p.clutches}`, multi: p.multi[3] + p.multi[4] + p.multi[5],
      };
    }).filter((p) => p.rounds > 0).sort((a, b) => b.rating - a.rating),
    opponents: [...opponents.values()].sort((a, b) => b.demos - a.demos),
  };
}
