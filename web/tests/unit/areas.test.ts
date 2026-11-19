import { describe, expect, it } from "vitest";
import { areaReport, Callouts, findDefaults, prettyPlace, yourAreas } from "@/lib/areas";
import type { Insights } from "@/lib/insights";
import type { TeamDemo } from "@/lib/patterns";

const PLACES = ["BombsiteA", "BombsiteB", "Apartments", "Middle", "TSpawn", "CTSpawn", "Underpass"];
const XY: Record<string, [number, number]> = {
  BombsiteA: [-300, -2000], BombsiteB: [-2000, 300], Apartments: [-1200, 700], Middle: [-500, -500],
  TSpawn: [1200, 0], CTSpawn: [-1500, -1800], Underpass: [-1000, -100],
};

/**
 * Team A is on T. a0 and a1 walk TSpawn -> Apartments -> B site and plant B; a2 holds Middle; a3, a4
 * go A. Team B (the other side) has b0 anchoring B, b1 in Middle, the rest at A. a2 smokes B site at 0:20.
 */
function demo(id: string, rounds: number, side: "A" | "B" = "A"): TeamDemo {
  const players: Insights["players"] = [
    ...[0, 1, 2, 3, 4].map((i) => ({ id: `a${i}`, name: `alpha${i}`, team: "A" as const, steamId: `1${i}` })),
    ...[0, 1, 2, 3, 4].map((i) => ({ id: `b${i}`, name: `bravo${i}`, team: "B" as const, steamId: `2${i}` })),
  ];
  const pos = { r: [] as number[], p: [] as number[], s: [] as number[], x: [] as number[], y: [] as number[], z: [] as number[], c: [] as number[] };
  const put = (r: number, p: number, s: number, place: string) => {
    const [x, y] = XY[place];
    pos.r.push(r); pos.p.push(p); pos.s.push(s); pos.x.push(x + p * 10); pos.y.push(y + p * 10); pos.z.push(0); pos.c.push(PLACES.indexOf(place));
  };
  const out: Insights["rounds"] = [];
  const kills: Insights["kills"] = [];
  const nades: Insights["nades"] = [];
  for (let r = 0; r < rounds; r++) {
    out.push({
      id: `r${r}`, n: r + 2, sides: { A: "T", B: "CT" }, winner: "A", freeze: 0, startTick: 0, pistol: false,
      buy: { A: "full_buy", B: "full_buy" }, plant: { s: 60, site: "B", x: -2000, y: 300, z: 0 }, defused: false, exploded: true, length: 80, endReason: null,
    });
    for (let s = 0; s <= 80; s += 2) {
      const route = s < 10 ? "TSpawn" : s < 40 ? "Apartments" : "BombsiteB";
      put(r, 0, s, route); put(r, 1, s, route);
      put(r, 2, s, s < 10 ? "TSpawn" : "Middle");
      put(r, 3, s, s < 30 ? "TSpawn" : "BombsiteA"); put(r, 4, s, s < 30 ? "TSpawn" : "BombsiteA");
      put(r, 5, s, "BombsiteB"); put(r, 6, s, "Middle"); put(r, 7, s, "BombsiteA"); put(r, 8, s, "BombsiteA"); put(r, 9, s, "CTSpawn");
    }
    nades.push({ r, s: 20, p: 2, type: "smoke", ox: -500, oy: -500, oz: 0, lx: -2000, ly: 300, lz: 0, tick: 0 });
    // a0 kills the B anchor on site at 0:42.
    kills.push({ r, s: 42, k: 0, v: 5, kx: -2000, ky: 300, kz: 0, vx: -1990, vy: 310, vz: 0, w: "ak47", hs: false });
  }
  return { replayId: id, side, when: "2026-01-01", opponent: "x", ins: { v: 4, mapId: "de_mirage", tickMs: 1000 / 64, players, pos, places: PLACES, kills, nades, rounds: out } };
}

describe("callouts", () => {
  it("reads callouts per sample and locates any spot from nearby samples", () => {
    const d = demo("d1", 2);
    const co = new Callouts([d]);
    expect(co.real).toBe(true);
    expect(co.at(d, 0, 0, 20)).toBe("Apartments");
    expect(co.locate(-1995, 305, 10)).toBe("BombsiteB");
    expect(co.siteOf("BombsiteB")).toEqual({ site: "B", dist: 0 });
    expect(co.roleFor(["BombsiteB"], "CT")).toBe("B anchor");
  });

  it("pretty-prints CS2 place names", () => {
    expect(prettyPlace("BombsiteB")).toBe("B site");
    expect(prettyPlace("PalaceInterior")).toBe("Palace interior");
    expect(prettyPlace("TopofMid")).toBe("Top of mid");
    expect(prettyPlace("near A")).toBe("near A");
  });
});

describe("defaults", () => {
  it("finds where each player is in their default and how T rounds end", () => {
    const d = demo("d1", 6);
    const def = findDefaults([d], new Callouts([d]));
    expect(def.T.rounds).toBe(6);
    const a2 = def.T.players.find((p) => p.name === "alpha2")!;
    expect(a2.checkpoints[0].top[0]).toEqual({ c: "Middle", share: 1 });
    const a0 = def.T.players.find((p) => p.name === "alpha0")!;
    expect(a0.checkpoints.map((c) => c.top[0].c)).toEqual(["Apartments", "Apartments", "BombsiteB"]);
    expect(def.T.notes.join(" ")).toMatch(/plant B 100%/);
    expect(def.CT.rounds).toBe(0);
  });
});

describe("your areas and area reports", () => {
  it("works out where your players play", () => {
    // Our team is B in these demos (CT side): b0 anchors B.
    const d = demo("own", 5, "B");
    const mine = yourAreas([d], new Callouts([d]));
    const b0 = mine.find((p) => p.name === "bravo0")!;
    expect(b0.CT.area).toEqual(["BombsiteB"]);
    expect(b0.CT.role).toBe("B anchor");
  });

  it("reports what the opponent does in the B anchor's area", () => {
    const d = demo("opp", 6);
    const co = new Callouts([d]);
    const rep = areaReport([d], co, ["BombsiteB"], "CT");
    expect(rep.rounds).toBe(6);
    const text = rep.sections.flatMap((s) => s.lines.map((l) => l.text)).join("\n");
    expect(text).toMatch(/reach B site in 100% of their T rounds/);
    expect(text).toMatch(/Through Apartments: 100%/);
    expect(text).toMatch(/alpha0: in 100% of rounds/);
    expect(text).toMatch(/Smokes into your area in 100% of rounds, usually at 0:20, mostly alpha2 from Middle/);
    expect(text).toMatch(/First fight here: they win 100%/);
    expect(rep.tips.join(" ")).toMatch(/Apartments/);
    expect(rep.marks.some((m) => m.kind === "smoke")).toBe(true);
    expect(rep.examples[0]).toMatchObject({ replayId: "opp", roundNumber: 2 });
  });

  it("reports how the opponent holds an area when you attack it", () => {
    // The opponent is team B (CT) here; we attack B site.
    const d = demo("opp", 5, "B");
    const rep = areaReport([d], new Callouts([d]), ["BombsiteB"], "T");
    const text = rep.sections.flatMap((s) => s.lines.map((l) => l.text)).join("\n");
    expect(text).toMatch(/1 defender at 0:15 in 100% of rounds/);
    expect(text).toMatch(/bravo0: here in 100% of rounds \(B site 100%\)/);
    expect(rep.tips.join(" ")).toMatch(/bravo0 is the usual defender/);
  });
});

describe("anchor areas", () => {
  it("adds the bomb site to an anchor who holds a corner of it", () => {
    const d = demo("own", 4, "B");
    // b0 holds a corner next to B site (Underpass sample placed near the site) instead of the site itself.
    const P = d.ins.pos;
    for (let i = 0; i < P.r.length; i++) if (P.p[i] === 5) { P.c![i] = PLACES.indexOf("Underpass"); P.x[i] = -1900; P.y[i] = 250; }
    const co = new Callouts([d]);
    const b0 = yourAreas([d], co).find((p) => p.name === "bravo0")!;
    expect(b0.CT.area).toEqual(["Underpass", "BombsiteB"]);
    expect(b0.CT.role).toBe("B anchor");
  });
});
