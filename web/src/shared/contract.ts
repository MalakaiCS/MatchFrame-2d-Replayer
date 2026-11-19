/**
 * Replay data contract, schema version 1.
 * The Python worker (worker/matchframe_worker/transform.py) produces these
 * objects; the viewer consumes them. See docs/data-contract.md.
 *
 * Conventions
 * - Demo ticks are the authoritative coordinate for playback and ordering.
 * - Round windows are [startTick, endTick): endTick is exclusive and equals the
 *   next round's startTick (or the last recorded tick + 1 for the final round).
 * - Round-relative ms = round((tick - round.startTick) * tickIntervalMs), half-up.
 * - Demo-time ms (used for audio alignment) = round(tick * tickIntervalMs).
 */

export const SCHEMA_VERSION = 1 as const;

export type Side = "CT" | "T";
export type TeamKey = "A" | "B";
export type BuyType = "pistol" | "eco" | "half_buy" | "full_buy";

/** Replays processed before the category change used semi_eco / semi_buy / full; map them on read. */
export function normalizeBuyType(v: string | null | undefined): BuyType | null {
  if (v === null || v === undefined) return null;
  if (v === "semi_eco" || v === "semi_buy" || v === "half" || v === "force") return "half_buy";
  if (v === "full") return "full_buy";
  return v === "pistol" || v === "eco" || v === "half_buy" || v === "full_buy" ? v : null;
}

export interface PlayerInfo {
  /** Replay-local stable ID: "s:<steamid64>" for humans, "b:<n>" for bots or ambiguous IDs. */
  id: string;
  name: string;
  steamId: string | null;
  isBot: boolean;
  team: TeamKey;
}

export interface TeamIdentity {
  key: TeamKey;
  name: string;
  /** Where the name came from: the in-game clan tag, or a generated fallback label. */
  /** clan = in-game team name; fallback = "Team Alpha"/"Team Bravo" (as the reference names unnamed teams); edited = renamed by a user. */
  nameSource: "clan" | "fallback" | "edited";
  startSide: Side;
}

export interface Capabilities {
  clock: "countdown" | "elapsed";
  participants: "all" | "partial";
  health: boolean;
  armor: boolean;
  money: boolean;
  /** Clip / reserve ammo for the active weapon. Absent on replays processed before ammo support. */
  ammo?: boolean;
  /** "recorded": reserve read from the weapon entity; "none": not extracted (magazine only). */
  reserveAmmo?: "recorded" | "none" | "estimated";
  /** Damage and blind events were recorded (ADR, utility damage, flashes). Worker 0.2.0+. */
  damage?: boolean;
  blinds?: boolean;
  inventory: boolean;
  economy: boolean;
  bombPosition: boolean;
  utilityPaths: boolean;
  utilityEffects: boolean;
  smokeDisruption: "none" | "inferred" | "recorded";
  floors: "single" | "rule-based";
  viewAngles: boolean;
}

export interface TeamEconomy {
  /** Team total equipment value at freeze end, or null if unknown. */
  equipmentValue: number | null;
  buyType: BuyType | null;
  /** Buy type reported by the parser, recorded for comparison. */
  parserBuyType: string | null;
  players: number;
}

export interface RoundSummary {
  id: string;
  displayNumber: number;
  startTick: number;
  freezeEndTick: number | null;
  /** Tick of round_end (winner decided), null if not recorded. */
  decidedTick: number | null;
  /** Exclusive. */
  endTick: number;
  sides: Record<TeamKey, Side>;
  scoreBefore: Record<TeamKey, number>;
  scoreAfter: Record<TeamKey, number>;
  winner: TeamKey | null;
  winnerSide: Side | null;
  endReason: string | null;
  durationMs: number;
  half: number;
  isOvertime: boolean;
  isPistol: boolean;
  /** First round of an overtime half (teams receive overtime money; not a pistol round). */
  isOvertimeHalfStart: boolean;
  economy: Record<TeamKey, TeamEconomy>;
  /** POV / partial demos: share of the round each player has samples for (0..1). */
  coverage: Record<string, number>;
  bombPlanted: boolean;
  /** Per-player stats for this round (worker 0.2.0+; absent on older replays). See docs/data-contract.md. */
  playerStats?: Record<string, PlayerRoundStats>;
  payload: { key: string; bytes: number; sha256: string };
}

/** One player's stats in one round. Definitions: docs/data-contract.md, "Player stats". */
export interface PlayerRoundStats {
  side: Side;
  /** Enemy kills, deaths, assists (flash assists included), flash assists, headshot kills, team kills. */
  k: number; d: number; a: number; fa: number; hs: number; tk: number;
  /** Health damage to enemies (capped at health left, until the round is decided) and the utility part of it. */
  dmg: number; ud: number;
  /** Enemies flashed and total enemy blind seconds. */
  ef: number; fd: number;
  /** Opening kill / death, trade kills, traded death. */
  ok: number; od: number; trk: number; trd: number;
  /** Survived the round; KAST (kill, assist, survived or traded). */
  surv: number; kast: number;
  /** Clutch: enemies alive when this player became the last of their side (0 = no clutch), and whether it was won. */
  cl: number; cw: number;
  /** Equipment value at freeze end, when recorded. */
  eq: number | null;
}

export interface Manifest {
  schemaVersion: typeof SCHEMA_VERSION;
  replayId: string;
  revision: number;
  parser: { name: string; version: string; worker: string; synthetic: boolean };
  map: { id: string; displayName: string; registryVersion: string; calibration: string };
  sourceType: "gotv" | "pov";
  povPlayerId: string | null;
  tickRate: number;
  tickIntervalMs: number;
  sampleEveryTicks: number;
  teams: Record<TeamKey, TeamIdentity>;
  players: PlayerInfo[];
  timing: {
    freezeTimeS: number | null;
    roundTimeS: number | null;
    bombTimerS: number | null;
    source: "convars" | "defaults";
    maxRounds: number;
    overtimeMaxRounds: number;
  };
  capabilities: Capabilities;
  series: { id: string; mapIndex: number } | null;
  finalScore: Record<TeamKey, number>;
  rounds: RoundSummary[];
  excludedRounds: { reason: string; startTick: number; endTick: number | null }[];
  warnings: string[];
}

/** Columnar per-player samples. Arrays are parallel and ordered by tick. */
export interface PlayerTrack {
  playerId: string;
  t: number[];
  x: number[];
  y: number[];
  z: number[];
  yaw: number[];
  alive: number[];
  hp: number[] | null;
  armor: number[] | null;
  money: number[] | null;
  /** Index into RoundPayload.weapons, -1 for none. */
  weapon: number[] | null;
  /**
   * Active-weapon ammo; -1 when not applicable (melee, grenades, bomb) or unknown. Absent on older replays.
   * `clip` is recorded. `reserve` is the weapon entity's recorded m_pReserveAmmo[0] (the value the reference shows),
   * present only when the worker runs with WORKER_RECORDED_RESERVE=1.
   */
  clip?: number[] | null;
  reserve?: number[] | null;
  /** Bit flags: 1 bomb, 2 defuser, 4 helmet, 8 defusing, 16 planting, 32 scoped, 64 blinded. */
  flags: number[];
  /** Floor index into the map registry floors. */
  floor: number[];
  /** 1 when the sample must not be interpolated from the previous one. */
  disc: number[];
}

export type EventType =
  | "freeze_end"
  | "kill"
  | "bomb_plant_begin"
  | "bomb_plant"
  | "bomb_defuse_begin"
  | "bomb_defuse"
  | "bomb_explode"
  | "bomb_drop"
  | "bomb_pickup"
  | "grenade_throw"
  | "grenade_detonate"
  | "smoke_disrupted"
  | "round_end"
  | "disconnect"
  | "reconnect";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface GameEvent {
  id: string;
  tick: number;
  /** Deterministic order within the tick. */
  order: number;
  type: EventType;
  actor?: string | null;
  target?: string | null;
  assister?: string | null;
  weapon?: string | null;
  headshot?: boolean;
  wallbang?: boolean;
  throughSmoke?: boolean;
  noscope?: boolean;
  attackerBlind?: boolean;
  position?: Vec3 | null;
  actorPosition?: Vec3 | null;
  site?: string | null;
  grenadeId?: string | null;
  reason?: string | null;
  provenance: "recorded" | "inferred";
}

export type BombState = "carried" | "dropped" | "planting" | "planted" | "defusing" | "defused" | "exploded" | "unknown";

export interface BombTransition {
  tick: number;
  state: BombState;
  carrier: string | null;
  /** Omitted (null) when the source does not record an exact location. */
  position: Vec3 | null;
  site: string | null;
  provenance: "recorded" | "inferred";
}

export type GrenadeType = "smoke" | "flash" | "he" | "molotov" | "incendiary" | "decoy";

export interface Grenade {
  id: string;
  type: GrenadeType;
  throwerId: string | null;
  throwTick: number;
  detonateTick: number | null;
  /** [tick, x, y, z] in order. Empty when only detonation was observed (no invented path). */
  path: [number, number, number, number][];
  detonation: Vec3 | null;
}

export interface Effect {
  id: string;
  kind: "smoke" | "fire" | "flash" | "he" | "decoy";
  grenadeId: string | null;
  throwerId: string | null;
  startTick: number;
  /** Exclusive. Null when the end was not recorded (effect lasts to round end). */
  endTick: number | null;
  position: Vec3;
  radius: number;
  radiusSource: "configured-estimate" | "recorded";
  disruptions: { startTick: number; endTick: number; position: Vec3; radius: number; provenance: "inferred" | "recorded" }[];
}

export interface InventoryChange {
  tick: number;
  playerId: string;
  items: string[];
}

export interface RoundPayload {
  schemaVersion: typeof SCHEMA_VERSION;
  roundId: string;
  startTick: number;
  endTick: number;
  sampleEveryTicks: number;
  weapons: string[];
  tracks: PlayerTrack[];
  events: GameEvent[];
  bomb: BombTransition[];
  grenades: Grenade[];
  effects: Effect[];
  inventory: InventoryChange[];
}

export function tickToRoundMs(tick: number, round: { startTick: number }, tickIntervalMs: number): number {
  return Math.round((tick - round.startTick) * tickIntervalMs);
}

export function roundMsToTick(ms: number, round: { startTick: number; endTick: number }, tickIntervalMs: number): number {
  const t = round.startTick + Math.round(ms / tickIntervalMs);
  return Math.min(Math.max(t, round.startTick), round.endTick - 1);
}
