import { describe, expect, it } from "vitest";
import type { Manifest, PlayerRoundStats } from "@/shared/contract";
import { listTeams, summarizeManifest, teamDetail, type IndexedReplay } from "@/lib/statIndex";

const ps = (side: "CT" | "T", o: Partial<PlayerRoundStats> = {}): PlayerRoundStats => ({
  side, k: 0, d: 0, a: 0, fa: 0, hs: 0, tk: 0, dmg: 0, ud: 0, ef: 0, fd: 0, ok: 0, od: 0, trk: 0, trd: 0, surv: 1, kast: 1, cl: 0, cw: 0, eq: null, ...o,
});

function manifest(aName: string, bName: string, aWins: number[], extra: Partial<Manifest> = {}): Manifest {
  const rounds = aWins.map((w, i) => ({
    id: `r${i + 1}`, displayNumber: i + 1, sides: { A: i < 12 ? "CT" : "T", B: i < 12 ? "T" : "CT" }, winner: w ? "A" : "B", isPistol: i === 0,
    playerStats: { a1: ps(i < 12 ? "CT" : "T", { k: w ? 1 : 0, ok: w ? 1 : 0, dmg: 80 }), b1: ps(i < 12 ? "T" : "CT", { od: w ? 1 : 0, d: w ? 1 : 0, surv: w ? 0 : 1 }) },
  }));
  const a = aWins.filter(Boolean).length;
  return {
    teams: { A: { key: "A", name: aName, nameSource: "clan", startSide: "CT" }, B: { key: "B", name: bName, nameSource: bName.startsWith("Team ") ? "fallback" : "clan", startSide: "T" } },
    players: [{ id: "a1", name: "Ace", team: "A", steamId: "1", isBot: false }, { id: "b1", name: "Bee", team: "B", steamId: "2", isBot: false }],
    finalScore: { A: a, B: aWins.length - a },
    rounds,
    ...extra,
  } as unknown as Manifest;
}

const indexed = (id: string, mapId: string, m: Manifest): IndexedReplay => ({
  id, title: null, mapId, createdAt: `2026-11-0${id.length}T00:00:00Z`, playedAt: null, seriesId: null, summary: summarizeManifest(m),
});

describe("cross-demo stats", () => {
  it("summarises one demo per team: rounds by side, pistols, opening duels", () => {
    const s = summarizeManifest(manifest("Harbour", "Rivals", [1, 1, 0]));
    expect(s.teams.A).toMatchObject({ score: 2, oppScore: 1, rounds: { w: 2, p: 3 }, ct: { w: 2, p: 3 }, pistol: { w: 1, p: 1 }, opening: { w: 2, p: 2 } });
    expect(s.teams.B.opening).toEqual({ w: 0, p: 2 });
    expect(s.players.find((p) => p.id === "a1")?.k).toBe(2);
    expect(s.hasPlayers).toBe(true);
  });

  it("groups teams by name across demos and skips fallback names", () => {
    const reps = [
      indexed("x1", "de_mirage", manifest("Harbour", "Rivals", [1, 1, 0])),
      indexed("x22", "de_nuke", manifest("harbour ", "Others", [0, 0, 1])),
      indexed("x333", "de_nuke", manifest("Harbour", "Team Bravo", [1])),
    ];
    const list = listTeams(reps);
    expect(list.find((t) => t.key === "harbour")).toMatchObject({ demos: 3, wins: 2, losses: 1 });
    expect(list.some((t) => t.name === "Team Bravo")).toBe(false);

    const d = teamDetail(reps, "harbour", null)!;
    expect(d).toMatchObject({ demos: 3, wins: 2, losses: 1 });
    expect(d.maps.map((m) => [m.mapId, m.played])).toEqual([["de_nuke", 2], ["de_mirage", 1]]);
    expect(d.overall.rounds).toEqual({ w: 4, p: 7 });
    expect(d.players).toHaveLength(1);
    expect(d.players[0]).toMatchObject({ name: "Ace", maps: 3, rounds: 7, k: 4 });
    expect(d.opponents.map((o) => o.name).sort()).toEqual(["Others", "Rivals", "Team Bravo"]);
    expect(teamDetail(reps, "harbour", "de_mirage")!.demos).toBe(1);
    expect(teamDetail(reps, "nobody", null)).toBeNull();
  });
});
