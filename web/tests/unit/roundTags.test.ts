import { describe, expect, it } from "vitest";
import type { Insights } from "@/lib/insights";
import { roundView } from "@/lib/roundTags";

function ins(over: Partial<Insights["rounds"][number]>, kills: Insights["kills"] = []): Insights {
  const players: Insights["players"] = [
    ...[0, 1, 2, 3, 4].map((i) => ({ id: `a${i}`, name: `a${i}`, team: "A" as const, steamId: null })),
    ...[0, 1, 2, 3, 4].map((i) => ({ id: `b${i}`, name: `b${i}`, team: "B" as const, steamId: null })),
  ];
  const pos = { r: [] as number[], p: [] as number[], s: [] as number[], x: [] as number[], y: [] as number[], z: [] as number[] };
  players.forEach((_, i) => { pos.r.push(0); pos.p.push(i); pos.s.push(0); pos.x.push(0); pos.y.push(0); pos.z.push(0); });
  return {
    v: 3, mapId: "de_mirage", tickMs: 1000 / 64, players, pos, kills, nades: [],
    rounds: [{
      id: "r05", n: 5, sides: { A: "T", B: "CT" }, winner: "A", freeze: 0, startTick: 0, pistol: false,
      buy: { A: "full_buy", B: "eco" }, plant: null, defused: false, exploded: false, length: 90, endReason: null, ...over,
    }],
  };
}
const kill = (s: number, k: number, v: number) => ({ r: 0, s, k, v, kx: 0, ky: 0, kz: 0, vx: 0, vy: 0, vz: 0, w: "ak47", hs: false });

describe("round tags", () => {
  it("tags economy, T-side pace and post-plant wins", () => {
    const v = roundView(ins({ plant: { s: 28, site: "A", x: 0, y: 0, z: 0 } }), 0, "A");
    expect(v.tags).toEqual(expect.arrayContaining(["full_buy", "anti_eco", "fast_plant", "post_plant_won"]));
    expect(v.plantSite).toBe("A");
    expect(roundView(ins({ plant: { s: 50, site: "B", x: 0, y: 0, z: 0 } }), 0, "A").tags).toContain("execute");
    expect(roundView(ins({ plant: { s: 80, site: "B", x: 0, y: 0, z: 0 } }), 0, "A").tags).toContain("late_plant");
    expect(roundView(ins({}), 0, "A").tags).toContain("no_plant");
  });

  it("from the CT view: retake, save and opening duels", () => {
    const r = ins({ winner: "B", plant: { s: 60, site: "B", x: 0, y: 0, z: 0 }, defused: true }, [kill(10, 5, 0), kill(40, 1, 6)]);
    const ct = roundView(r, 0, "B");
    expect(ct.side).toBe("CT");
    expect(ct.tags).toEqual(expect.arrayContaining(["retake_won", "opening_kill", "eco"]));
    const t = roundView(r, 0, "A");
    expect(t.won).toBe(false);
    expect(t.tags).toEqual(expect.arrayContaining(["save", "opening_death", "execute"]));
  });

  it("pistol rounds are tagged pistol, not by buy", () => {
    expect(roundView(ins({ pistol: true, buy: { A: "pistol", B: "pistol" } }), 0, "A").tags).toEqual(expect.arrayContaining(["pistol"]));
    expect(roundView(ins({ pistol: true }), 0, "A").tags).not.toContain("full_buy");
  });
});
