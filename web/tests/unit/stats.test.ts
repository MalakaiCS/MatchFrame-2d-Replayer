import { describe, expect, it } from "vitest";
import type { Manifest, PlayerRoundStats, RoundSummary } from "@/shared/contract";
import { derive, playerTotals, rating10, roundHighlights, teamTotals } from "@/viewer/stats";

const ps = (side: "CT" | "T", o: Partial<PlayerRoundStats> = {}): PlayerRoundStats => ({
  side, k: 0, d: 0, a: 0, fa: 0, hs: 0, tk: 0, dmg: 0, ud: 0, ef: 0, fd: 0, ok: 0, od: 0, trk: 0, trd: 0, surv: 1, kast: 1, cl: 0, cw: 0, eq: null, ...o,
});

function round(n: number, aSide: "CT" | "T", winner: "A" | "B", stats: Record<string, PlayerRoundStats>, extra: Partial<RoundSummary> = {}): RoundSummary {
  return {
    id: `r${String(n).padStart(2, "0")}`, displayNumber: n, startTick: 0, freezeEndTick: 0, decidedTick: 0, endTick: 1,
    sides: { A: aSide, B: aSide === "CT" ? "T" : "CT" }, scoreBefore: { A: 0, B: 0 }, scoreAfter: { A: 0, B: 0 },
    winner, winnerSide: winner === "A" ? aSide : aSide === "CT" ? "T" : "CT", endReason: null, durationMs: 0,
    half: n <= 12 ? 1 : 2, isOvertime: false, isPistol: n === 1 || n === 13, isOvertimeHalfStart: false,
    economy: { A: { equipmentValue: 4000, buyType: "full_buy", players: 5 }, B: { equipmentValue: 1000, buyType: "eco", players: 5 } } as RoundSummary["economy"],
    coverage: {}, bombPlanted: false, playerStats: stats, payload: { key: "", bytes: 0, sha256: "" }, ...extra,
  };
}

const manifest = {
  players: [
    { id: "a1", name: "Alpha", team: "A", isBot: false, steamId: "1" },
    { id: "b1", name: "Bravo", team: "B", isBot: false, steamId: "2" },
  ],
  teams: { A: { key: "A", name: "A", nameSource: "clan", startSide: "CT" }, B: { key: "B", name: "B", nameSource: "clan", startSide: "T" } },
  capabilities: { damage: true },
  rounds: [
    round(1, "CT", "A", { a1: ps("CT", { k: 3, hs: 2, dmg: 300, ok: 1, cl: 1, cw: 1 }), b1: ps("T", { d: 1, surv: 0, od: 1, kast: 0 }) }),
    round(13, "T", "B", { a1: ps("T", { d: 1, surv: 0, kast: 0, dmg: 50 }), b1: ps("CT", { k: 1, dmg: 100 }) }),
  ],
} as unknown as Manifest;

describe("match stats", () => {
  it("adds up rounds and derives ADR, KAST, HS% and opening duels", () => {
    const [a] = playerTotals(manifest, { side: "all", half: "all" }).filter((p) => p.id === "a1");
    expect(a).toMatchObject({ rounds: 2, k: 3, d: 1, hs: 2, dmg: 350, ok: 1, clutches: 1, clutchesWon: 1 });
    expect(a.multi[3]).toBe(1);
    const d = derive(a, true);
    expect(d.adr).toBe(175);
    expect(d.kastPct).toBe(50);
    expect(d.hsPct).toBeCloseTo(66.67, 1);
    expect(d.openingPct).toBe(100);
    expect(derive(a, false).adr).toBeNull();
  });

  it("filters by the side the player was on and by half", () => {
    const ct = playerTotals(manifest, { side: "CT", half: "all" }).find((p) => p.id === "a1")!;
    expect(ct.rounds).toBe(1);
    expect(ct.k).toBe(3);
    const second = playerTotals(manifest, { side: "all", half: "2" }).find((p) => p.id === "a1")!;
    expect(second.d).toBe(1);
    expect(second.k).toBe(0);
  });

  it("uses the HLTV 1.0 rating formula", () => {
    const t = playerTotals(manifest, { side: "all", half: "all" }).find((p) => p.id === "a1")!;
    // kills 3/2/0.679, survival (2-1)/2/0.317, multi (9*1)/2/1.277
    const expected = (3 / 2 / 0.679 + 0.7 * (1 / 2 / 0.317) + 9 / 2 / 1.277) / 2.7;
    expect(rating10(t)).toBeCloseTo(expected, 6);
  });

  it("team totals count wins by side, pistols, openings and clutches", () => {
    const t = teamTotals(manifest, { side: "all", half: "all" });
    expect(t.A).toMatchObject({ roundsWon: 1, roundsPlayed: 2, pistolWon: 1, pistolPlayed: 2, openingWins: 1, openingAttempts: 1, clutches: 1, clutchesWon: 1 });
    expect(t.A.bySide.CT).toEqual({ won: 1, played: 1 });
    expect(t.B.openingAttempts).toBe(1);
    expect(roundHighlights(manifest, manifest.rounds[0])).toEqual(["Alpha 3K", "Alpha won 1v1"]);
  });
});
