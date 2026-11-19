/**
 * Round win probability (CT side's view) from the round state: players alive, health, equipment,
 * bomb and time. A small logistic regression fitted on real demos by worker/tools/fit_winprob.py;
 * the weights and held-out scores are in src/shared/winprob.json. It is an estimate, not a fact.
 */
import type { Manifest, RoundSummary } from "@/shared/contract";
import model from "@/shared/winprob.json";
import { frameAt, type RoundIndex } from "./playback";

const W = model.weights as number[];

export interface WinState {
  ctAlive: number; tAlive: number; ctHp: number; tHp: number; ctEq: number; tEq: number;
  planted: boolean; bombLeft: number; roundLeft: number;
}

/** Same features, same order, as the fitting tool. */
export function ctWinProbability(s: WinState): number {
  if (s.ctAlive === 0) return 0;
  if (s.tAlive === 0 && !s.planted) return 1;
  const d = s.ctAlive - s.tAlive;
  const x = [1, d, s.ctAlive, s.tAlive, (s.ctHp - s.tHp) / 100, (s.ctEq - s.tEq) / 10000,
    s.planted ? 1 : 0, s.planted ? s.bombLeft : 0, s.planted ? 0 : s.roundLeft, s.planted ? d : 0];
  const z = x.reduce((a, v, i) => a + v * W[i], 0);
  return 1 / (1 + Math.exp(-z));
}

export function stateAt(idx: RoundIndex, round: RoundSummary, m: Manifest, tick: number): WinState {
  const f = frameAt(idx, tick);
  const teamOf = new Map(m.players.map((p) => [p.id, p.team]));
  let ctAlive = 0, tAlive = 0, ctHp = 0, tHp = 0;
  for (const p of f.players) {
    const team = teamOf.get(p.id);
    if (!team || !p.alive || !p.visible) continue;
    if (round.sides[team] === "CT") { ctAlive += 1; ctHp += p.hp ?? 100; } else { tAlive += 1; tHp += p.hp ?? 100; }
  }
  const sideTeam = round.sides.A === "CT" ? { CT: "A" as const, T: "B" as const } : { CT: "B" as const, T: "A" as const };
  const plantTick = f.bomb.plantedTick;
  const planted = plantTick !== null && (f.bomb.state === "planted" || f.bomb.state === "defusing");
  const rate = m.tickRate;
  const start = round.freezeEndTick ?? round.startTick;
  const bombS = m.timing.bombTimerS ?? 40;
  const roundS = m.timing.roundTimeS ?? 115;
  return {
    ctAlive, tAlive, ctHp, tHp,
    ctEq: round.economy[sideTeam.CT]?.equipmentValue ?? 0, tEq: round.economy[sideTeam.T]?.equipmentValue ?? 0,
    planted,
    bombLeft: planted ? Math.max(0, bombS - (tick - plantTick!) / rate) / bombS : 0,
    roundLeft: Math.max(0, roundS - (tick - start) / rate) / roundS,
  };
}

/** CT win probability once per second from freeze end until the round is decided. */
export function winTimeline(idx: RoundIndex, round: RoundSummary, m: Manifest): { tick: number; p: number }[] {
  const out: { tick: number; p: number }[] = [];
  const start = round.freezeEndTick ?? round.startTick;
  const end = (round.decidedTick ?? round.endTick) - 1;
  for (let t = start; t <= end; t += Math.round(m.tickRate)) out.push({ tick: t, p: ctWinProbability(stateAt(idx, round, m, t)) });
  out.push({ tick: end, p: ctWinProbability(stateAt(idx, round, m, end)) });
  return out;
}

/** How much a kill changed the killer's side's win probability (percentage points). */
export function killSwing(idx: RoundIndex, round: RoundSummary, m: Manifest, tick: number, killerSide: "CT" | "T"): number {
  const before = ctWinProbability(stateAt(idx, round, m, tick - 1));
  const after = ctWinProbability(stateAt(idx, round, m, tick));
  const d = (after - before) * 100;
  return killerSide === "CT" ? d : -d;
}
