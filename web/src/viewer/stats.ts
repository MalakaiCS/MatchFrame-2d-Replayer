/**
 * Match statistics from per-round player stats (manifest.rounds[].playerStats).
 * Pure functions: the stats page and the tests use the same code.
 */
import type { Manifest, PlayerRoundStats, RoundSummary, Side, TeamKey } from "@/shared/contract";

export interface StatsFilter {
  side: "all" | Side;
  /** "all", "1", "2" (regulation halves) or "ot". */
  half: "all" | "1" | "2" | "ot";
}

export interface PlayerTotals {
  id: string;
  name: string;
  team: TeamKey;
  rounds: number;
  k: number; d: number; a: number; fa: number; hs: number; tk: number;
  dmg: number; ud: number; ef: number; fd: number;
  ok: number; od: number; trk: number; trd: number; kast: number; surv: number;
  clutches: number; clutchesWon: number; clutchByVs: Record<number, { played: number; won: number }>;
  multi: { 2: number; 3: number; 4: number; 5: number };
  /** Rounds with exactly one kill (used by the rating formula). */
  oneK: number;
}

export interface DerivedStats {
  kd: number; diff: number; adr: number | null; kastPct: number; hsPct: number;
  kpr: number; dpr: number; openingPct: number | null; rating: number;
}

export function roundMatches(r: RoundSummary, f: StatsFilter): boolean {
  if (f.half === "ot" && !r.isOvertime) return false;
  if ((f.half === "1" || f.half === "2") && (r.isOvertime || String(r.half) !== f.half)) return false;
  return true;
}

export function hasPlayerStats(m: Manifest): boolean {
  return m.rounds.some((r) => r.playerStats && Object.keys(r.playerStats).length > 0);
}

function empty(id: string, name: string, team: TeamKey): PlayerTotals {
  return {
    id, name, team, rounds: 0, k: 0, d: 0, a: 0, fa: 0, hs: 0, tk: 0, dmg: 0, ud: 0, ef: 0, fd: 0,
    ok: 0, od: 0, trk: 0, trd: 0, kast: 0, surv: 0, clutches: 0, clutchesWon: 0, clutchByVs: {},
    multi: { 2: 0, 3: 0, 4: 0, 5: 0 }, oneK: 0,
  };
}

export function addRound(t: PlayerTotals, s: PlayerRoundStats) {
  t.rounds += 1;
  t.k += s.k; t.d += s.d; t.a += s.a; t.fa += s.fa; t.hs += s.hs; t.tk += s.tk;
  t.dmg += s.dmg; t.ud += s.ud; t.ef += s.ef; t.fd += s.fd;
  t.ok += s.ok; t.od += s.od; t.trk += s.trk; t.trd += s.trd; t.kast += s.kast; t.surv += s.surv;
  if (s.cl > 0) {
    t.clutches += 1;
    t.clutchesWon += s.cw;
    const b = (t.clutchByVs[s.cl] ??= { played: 0, won: 0 });
    b.played += 1;
    b.won += s.cw;
  }
  if (s.k === 1) t.oneK += 1;
  if (s.k >= 2) t.multi[Math.min(5, s.k) as 2 | 3 | 4 | 5] += 1;
}

/** Totals per player over the rounds that match the filter (side = the side the player was on). */
export function playerTotals(m: Manifest, f: StatsFilter): PlayerTotals[] {
  const out = new Map<string, PlayerTotals>();
  for (const p of m.players) out.set(p.id, empty(p.id, p.name, p.team));
  for (const r of m.rounds) {
    if (!roundMatches(r, f) || !r.playerStats) continue;
    for (const [pid, s] of Object.entries(r.playerStats)) {
      if (f.side !== "all" && s.side !== f.side) continue;
      const t = out.get(pid);
      if (t) addRound(t, s);
    }
  }
  return [...out.values()].filter((t) => t.rounds > 0);
}

/**
 * Rating uses the public HLTV 1.0 formula (kills, survival and multi-kill rounds against fixed
 * averages). It is labelled "Rating 1.0" in the UI; it is not HLTV's current 2.x rating.
 */
export function rating10(t: PlayerTotals): number {
  if (!t.rounds) return 0;
  const killRating = t.k / t.rounds / 0.679;
  const survivalRating = (t.rounds - t.d) / t.rounds / 0.317;
  const multi = (t.oneK + 4 * t.multi[2] + 9 * t.multi[3] + 16 * t.multi[4] + 25 * t.multi[5]) / t.rounds / 1.277;
  return (killRating + 0.7 * survivalRating + multi) / 2.7;
}

export function derive(t: PlayerTotals, hasDamage: boolean): DerivedStats {
  const n = Math.max(1, t.rounds);
  return {
    kd: t.d ? t.k / t.d : t.k,
    diff: t.k - t.d,
    adr: hasDamage ? t.dmg / n : null,
    kastPct: (100 * t.kast) / n,
    hsPct: t.k ? (100 * t.hs) / t.k : 0,
    kpr: t.k / n,
    dpr: t.d / n,
    openingPct: t.ok + t.od ? (100 * t.ok) / (t.ok + t.od) : null,
    rating: rating10(t),
  };
}

export interface TeamTotals {
  team: TeamKey;
  roundsWon: number;
  roundsPlayed: number;
  openingWins: number;
  openingAttempts: number;
  clutches: number;
  clutchesWon: number;
  pistolWon: number;
  pistolPlayed: number;
  /** Win rate by side within the filter. */
  bySide: Record<Side, { won: number; played: number }>;
}

export function teamTotals(m: Manifest, f: StatsFilter): Record<TeamKey, TeamTotals> {
  const mk = (team: TeamKey): TeamTotals => ({
    team, roundsWon: 0, roundsPlayed: 0, openingWins: 0, openingAttempts: 0, clutches: 0, clutchesWon: 0,
    pistolWon: 0, pistolPlayed: 0, bySide: { CT: { won: 0, played: 0 }, T: { won: 0, played: 0 } },
  });
  const out: Record<TeamKey, TeamTotals> = { A: mk("A"), B: mk("B") };
  const teamOf = new Map(m.players.map((p) => [p.id, p.team]));
  for (const r of m.rounds) {
    if (!roundMatches(r, f)) continue;
    for (const key of ["A", "B"] as TeamKey[]) {
      const side = r.sides[key];
      if (f.side !== "all" && side !== f.side) continue;
      const t = out[key];
      t.roundsPlayed += 1;
      t.bySide[side].played += 1;
      if (r.winner === key) {
        t.roundsWon += 1;
        t.bySide[side].won += 1;
      }
      if (r.isPistol) {
        t.pistolPlayed += 1;
        if (r.winner === key) t.pistolWon += 1;
      }
      for (const [pid, s] of Object.entries(r.playerStats ?? {})) {
        if (teamOf.get(pid) !== key) continue;
        if (s.ok) { t.openingWins += 1; t.openingAttempts += 1; }
        if (s.od) t.openingAttempts += 1;
        if (s.cl) { t.clutches += 1; t.clutchesWon += s.cw; }
      }
    }
  }
  return out;
}

/** Notable moments for the round list: multi-kills and won clutches. */
export function roundHighlights(m: Manifest, r: RoundSummary): string[] {
  const names = new Map(m.players.map((p) => [p.id, p.name]));
  const out: string[] = [];
  for (const [pid, s] of Object.entries(r.playerStats ?? {})) {
    const n = names.get(pid) ?? "?";
    if (s.k >= 3) out.push(s.k >= 5 ? `${n} ace` : `${n} ${s.k}K`);
    if (s.cl && s.cw) out.push(`${n} won 1v${s.cl}`);
  }
  return out;
}
