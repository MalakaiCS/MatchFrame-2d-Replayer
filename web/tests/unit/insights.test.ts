import { describe, expect, it } from "vitest";
import type { Manifest, RoundPayload } from "@/shared/contract";
import { buildInsights, type InsightFilter, type NadePoint, type Point, selectPoints } from "@/lib/insights";

const bag = () => ({ points: [] as Point[], nades: [] as NadePoint[] });

const m = {
  map: { id: "de_mirage" }, tickIntervalMs: 1000 / 64,
  players: [{ id: "a1", name: "Ace", team: "A", steamId: "1", isBot: false }, { id: "b1", name: "Bee", team: "B", steamId: "2", isBot: false }],
  rounds: [{ id: "r01", displayNumber: 1, sides: { A: "CT", B: "T" }, winner: "A", startTick: 0, freezeEndTick: 640, decidedTick: 640 + 64 * 30, endTick: 640 + 64 * 40 }],
} as unknown as Manifest;

const payload = {
  tracks: [
    // Samples every second for 40 s; dead from 25 s.
    { playerId: "a1", t: Array.from({ length: 50 }, (_, i) => 640 + i * 64), x: Array.from({ length: 50 }, (_, i) => i * 10), y: Array(50).fill(5), z: Array(50).fill(0), alive: Array.from({ length: 50 }, (_, i) => (i < 25 ? 1 : 0)) },
  ],
  events: [{ type: "kill", tick: 640 + 64 * 25, actor: "b1", target: "a1", position: { x: 250, y: 5, z: 0 }, actorPosition: { x: 900, y: 5, z: 0 }, weapon: "ak47", headshot: true }],
  grenades: [{ id: "g1", type: "smoke", throwerId: "a1", throwTick: 640 + 64 * 3, detonateTick: 640 + 64 * 5, path: [[640 + 64 * 3, 10, 20, 0], [640 + 64 * 4, 500, 600, 0]], detonation: { x: 520, y: 610, z: 0 } }],
} as unknown as RoundPayload;

const all: InsightFilter = { layer: "pos", side: "all", from: 0, to: 10_000, player: null, nadeType: null };

describe("insights", () => {
  const ins = buildInsights(m, new Map([["r01", payload]]));

  it("samples alive positions every 2 s from freeze end until the round is decided", () => {
    expect(ins.pos.s).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]);
    expect(ins.pos.x[1]).toBe(20);
  });

  it("filters by team, side, time and layer", () => {
    const out = bag();
    selectPoints(ins, "rep", "A", { ...all, from: 0, to: 4 }, out);
    expect(out.points).toHaveLength(3);
    const t = bag();
    selectPoints(ins, "rep", "A", { ...all, side: "T" }, t);
    expect(t.points).toHaveLength(0);
    const deaths = bag();
    selectPoints(ins, "rep", "A", { ...all, layer: "deaths" }, deaths);
    expect(deaths.points).toEqual([{ x: 250, y: 5, z: 0 }]);
    const kills = bag();
    selectPoints(ins, "rep", "B", { ...all, layer: "kills" }, kills);
    expect(kills.points).toEqual([{ x: 900, y: 5, z: 0 }]);
  });

  it("keeps grenade throw and landing spots with a link moment", () => {
    const out = bag();
    selectPoints(ins, "rep", "A", { ...all, layer: "nades", nadeType: "smoke" }, out);
    expect(out.nades).toHaveLength(1);
    expect(out.nades[0]).toMatchObject({ lx: 520, roundId: "r01", won: true, ms: 13_000 });
  });
});
