import { describe, expect, it } from "vitest";
import type { Insights } from "@/lib/insights";
import { findPatterns, siteCentres, type TeamDemo } from "@/lib/patterns";

const A_SITE = { x: -300, y: -2000, z: 0 };
const B_SITE = { x: -2000, y: 300, z: 0 };

/**
 * A synthetic demo: team A (our scouting target) on T in rounds 0..n-1. Player a0 always stands at
 * the same spot at 0:20, the team plants A in most rounds, a1 takes the first fight and a2 throws the
 * same smoke early.
 */
function demo(id: string, n: number, plantB: number[] = []): TeamDemo {
  const players: Insights["players"] = [
    ...[0, 1, 2, 3, 4].map((i) => ({ id: `a${i}`, name: `alpha${i}`, team: "A" as const, steamId: `7656${i}` })),
    ...[0, 1, 2, 3, 4].map((i) => ({ id: `b${i}`, name: `bravo${i}`, team: "B" as const, steamId: `8656${i}` })),
  ];
  const pos = { r: [] as number[], p: [] as number[], s: [] as number[], x: [] as number[], y: [] as number[], z: [] as number[] };
  const push = (r: number, p: number, s: number, x: number, y: number) => { pos.r.push(r); pos.p.push(p); pos.s.push(s); pos.x.push(x); pos.y.push(y); pos.z.push(0); };
  const rounds: Insights["rounds"] = [];
  const kills: Insights["kills"] = [];
  const nades: Insights["nades"] = [];
  for (let r = 0; r < n; r++) {
    const site = plantB.includes(r) ? B_SITE : A_SITE;
    rounds.push({
      id: `r${r}`, n: r + 1, sides: { A: "T", B: "CT" }, winner: r % 3 ? "A" : "B", freeze: 100, startTick: 0, pistol: r === 0,
      buy: { A: r === 0 ? "pistol" : "full_buy", B: r === 0 ? "pistol" : "full_buy" },
      plant: { s: 30, site: plantB.includes(r) ? "B" : "A", ...site }, defused: false, exploded: true, length: 80, endReason: null,
    });
    for (let p = 0; p < 10; p++) {
      for (const s of [0, 2, 20]) {
        if (p === 0) push(r, p, s, 500, 500); // a0: same spot every round
        else push(r, p, s, (p * 997 * (r + 1)) % 4000 - 2000, (p * 613 * (r + 3)) % 4000 - 2000);
      }
    }
    kills.push({ r, s: 12, k: 1, v: 6, kx: 100, ky: -1500, kz: 0, vx: 150, vy: -1600, vz: 0, w: "ak47", hs: true });
    nades.push({ r, s: 8, p: 2, type: "smoke", ox: 0, oy: 0, oz: 0, lx: -350, ly: -1700, lz: 0, tick: 600 });
  }
  return { replayId: id, side: "A", when: "2026-01-01", opponent: "Bravo", ins: { v: 3, mapId: "de_mirage", tickMs: 1000 / 64, players, pos, kills, nades, rounds } };
}

describe("pattern finder", () => {
  it("finds site centres from plants", () => {
    const c = siteCentres([demo("d1", 4, [1])]);
    expect(c.A.x).toBeCloseTo(A_SITE.x);
    expect(c.B.y).toBeCloseTo(B_SITE.y);
  });

  it("reports repeatable habits with counts and examples", () => {
    const rep = findPatterns([demo("d1", 6, [2]), demo("d2", 6)]);
    expect(rep.demos).toBe(2);
    expect(rep.rounds.T).toBe(12);
    expect(rep.sites).toEqual(["A", "B"]);

    const site = rep.patterns.find((p) => p.id === "site-all")!;
    expect(site.n).toBe(11);
    expect(site.of).toBe(12);
    expect(site.confidence).toBe("strong");
    expect(site.title).toContain("plant A");

    const spot = rep.patterns.find((p) => p.id === "pos-T-76560")!;
    expect(spot.player).toBe("alpha0");
    expect(spot.n).toBe(12);
    expect(spot.spot).toMatchObject({ x: 500, y: 500 });

    const opener = rep.patterns.find((p) => p.id === "open-T-76561")!;
    expect(opener.share).toBe(1);
    expect(opener.counter).toMatch(/wins early fights/);

    const smoke = rep.patterns.find((p) => p.category === "utility")!;
    expect(smoke.detail).toContain("alpha2");
    expect(smoke.spot?.label).toBe("A site");

    const fast = rep.patterns.find((p) => p.id === "pace-fast")!;
    expect(fast.n).toBe(12);

    // Examples link to rounds, with the time inside the round.
    expect(site.examples[0]).toMatchObject({ replayId: "d1", roundId: "r0", roundNumber: 1 });
    expect(site.examples[0].ms).toBeGreaterThan(0);
  });

  it("strong patterns sort first and small samples stay weak", () => {
    const rep = findPatterns([demo("d1", 3)]);
    const order = rep.patterns.map((p) => p.confidence);
    expect(order.indexOf("weak") === -1 || order.lastIndexOf("strong") < order.indexOf("weak")).toBe(true);
    expect(rep.patterns.every((p) => p.of < 8 ? p.confidence !== "strong" : true)).toBe(true);
  });

  it("gives an empty report for no demos", () => {
    const rep = findPatterns([]);
    expect(rep.patterns).toEqual([]);
    expect(rep.rounds).toEqual({ T: 0, CT: 0 });
  });
});
