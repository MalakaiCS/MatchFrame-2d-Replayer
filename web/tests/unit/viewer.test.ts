import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Manifest, RoundPayload } from "@/shared/contract";
import { normalizeBuyType, roundMsToTick, tickToRoundMs } from "@/shared/contract";
import { audioTimeFor, decide, DRIFT_TOLERANCE_S } from "@/viewer/audioSync";
import { clockAt, formatMs } from "@/viewer/clock";
import { EMPTY_FILTERS, filterRounds, filtersFromParam, filtersToParam, type RoundFilters } from "@/viewer/filters";
import { floorForZ, getMapDef, imageToScreen, screenToImage, worldToImage, zoomAt } from "@/viewer/maps";
import { frameAt, indexRound, inventoryAt, lerpYaw, nextEvent } from "@/viewer/playback";
import { buildReplayUrl, resolveMoment, shareTokenFromHash } from "@/viewer/shareUrl";

const dir = path.resolve(__dirname, "../fixtures/synthetic-mirage");
const manifest: Manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
const load = (id: string): RoundPayload => JSON.parse(gunzipSync(readFileSync(path.join(dir, `${id}.json.gz`))).toString());
const r05 = load("r05");
const r06 = load("r06");
const idx5 = indexRound(r05);

const f = (patch: Partial<RoundFilters>): RoundFilters => ({ ...EMPTY_FILTERS, kind: [], buy: [], winner: [], ...patch });

describe("deterministic seeking", () => {
  it("produces identical frames regardless of seek order or direction", () => {
    const ticks: number[] = [];
    for (let t = r05.startTick; t < r05.endTick; t += 37) ticks.push(t);
    const forward = ticks.map((t) => JSON.stringify(frameAt(idx5, t)));
    const backward = [...ticks].reverse().map((t) => JSON.stringify(frameAt(idx5, t))).reverse();
    const shuffled = ticks.map((t, i) => [t, i] as const).sort(() => 0.5 - Math.random());
    const random: string[] = [];
    for (const [t, i] of shuffled) random[i] = JSON.stringify(frameAt(indexRound(r05), t));
    expect(backward).toEqual(forward);
    expect(random).toEqual(forward);
  });

  it("covers bomb, utility, overlay expiry and smoke disruption state", () => {
    const disrupt = r05.events.find((e) => e.type === "smoke_disrupted")!;
    const fr = frameAt(idx5, disrupt.tick);
    const smoke = fr.effects.find((e) => e.disruptions.length > 0);
    expect(smoke?.effect.kind).toBe("smoke");
    expect(smoke?.disruptions[0].provenance).toBe("inferred");
    const after = frameAt(idx5, smoke!.disruptions[0].endTick);
    expect(after.effects.find((e) => e.effect.id === smoke!.effect.id)?.disruptions).toEqual([]);
    const end = smoke!.effect.endTick!;
    expect(frameAt(idx5, end - 1).effects.some((e) => e.effect.id === smoke!.effect.id)).toBe(true);
    expect(frameAt(idx5, end).effects.some((e) => e.effect.id === smoke!.effect.id)).toBe(false);
    const plant = r05.bomb.find((b) => b.state === "planted")!;
    expect(frameAt(idx5, plant.tick - 1).bomb.state).not.toBe("planted");
    expect(frameAt(idx5, plant.tick).bomb.state).toBe("planted");
    expect(frameAt(idx5, plant.tick).bomb.position).toEqual(plant.position);
  });

  it("clamps out-of-round ticks", () => {
    expect(frameAt(idx5, -5).tick).toBe(r05.startTick);
    expect(frameAt(idx5, 1e12).tick).toBe(r05.endTick - 1);
  });
});

describe("players", () => {
  it("interpolates position and keeps the player dead from the kill tick onwards", () => {
    const kill = idx5.kills[0];
    const victim = kill.target!;
    expect(frameAt(idx5, kill.tick - 1).players.find((p) => p.id === victim)!.alive).toBe(true);
    const dead = frameAt(idx5, kill.tick).players.find((p) => p.id === victim)!;
    expect(dead.alive).toBe(false);
    expect(dead.hp).toBe(0);
    expect(frameAt(idx5, r05.endTick - 1).deaths.some((d) => d.playerId === victim)).toBe(true);
  });

  it("interpolates between compatible samples only", () => {
    const tr = r05.tracks[1];
    const i = tr.disc.findIndex((d, k) => k > 5 && d === 0 && tr.alive[k] === 1 && tr.alive[k - 1] === 1);
    const mid = (tr.t[i - 1] + tr.t[i]) / 2;
    const p = frameAt(idx5, mid).players.find((x) => x.id === tr.playerId)!;
    expect(p.interpolated).toBe(true);
    expect(p.x).toBeCloseTo((tr.x[i - 1] + tr.x[i]) / 2, 5);
  });

  it("hides a disconnected player until data resumes, and keeps identity after reconnect", () => {
    const pid = "s:76561198000000003";
    const dc = r05.events.find((e) => e.type === "disconnect" && e.actor === pid)!;
    const gone = frameAt(idx5, dc.tick + 640).players.find((x) => x.id === pid)!;
    expect(gone.visible).toBe(false);
    const idx6 = indexRound(r06);
    const back = frameAt(idx6, r06.startTick + 200).players.find((x) => x.id === pid)!;
    expect(back.visible).toBe(true);
  });

  it("uses shortest-arc yaw", () => {
    // +180 and -180 are the same heading; the arc must pass through it rather than through 0.
    expect(Math.abs(lerpYaw(170, -170, 0.5))).toBeCloseTo(180, 5);
    expect(Math.abs(lerpYaw(-170, 170, 0.5))).toBeCloseTo(180, 5);
    expect(lerpYaw(170, -170, 0.25)).toBeCloseTo(175, 5);
    expect(lerpYaw(10, 30, 0.5)).toBeCloseTo(20, 5);
  });

  it("reports inventory at a tick for every sampled player", () => {
    const inv = inventoryAt(r05, r05.startTick + 64);
    const sampled = r05.tracks.filter((t) => t.t[0] <= r05.startTick + 64).length;
    expect(inv.size).toBe(sampled);
  });
});

describe("events", () => {
  it("event jumps land on recorded ticks", () => {
    const k = idx5.kills[2];
    expect(nextEvent(r05.events, k.tick - 1, 1, new Set(["kill"]))!.tick).toBe(k.tick);
    expect(nextEvent(r05.events, k.tick, -1, new Set(["kill"]))!.tick).toBe(idx5.kills[1].tick);
  });
});

describe("round filters", () => {
  const rounds = manifest.rounds;
  it("pistol vs gun", () => {
    expect(filterRounds(rounds, f({ kind: ["pistol"] })).map((r) => r.displayNumber)).toEqual([1, 13]);
    const gun = filterRounds(rounds, f({ kind: ["gun"] }));
    expect(gun).toHaveLength(27);
    expect(gun.some((r) => r.isOvertime)).toBe(true);
  });
  it("preserves original round ids, numbers, ticks and scores", () => {
    const out = filterRounds(rounds, f({ kind: ["pistol"] }));
    expect(out[1]).toBe(rounds[12]);
    expect(out[1].scoreBefore).toEqual(rounds[12].scoreBefore);
  });
  it("combines categories with AND and options with OR", () => {
    const res = filterRounds(rounds, f({ kind: ["gun"], winner: ["A"], side: { team: "A", side: "CT" } }));
    expect(res.every((r) => !r.isPistol && r.winner === "A" && r.sides.A === "CT")).toBe(true);
    const either = filterRounds(rounds, f({ buy: ["eco", "full_buy"], buyTeam: "B" }));
    expect(either.length).toBeGreaterThan(0);
    expect(either.every((r) => ["eco", "full_buy"].includes(normalizeBuyType(r.economy.B.buyType)!))).toBe(true);
  });
  it("overtime and empty results", () => {
    expect(filterRounds(rounds, f({ overtime: "only" })).map((r) => r.displayNumber)).toEqual([25, 26, 27, 28, 29]);
    expect(filterRounds(rounds, f({ kind: ["pistol"], overtime: "only" }))).toEqual([]);
  });
  it("unknown economy only matches the unknown option", () => {
    const unknown = rounds.map((r) => ({ ...r, economy: { A: { ...r.economy.A, buyType: r.isPistol ? "pistol" as const : null, equipmentValue: null }, B: r.economy.B } }));
    expect(filterRounds(unknown, f({ buy: ["full_buy"], buyTeam: "A" }))).toEqual([]);
    expect(filterRounds(unknown, f({ buy: ["unknown"], buyTeam: "A" }))).toHaveLength(27);
  });
  it("maps buy types from older replays to the current categories", () => {
    expect(normalizeBuyType("semi_eco")).toBe("half_buy");
    expect(normalizeBuyType("semi_buy")).toBe("half_buy");
    expect(normalizeBuyType("full")).toBe("full_buy");
    expect(normalizeBuyType("pistol")).toBe("pistol");
    expect(normalizeBuyType(null)).toBeNull();
    const legacy = rounds.map((r) => ({ ...r, economy: { ...r.economy, A: { ...r.economy.A, buyType: (r.isPistol ? "pistol" : "semi_buy") as never } } }));
    expect(filterRounds(legacy, f({ buy: ["half_buy"], buyTeam: "A" }))).toHaveLength(27);
  });
  it("round-trips through the URL", () => {
    const x = f({ kind: ["gun"], buy: ["half_buy", "unknown"], buyTeam: "A", side: { team: "B", side: "T" }, winner: ["B"], overtime: "exclude", bomb: "planted" });
    expect(filtersFromParam(filtersToParam(x))).toEqual(x);
    expect(filtersFromParam("garbage;;k:nope;s:ZZ")).toEqual(f({}));
  });
});

describe("clock", () => {
  const r = manifest.rounds[4];
  it("counts down freeze, round and post-plant", () => {
    const freeze = clockAt(manifest, r, r05, r.startTick + 64);
    expect(freeze.phase).toBe("freeze");
    expect(freeze.mode).toBe("countdown");
    expect(freeze.ms).toBe(14000);
    const live = clockAt(manifest, r, r05, r.freezeEndTick! + 640);
    expect(live.phase).toBe("live");
    expect(live.ms).toBe(105200); // mp_roundtime_defuse 1.92 min = 115.2 s
    const plant = r05.bomb.find((b) => b.state === "planted")!;
    const pp = clockAt(manifest, r, r05, plant.tick + 64 * 5);
    expect(pp.phase).toBe("planted");
    expect(pp.ms).toBe(35000);
    expect(clockAt(manifest, r, r05, r.decidedTick!).phase).toBe("over");
  });
  it("falls back to labelled elapsed time", () => {
    const m2 = { ...manifest, capabilities: { ...manifest.capabilities, clock: "elapsed" as const } };
    const c = clockAt(m2, r, r05, r.startTick + 640);
    expect(c.mode).toBe("elapsed");
    expect(c.label).toContain("elapsed");
    expect(c.text).toBe("0:10");
  });
  it("formats", () => {
    expect(formatMs(65000)).toBe("1:05");
  });
});

describe("tick/time conversion", () => {
  it("round-trips with half-up rounding", () => {
    const r = manifest.rounds[0];
    const tick = r.startTick + 123;
    const ms = tickToRoundMs(tick, r, manifest.tickIntervalMs);
    expect(ms).toBe(Math.round(123 * 15.625));
    expect(roundMsToTick(ms, r, manifest.tickIntervalMs)).toBe(tick);
    expect(roundMsToTick(1e9, r, manifest.tickIntervalMs)).toBe(r.endTick - 1);
  });
});

describe("map transforms", () => {
  const m = getMapDef("de_mirage")!;
  it("maps the world origin to image (0,0) and scales by the registry", () => {
    expect(worldToImage(m, m.originX, m.originY)).toEqual([0, 0]);
    expect(worldToImage(m, m.originX + 500, m.originY - 1000)).toEqual([100, 200]);
  });
  it("viewport transforms invert", () => {
    const v = { zoom: 2.5, cx: 400, cy: 600 };
    const [sx, sy] = imageToScreen(v, 1024, 800, 600, 123, 456);
    const [ix, iy] = screenToImage(v, 1024, 800, 600, sx, sy);
    expect(ix).toBeCloseTo(123, 6);
    expect(iy).toBeCloseTo(456, 6);
  });
  it("zooming keeps the cursor point fixed", () => {
    const v = { zoom: 1, cx: 512, cy: 512 };
    const before = screenToImage(v, 1024, 800, 600, 100, 100);
    const v2 = zoomAt(v, 1024, 800, 600, 100, 100, 2);
    const after = screenToImage(v2, 1024, 800, 600, 100, 100);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
  });
  it("assigns Nuke floors by height", () => {
    const nuke = getMapDef("de_nuke")!;
    expect(floorForZ(nuke, -410)).toBe(0);
    expect(floorForZ(nuke, -770)).toBe(1);
  });
});

describe("share links", () => {
  it("puts the token in the fragment only", () => {
    const url = buildReplayUrl("https://2d.matchframe.tv", "abc123", "r05", 41234.4, "T".repeat(43));
    const u = new URL(url);
    expect(u.pathname).toBe("/replays/abc123");
    expect(u.searchParams.get("r")).toBe("r05");
    expect(u.searchParams.get("t")).toBe("41234");
    expect(u.search).not.toContain("TTTT");
    expect(shareTokenFromHash(u.hash)).toBe("T".repeat(43));
    expect(shareTokenFromHash("#s=bad token")).toBeNull();
  });
  it("clamps malformed or out-of-range moments", () => {
    expect(resolveMoment(manifest, "r99", "1000").round.id).toBe("r01");
    expect(resolveMoment(manifest, "r99", "1000").clamped).toBe(true);
    const r = manifest.rounds[4];
    expect(resolveMoment(manifest, "r05", "-3").tick).toBe(r.freezeEndTick);
    expect(resolveMoment(manifest, "r05", "NaN").clamped).toBe(true);
    expect(resolveMoment(manifest, "r05", "99999999").tick).toBe(r.endTick - 1);
    const ok = resolveMoment(manifest, "r05", "20000");
    expect(ok.tick).toBe(r.startTick + 1280);
    expect(ok.clamped).toBe(false);
  });
});

describe("audio sync", () => {
  const base = { tickIntervalMs: 15.625, offsetMs: 10_000, playing: true, speed: 1, duration: 600, currentTime: 0, paused: false };
  it("maps demo time to audio time with the offset", () => {
    expect(audioTimeFor(64 * 20, 15.625, 10_000)).toBe(10);
  });
  it("is silent before the recording starts and after it ends", () => {
    expect(decide({ ...base, tick: 64 * 5 }).inRange).toBe(false);
    expect(decide({ ...base, tick: 64 * 5 }).play).toBe(false);
    expect(decide({ ...base, tick: 64 * 700 }).inRange).toBe(false);
  });
  it("resynchronises when drift exceeds the tolerance and follows speed", () => {
    const t = 64 * 30; // audio time 20 s
    expect(decide({ ...base, tick: t, currentTime: 20 + DRIFT_TOLERANCE_S / 2 }).seekTo).toBeNull();
    expect(decide({ ...base, tick: t, currentTime: 21 }).seekTo).toBe(20);
    expect(decide({ ...base, tick: t, currentTime: 20, speed: 2 }).rate).toBe(2);
    expect(decide({ ...base, tick: t, currentTime: 20, speed: 8 }).muted).toBe(true);
    expect(decide({ ...base, tick: t, currentTime: 20, playing: false }).play).toBe(false);
  });
});

import { trailsAt as trailsAtFn, indexRound as indexRoundFn, frameAt as frameAtFn } from "@/viewer/playback";
describe("movement trails", () => {
  it("returns the last seconds of movement for alive players, ending at the current position", () => {
    const payload = {
      startTick: 0, endTick: 1000, sampleEveryTicks: 64, weapons: [], events: [], bomb: [], grenades: [], effects: [], inventory: [],
      tracks: [{
        playerId: "p", t: [0, 64, 128, 192, 256], x: [0, 10, 20, 30, 40], y: [0, 0, 0, 0, 0], z: [0, 0, 0, 0, 0], yaw: [0, 0, 0, 0, 0],
        alive: [1, 1, 1, 1, 1], hp: null, armor: null, money: null, weapon: null, flags: [0, 0, 0, 0, 0], floor: [0, 0, 0, 0, 0], disc: [0, 0, 0, 0, 0],
      }],
    } as never;
    const idx = indexRoundFn(payload);
    const tick = 224;
    const tr = trailsAtFn(idx, tick, 128, frameAtFn(idx, tick)).get("p")!;
    expect(tr.pts.map((p) => p[0])).toEqual([20, 30, 35]);
  });
});

import { ctWinProbability } from "@/viewer/winprob";
describe("win probability", () => {
  const base = { ctAlive: 5, tAlive: 5, ctHp: 500, tHp: 500, ctEq: 20000, tEq: 20000, planted: false, bombLeft: 0, roundLeft: 1 };
  it("follows the state of the round", () => {
    const even = ctWinProbability(base);
    expect(even).toBeGreaterThan(0.3);
    expect(even).toBeLessThan(0.75);
    expect(ctWinProbability({ ...base, tAlive: 3, tHp: 300 })).toBeGreaterThan(even);
    expect(ctWinProbability({ ...base, ctAlive: 2, ctHp: 200 })).toBeLessThan(even);
    expect(ctWinProbability({ ...base, planted: true, bombLeft: 0.2 })).toBeLessThan(ctWinProbability({ ...base, planted: true, bombLeft: 0.9 }));
    expect(ctWinProbability({ ...base, ctAlive: 0 })).toBe(0);
    expect(ctWinProbability({ ...base, tAlive: 0 })).toBe(1);
  });
});
