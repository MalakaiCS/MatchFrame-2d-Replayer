/**
 * Deterministic frame reconstruction. frameAt(index, tick) is a pure function
 * of the round payload and the tick: seeking forwards, backwards, at any
 * speed, or after any UI state produces the identical frame.
 */
import type { BombState, Effect, GameEvent, Grenade, PlayerTrack, RoundPayload, Vec3 } from "@/shared/contract";

export interface PlayerFrame {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  alive: boolean;
  hp: number | null;
  armor: number | null;
  money: number | null;
  weapon: string | null;
  /** Clip / reserve of the active weapon, null when not applicable or unknown. */
  clip: number | null;
  reserve: number | null;
  flags: number;
  floor: number;
  /** False when no valid sample covers this tick (not yet recorded, disconnected, or a data gap). */
  visible: boolean;
  interpolated: boolean;
}

export interface DeathMarker {
  playerId: string;
  tick: number;
  position: Vec3;
  killer: string | null;
  weapon: string | null;
}

export interface GrenadeFrame {
  id: string;
  type: Grenade["type"];
  throwerId: string | null;
  position: Vec3;
  /** Path drawn so far (only recorded points; never invented). */
  trail: [number, number][];
}

export interface EffectFrame {
  effect: Effect;
  /** 0..1 progress through the effect, or null when the end was not recorded. */
  progress: number | null;
  disruptions: Effect["disruptions"];
}

export interface BombFrame {
  state: BombState;
  carrier: string | null;
  position: Vec3 | null;
  site: string | null;
  sinceTick: number | null;
  plantedTick: number | null;
}

export interface Frame {
  tick: number;
  players: PlayerFrame[];
  deaths: DeathMarker[];
  bomb: BombFrame;
  grenades: GrenadeFrame[];
  effects: EffectFrame[];
}

export interface RoundIndex {
  payload: RoundPayload;
  deathTick: Map<string, number>;
  kills: GameEvent[];
  /** Maximum gap (ticks) over which a held sample is still considered valid. */
  holdTicks: number;
}

export function indexRound(payload: RoundPayload): RoundIndex {
  const kills = payload.events.filter((e) => e.type === "kill");
  const deathTick = new Map<string, number>();
  for (const k of kills) {
    if (k.target && !deathTick.has(k.target)) deathTick.set(k.target, k.tick);
  }
  return { payload, deathTick, kills, holdTicks: payload.sampleEveryTicks * 2 };
}

/** Largest i with arr[i] <= x, or -1. */
export function bisectRight(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Interpolate angles in degrees along the shortest arc. */
export function lerpYaw(a: number, b: number, t: number): number {
  let d = ((b - a + 540) % 360) - 180;
  if (d === -180 && b > a) d = 180;
  const v = a + d * t;
  return ((v + 540) % 360) - 180;
}

function playerAt(idx: RoundIndex, tr: PlayerTrack, tick: number, weapons: string[]): PlayerFrame {
  const i = bisectRight(tr.t, tick);
  const base: PlayerFrame = {
    id: tr.playerId, x: 0, y: 0, z: 0, yaw: 0, alive: false, hp: null, armor: null, money: null, weapon: null, clip: null, reserve: null,
    flags: 0, floor: 0, visible: false, interpolated: false,
  };
  if (i < 0) return base;
  const dt = idx.deathTick.get(tr.playerId);
  const deadByEvent = dt !== undefined && tick >= dt;
  const sampleAlive = tr.alive[i] === 1;
  const j = i + 1;
  const canLerp =
    j < tr.t.length &&
    tr.disc[j] === 0 &&
    tr.alive[i] === 1 &&
    tr.alive[j] === 1 &&
    tr.floor[i] === tr.floor[j] &&
    tr.t[j] - tr.t[i] <= idx.holdTicks &&
    !(dt !== undefined && dt <= tr.t[j]);
  // A held (non-interpolated) sample is valid for holdTicks; beyond that the player is
  // hidden until valid data resumes (disconnects, POV coverage gaps, long gaps).
  const held = tick - tr.t[i];
  const stale = !canLerp && held > idx.holdTicks;
  const out: PlayerFrame = {
    ...base,
    x: tr.x[i], y: tr.y[i], z: tr.z[i], yaw: tr.yaw[i],
    alive: sampleAlive && !deadByEvent,
    hp: tr.hp ? (deadByEvent ? 0 : tr.hp[i]) : null,
    armor: tr.armor ? tr.armor[i] : null,
    money: tr.money ? tr.money[i] : null,
    weapon: tr.weapon && tr.weapon[i] >= 0 ? weapons[tr.weapon[i]] : null,
    clip: tr.clip && tr.clip[i] >= 0 && !deadByEvent ? tr.clip[i] : null,
    reserve: tr.reserve && tr.reserve[i] >= 0 && !deadByEvent ? tr.reserve[i] : null,
    flags: tr.flags[i], floor: tr.floor[i],
    visible: !stale || deadByEvent || !sampleAlive,
  };
  if (canLerp && tick > tr.t[i] && !deadByEvent) {
    const f = (tick - tr.t[i]) / (tr.t[j] - tr.t[i]);
    out.x = tr.x[i] + (tr.x[j] - tr.x[i]) * f;
    out.y = tr.y[i] + (tr.y[j] - tr.y[i]) * f;
    out.z = tr.z[i] + (tr.z[j] - tr.z[i]) * f;
    out.yaw = lerpYaw(tr.yaw[i], tr.yaw[j], f);
    out.interpolated = true;
  }
  return out;
}

function bombAt(p: RoundPayload, tick: number): BombFrame {
  let cur: BombFrame = { state: "unknown", carrier: null, position: null, site: null, sinceTick: null, plantedTick: null };
  let planted: number | null = null;
  for (const b of p.bomb) {
    if (b.tick > tick) break;
    if (b.state === "planted" && planted === null) planted = b.tick;
    cur = { state: b.state, carrier: b.carrier, position: b.position, site: b.site, sinceTick: b.tick, plantedTick: planted };
  }
  return cur;
}

function grenadesAt(p: RoundPayload, tick: number): GrenadeFrame[] {
  const out: GrenadeFrame[] = [];
  for (const g of p.grenades) {
    if (g.throwTick > tick) break;
    if (!g.path.length) continue; // detonation-only: shown as an effect, never as an invented flight
    const end = g.detonateTick ?? g.path[g.path.length - 1][0];
    if (tick > end) continue;
    const ticks = g.path.map((q) => q[0]);
    const i = Math.max(0, bisectRight(ticks, tick));
    const a = g.path[i];
    const b = g.path[Math.min(i + 1, g.path.length - 1)];
    const f = b[0] > a[0] ? Math.min(1, Math.max(0, (tick - a[0]) / (b[0] - a[0]))) : 0;
    out.push({
      id: g.id, type: g.type, throwerId: g.throwerId,
      position: { x: a[1] + (b[1] - a[1]) * f, y: a[2] + (b[2] - a[2]) * f, z: a[3] + (b[3] - a[3]) * f },
      trail: g.path.slice(0, i + 1).map((q) => [q[1], q[2]] as [number, number]),
    });
  }
  return out;
}

function effectsAt(p: RoundPayload, tick: number): EffectFrame[] {
  const out: EffectFrame[] = [];
  for (const e of p.effects) {
    if (e.startTick > tick) break;
    const end = e.endTick ?? p.endTick;
    if (tick >= end) continue;
    out.push({
      effect: e,
      progress: e.endTick === null ? null : (tick - e.startTick) / Math.max(1, e.endTick - e.startTick),
      disruptions: e.disruptions.filter((d) => d.startTick <= tick && tick < d.endTick),
    });
  }
  return out;
}

export function frameAt(idx: RoundIndex, tick: number): Frame {
  const p = idx.payload;
  const t = Math.min(Math.max(tick, p.startTick), p.endTick - 1);
  const deaths: DeathMarker[] = [];
  for (const k of idx.kills) {
    if (k.tick > t) break;
    if (k.target && k.position) deaths.push({ playerId: k.target, tick: k.tick, position: k.position, killer: k.actor ?? null, weapon: k.weapon ?? null });
  }
  return {
    tick: t,
    players: p.tracks.map((tr) => playerAt(idx, tr, t, p.weapons)),
    deaths,
    bomb: bombAt(p, t),
    grenades: grenadesAt(p, t),
    effects: effectsAt(p, t),
  };
}

/** Inventory at a tick: last recorded change per player. */
export function inventoryAt(p: RoundPayload, tick: number): Map<string, string[]> {
  const m = new Map<string, string[]>();
  // Ordered by tick in schema v1 payloads; do not rely on it (older payloads grouped by player).
  const at = new Map<string, number>();
  for (const c of p.inventory) {
    if (c.tick > tick) continue;
    if ((at.get(c.playerId) ?? -Infinity) <= c.tick) {
      at.set(c.playerId, c.tick);
      m.set(c.playerId, c.items);
    }
  }
  return m;
}

export const FLAGS = { bomb: 1, defuser: 2, helmet: 4, defusing: 8, planting: 16, scoped: 32, blinded: 64 } as const;

/** Event jump targets: next/previous navigable event strictly after/before tick. */
export function nextEvent(events: GameEvent[], tick: number, dir: 1 | -1, types?: Set<string>): GameEvent | null {
  const list = types ? events.filter((e) => types.has(e.type)) : events;
  if (dir > 0) return list.find((e) => e.tick > tick) ?? null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].tick < tick) return list[i];
  return null;
}

/**
 * Recent movement for each alive player: recorded samples in (tick - windowTicks, tick], plus the
 * current position. Gaps (disconnects, deaths, floor changes) end a trail rather than bridging it.
 */
export function trailsAt(idx: RoundIndex, tick: number, windowTicks: number, frame: Frame): Map<string, { pts: [number, number][]; floor: number }> {
  const out = new Map<string, { pts: [number, number][]; floor: number }>();
  const now = new Map(frame.players.map((p) => [p.id, p]));
  for (const tr of idx.payload.tracks) {
    const cur = now.get(tr.playerId);
    if (!cur || !cur.alive || !cur.visible) continue;
    const end = bisectRight(tr.t, tick);
    if (end < 0) continue;
    const pts: [number, number][] = [];
    for (let i = end; i >= 0 && tick - tr.t[i] <= windowTicks; i--) {
      if (!tr.alive[i] || tr.floor[i] !== cur.floor) break;
      pts.push([tr.x[i], tr.y[i]]);
      if (tr.disc[i]) break;
    }
    pts.reverse();
    pts.push([cur.x, cur.y]);
    if (pts.length > 1) out.set(tr.playerId, { pts, floor: cur.floor });
  }
  return out;
}
