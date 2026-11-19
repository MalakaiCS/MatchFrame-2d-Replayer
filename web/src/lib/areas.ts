/**
 * Map areas (CS2 callouts) for anti-stratting:
 * - Callouts: every position sample's callout ("Apartments", "BombsiteB"), and a lookup for any spot
 *   (grenade landings, kills, plants) from the samples around it. Replays processed before callouts
 *   were recorded fall back to coarse labels ("A site", "near B", ...).
 * - findDefaults: the opponent's default setups and T-side round structure.
 * - yourAreas: where each of your players usually plays (from your own demos).
 * - areaReport: everything the opponent does in one player's area, for that player's report.
 */
import type { Side } from "@/shared/contract";
import { type Example, ex, fmt, labeller, SITE_RADIUS, siteCentres, type TeamDemo } from "./patterns";

const CELL = 128;

const SPECIAL: Record<string, string> = {
  CTSpawn: "CT spawn", TSpawn: "T spawn", TopofMid: "Top of mid", BombsiteA: "A site", BombsiteB: "B site",
  BombsiteC: "C site", SnipersNest: "Sniper's nest", BackofA: "Back of A", BackofB: "Back of B",
};
/** "PalaceInterior" -> "Palace interior". Labels that already read as words are kept. */
export function prettyPlace(p: string): string {
  if (SPECIAL[p]) return SPECIAL[p];
  if (p.includes(" ")) return p;
  const s = p.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z])of([A-Z ])/g, "$1 of$2");
  return s.charAt(0) + s.slice(1).toLowerCase();
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const pct = (n: number, of: number) => (of ? Math.round((100 * n) / of) : 0);

/** Callout lookup across a set of demos. */
export class Callouts {
  private grid = new Map<string, { z: number; c: string }[]>();
  readonly centres = new Map<string, { x: number; y: number; z: number; n: number }>();
  readonly sites: Record<string, { x: number; y: number; z: number }>;
  private fallback: (x: number, y: number) => string;
  /** Per demo: for each `${round}:${player}`, sample indices in time order. */
  private tl = new Map<TeamDemo, Map<string, number[]>>();

  constructor(demos: TeamDemo[]) {
    this.sites = siteCentres(demos);
    this.fallback = labeller(this.sites);
    for (const d of demos) {
      const P = d.ins.pos;
      const idx = new Map<string, number[]>();
      for (let i = 0; i < P.r.length; i++) {
        const k = `${P.r[i]}:${P.p[i]}`;
        (idx.get(k) ?? idx.set(k, []).get(k)!).push(i);
        const ci = P.c?.[i] ?? -1;
        if (ci < 0) continue;
        const c = d.ins.places?.[ci];
        if (!c) continue;
        const g = `${Math.floor(P.x[i] / CELL)}:${Math.floor(P.y[i] / CELL)}`;
        const cell = this.grid.get(g) ?? this.grid.set(g, []).get(g)!;
        if (cell.length < 40) cell.push({ z: P.z[i], c });
        const ce = this.centres.get(c) ?? this.centres.set(c, { x: 0, y: 0, z: 0, n: 0 }).get(c)!;
        ce.n += 1; ce.x += (P.x[i] - ce.x) / ce.n; ce.y += (P.y[i] - ce.y) / ce.n; ce.z += (P.z[i] - ce.z) / ce.n;
      }
      this.tl.set(d, idx);
    }
  }

  /** True when these demos carry real callouts (processed with callouts recorded). */
  get real() { return this.centres.size > 0; }

  /** Callout of a position sample. */
  ofSample(d: TeamDemo, i: number): string {
    const ci = d.ins.pos.c?.[i] ?? -1;
    const c = ci >= 0 ? d.ins.places?.[ci] : undefined;
    return c ?? this.locate(d.ins.pos.x[i], d.ins.pos.y[i], d.ins.pos.z[i]);
  }

  /** Callout for any spot: majority of nearby samples on the same level. */
  locate(x: number, y: number, z: number): string {
    if (this.grid.size) {
      const gx = Math.floor(x / CELL);
      const gy = Math.floor(y / CELL);
      for (let ring = 0; ring <= 4; ring++) {
        const votes = new Map<string, number>();
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            for (const s of this.grid.get(`${gx + dx}:${gy + dy}`) ?? []) if (Math.abs(s.z - z) <= 180) votes.set(s.c, (votes.get(s.c) ?? 0) + 1);
          }
        }
        if (votes.size) return [...votes].sort((a, b) => b[1] - a[1])[0][0];
      }
    }
    return this.fallback(x, y);
  }

  /** Samples of one player in one round, in time order. */
  track(d: TeamDemo, ri: number, pi: number): number[] {
    return this.tl.get(d)?.get(`${ri}:${pi}`) ?? [];
  }

  /** Callout of a player at about `secs` after freeze end (null if dead / no sample). */
  at(d: TeamDemo, ri: number, pi: number, secs: number): string | null {
    for (const i of this.track(d, ri, pi)) if (Math.abs(d.ins.pos.s[i] - secs) <= 1) return this.ofSample(d, i);
    return null;
  }

  /** Nearest bomb site to a callout and how far its centre is from it. */
  siteOf(c: string): { site: string; dist: number } | null {
    const m = /^Bombsite([A-Z])$/.exec(c);
    if (m) return { site: m[1], dist: 0 };
    const ce = this.centres.get(c);
    if (!ce) {
      const f = /^(?:near )?([A-Z]) site$|^near ([A-Z])$/.exec(c);
      return f ? { site: f[1] ?? f[2], dist: c.startsWith("near") ? SITE_RADIUS : 0 } : null;
    }
    let best: { site: string; dist: number } | null = null;
    for (const [k, s] of Object.entries(this.sites)) {
      const dd = Math.hypot(s.x - ce.x, s.y - ce.y);
      if (!best || dd < best.dist) best = { site: k, dist: dd };
    }
    return best;
  }

  /** A readable role for an area, from its main callout. */
  roleFor(area: string[], side: Side): string {
    const main = area[0];
    if (!main) return "Flex";
    const s = this.siteOf(main);
    if (s && s.dist < SITE_RADIUS * 0.6) return side === "CT" ? `${s.site} anchor` : `${s.site} site player`;
    if (s && s.dist < SITE_RADIUS * 1.6) return `${s.site} side (${prettyPlace(main)})`;
    return `${prettyPlace(main)}${side === "CT" ? " / rotator" : ""}`;
  }
}

const opp = (d: TeamDemo) => d.ins.players.map((p, i) => (p.team === d.side ? i : -1)).filter((i) => i >= 0);
const keyOf = (d: TeamDemo, pi: number) => d.ins.players[pi].steamId ?? d.ins.players[pi].id;
const gunRound = (d: TeamDemo, ri: number) => {
  const r = d.ins.rounds[ri];
  const b = r.buy?.[d.side];
  return !r.pistol && (b === "full_buy" || b === "half_buy" || b === null);
};

function topShares(list: string[], k = 2) {
  const n = new Map<string, number>();
  for (const c of list) n.set(c, (n.get(c) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).slice(0, k).map(([c, v]) => ({ c, share: v / Math.max(1, list.length) }));
}

// ---------------------------------------------------------------- defaults

export interface DefaultPlayer {
  key: string; name: string; role: string;
  checkpoints: { s: number; top: { c: string; share: number }[] }[];
}
export interface DefaultsSide {
  rounds: number;
  players: DefaultPlayer[];
  /** Average opponent players per callout at the middle checkpoint. */
  spread: { c: string; avg: number }[];
  notes: string[];
  examples: Example[];
}
export interface Defaults { T: DefaultsSide; CT: DefaultsSide; callouts: boolean }

const CHECK: Record<Side, number[]> = { T: [15, 30, 45], CT: [10, 20, 35] };

export function findDefaults(demos: TeamDemo[], co: Callouts): Defaults {
  const out = {} as Defaults;
  out.callouts = co.real;
  for (const side of ["T", "CT"] as const) {
    const rounds: { d: TeamDemo; ri: number }[] = [];
    for (const d of demos) d.ins.rounds.forEach((r, ri) => { if (r.sides[d.side] === side && gunRound(d, ri)) rounds.push({ d, ri }); });
    const per = new Map<string, { name: string; at: Map<number, string[]> }>();
    const spread = new Map<string, number>();
    const mid = CHECK[side][1];
    for (const { d, ri } of rounds) {
      for (const pi of opp(d)) {
        const k = keyOf(d, pi);
        const e = per.get(k) ?? { name: d.ins.players[pi].name, at: new Map() };
        for (const s of CHECK[side]) {
          const c = co.at(d, ri, pi, s);
          if (c) (e.at.get(s) ?? e.at.set(s, []).get(s)!).push(c);
          if (c && s === mid) spread.set(c, (spread.get(c) ?? 0) + 1);
        }
        per.set(k, e);
      }
    }
    const roles = side === "T" ? tRoles(demos, co) : new Map<string, string>();
    const players: DefaultPlayer[] = [...per].map(([key, e]) => {
      const first = topShares(e.at.get(CHECK[side][side === "CT" ? 1 : 0]) ?? [], 1)[0];
      return {
        key, name: e.name,
        role: roles.get(key) ?? (first ? co.roleFor([first.c], side) : "—"),
        checkpoints: CHECK[side].map((s) => ({ s, top: topShares(e.at.get(s) ?? []) })),
      };
    }).filter((p) => p.checkpoints.some((c) => c.top.length));
    players.sort((a, b) => (a.checkpoints[1].top[0]?.c ?? "").localeCompare(b.checkpoints[1].top[0]?.c ?? ""));
    const notes: string[] = [];
    if (side === "T") notes.push(...tStructure(demos, co));
    else {
      for (const p of players) {
        const t = p.checkpoints[1].top[0];
        if (t && t.share >= 0.6) notes.push(`${p.name} holds ${prettyPlace(t.c)} in ${Math.round(t.share * 100)}% of gun rounds.`);
      }
    }
    out[side] = {
      rounds: rounds.length, players,
      spread: [...spread].map(([c, n]) => ({ c, avg: Math.round((10 * n) / Math.max(1, rounds.length)) / 10 })).sort((a, b) => b.avg - a.avg).slice(0, 8),
      notes, examples: rounds.slice(0, 8).map(({ d, ri }) => ex(d, ri)),
    };
  }
  return out;
}

/** T-side roles from behaviour: entry (first onto the planted site), lurker (far from the plant), support (most flashes). */
function tRoles(demos: TeamDemo[], co: Callouts): Map<string, string> {
  const entry = new Map<string, number>();
  const lurk = new Map<string, number>();
  const flash = new Map<string, number>();
  const awp = new Map<string, number>();
  for (const d of demos) {
    d.ins.rounds.forEach((r, ri) => {
      if (r.sides[d.side] !== "T") return;
      for (const k of d.ins.kills) if (k.r === ri && k.k >= 0 && d.ins.players[k.k]?.team === d.side && (k.w ?? "").includes("awp")) awp.set(keyOf(d, k.k), (awp.get(keyOf(d, k.k)) ?? 0) + 1);
      for (const g of d.ins.nades) if (g.r === ri && g.type === "flash" && d.ins.players[g.p]?.team === d.side) flash.set(keyOf(d, g.p), (flash.get(keyOf(d, g.p)) ?? 0) + 1);
      if (!r.plant) return;
      let first: { k: string; s: number } | null = null;
      for (const pi of opp(d)) {
        for (const i of co.track(d, ri, pi)) {
          const P = d.ins.pos;
          if (P.s[i] > r.plant.s) break;
          if (Math.hypot(P.x[i] - r.plant.x, P.y[i] - r.plant.y) < SITE_RADIUS * 0.6) {
            if (!first || P.s[i] < first.s) first = { k: keyOf(d, pi), s: P.s[i] };
            break;
          }
        }
        // Far from the plant when it happens: lurking.
        const near = co.track(d, ri, pi).find((i) => Math.abs(d.ins.pos.s[i] - r.plant!.s) <= 1);
        if (near !== undefined && Math.hypot(d.ins.pos.x[near] - r.plant.x, d.ins.pos.y[near] - r.plant.y) > SITE_RADIUS * 1.8) lurk.set(keyOf(d, pi), (lurk.get(keyOf(d, pi)) ?? 0) + 1);
      }
      if (first) entry.set(first.k, (entry.get(first.k) ?? 0) + 1);
    });
  }
  const roles = new Map<string, string>();
  const give = (m: Map<string, number>, label: string, min: number) => {
    const top = [...m].sort((a, b) => b[1] - a[1]).find(([k, n]) => n >= min && !roles.has(k));
    if (top) roles.set(top[0], label);
  };
  give(awp, "AWPer", 3);
  give(entry, "Entry", 2);
  give(lurk, "Lurker", 2);
  give(flash, "Support", 3);
  return roles;
}

/** How T rounds unfold: rushes vs defaults, which site after a default, and when. */
function tStructure(demos: TeamDemo[], co: Callouts): string[] {
  let rounds = 0;
  const rush = new Map<string, number>();
  const hit = new Map<string, number>();
  const hitS: number[] = [];
  let defaults = 0;
  for (const d of demos) {
    d.ins.rounds.forEach((r, ri) => {
      if (r.sides[d.side] !== "T" || !gunRound(d, ri)) return;
      rounds += 1;
      // 3+ players near one site by 0:25 = a rush / fast hit.
      let rushed: string | null = null;
      for (const [site, c] of Object.entries(co.sites)) {
        const n = opp(d).filter((pi) => co.track(d, ri, pi).some((i) => d.ins.pos.s[i] <= 25 && Math.hypot(d.ins.pos.x[i] - c.x, d.ins.pos.y[i] - c.y) < SITE_RADIUS * 1.2)).length;
        if (n >= 3) { rushed = site; break; }
      }
      if (rushed) { rush.set(rushed, (rush.get(rushed) ?? 0) + 1); return; }
      defaults += 1;
      if (r.plant?.site) { hit.set(r.plant.site.toUpperCase(), (hit.get(r.plant.site.toUpperCase()) ?? 0) + 1); hitS.push(r.plant.s); }
    });
  }
  if (!rounds) return [];
  const notes: string[] = [];
  const rushN = [...rush.values()].reduce((a, b) => a + b, 0);
  notes.push(`Gun rounds: ${defaults} of ${rounds} start with a default (${pct(defaults, rounds)}%), ${rushN} are fast hits${rushN ? ` (${[...rush].map(([s, n]) => `${n}× ${s}`).join(", ")})` : ""}.`);
  const planted = [...hit.values()].reduce((a, b) => a + b, 0);
  if (planted) {
    const m = median(hitS);
    notes.push(`After a default they plant ${[...hit].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${pct(n, planted)}%`).join(", ")}${m !== null ? `, typically at ${fmt(m)}` : ""}.`);
  }
  if (defaults - planted > 0) notes.push(`${defaults - planted} default rounds end without a plant (picks, saves or lost fights).`);
  return notes;
}

// ---------------------------------------------------------------- your players' areas

export interface YourPlayer { key: string; name: string; CT: { area: string[]; role: string; share: number }; T: { area: string[]; role: string; share: number } }

/**
 * Where each of your players plays, covering ~70% of their rounds. CT: their callout at 0:15 (the spot
 * they hold). T: where they take their first fight (the area they attack), or their 0:20 spot when
 * they have too few fights.
 */
export function yourAreas(demos: TeamDemo[], co: Callouts): YourPlayer[] {
  const per = new Map<string, { name: string; CT: string[]; T: string[]; Tpos: string[] }>();
  for (const d of demos) {
    d.ins.rounds.forEach((r, ri) => {
      if (!gunRound(d, ri)) return;
      const side = r.sides[d.side];
      for (const pi of opp(d)) {
        const k = keyOf(d, pi);
        const e = per.get(k) ?? { name: d.ins.players[pi].name, CT: [], T: [], Tpos: [] };
        per.set(k, e);
        const c = co.at(d, ri, pi, side === "CT" ? 15 : 20);
        if (side === "CT") { if (c) e.CT.push(c); continue; }
        if (c) e.Tpos.push(c);
        const duel = d.ins.kills.filter((x) => x.r === ri && (x.k === pi || x.v === pi)).sort((a, b) => a.s - b.s)[0];
        if (duel) e.T.push(duel.k === pi && duel.kx !== null ? co.locate(duel.kx, duel.ky!, duel.kz!) : co.locate(duel.vx, duel.vy, duel.vz));
      }
    });
  }
  for (const e of per.values()) if (e.T.length < 3) e.T = e.Tpos;
  const area = (list: string[], side: Side) => {
    const top = topShares(list, 5);
    const out: string[] = [];
    let cover = 0;
    for (const t of top) { if (cover >= 0.7 || out.length >= 3) break; out.push(t.c); cover += t.share; }
    const role = co.roleFor(out, side);
    // A site anchor's report covers the whole site, not just the corner they hold.
    const site = side === "CT" && out[0] ? co.siteOf(out[0]) : null;
    if (site && site.dist < SITE_RADIUS * 0.6 && co.centres.has(`Bombsite${site.site}`) && !out.includes(`Bombsite${site.site}`)) out.push(`Bombsite${site.site}`);
    return { area: out, role, share: Math.round(cover * 100) / 100 };
  };
  return [...per].filter(([, e]) => e.CT.length + e.T.length >= 3)
    .map(([key, e]) => ({ key, name: e.name, CT: area(e.CT, "CT"), T: area(e.T, "T") }))
    .sort((a, b) => a.CT.role.localeCompare(b.CT.role));
}

// ---------------------------------------------------------------- area report

export interface ReportLine { text: string; share?: number; n?: number; of?: number }
export interface ReportSection { title: string; lines: ReportLine[] }
export interface MapMark { x: number; y: number; z: number; kind: "area" | "enemy" | "smoke" | "flash" | "molotov" | "he" | "kill" | "death" }
export interface AreaReport {
  side: Side; area: string[]; rounds: number;
  headline: string;
  sections: ReportSection[];
  tips: string[];
  marks: MapMark[];
  examples: Example[];
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const WEAPONS: Record<string, string> = {
  ak47: "AK-47", m4a1: "M4A4", m4a4: "M4A4", m4a1_silencer: "M4A1-S", awp: "AWP", deagle: "Deagle", galilar: "Galil", famas: "FAMAS",
  sg556: "SG 553", aug: "AUG", ssg08: "Scout", usp_silencer: "USP-S", glock: "Glock", hkp2000: "P2000", p250: "P250", tec9: "Tec-9",
  fiveseven: "Five-SeveN", cz75a: "CZ75", mac10: "MAC-10", mp9: "MP9", mp7: "MP7", ump45: "UMP-45", p90: "P90", elite: "Dualies",
  hegrenade: "HE grenade", inferno: "molotov", knife: "knife",
};
const weaponName = (w: string) => WEAPONS[w.toLowerCase()] ?? w.replace(/_/g, " ").toUpperCase();

const line = (text: string, n?: number, of?: number): ReportLine => (n !== undefined && of ? { text, n, of, share: n / of } : { text });

/**
 * Everything the opponent does in one area. `side` is YOUR side in that half: on CT you defend the
 * area against their T side; on T you attack it against their CT side.
 */
export function areaReport(demos: TeamDemo[], co: Callouts, areaList: string[], side: Side): AreaReport {
  const area = new Set(areaList);
  const inArea = (c: string | null) => !!c && area.has(c);
  const theirSide: Side = side === "CT" ? "T" : "CT";
  const rounds: { d: TeamDemo; ri: number }[] = [];
  for (const d of demos) d.ins.rounds.forEach((r, ri) => { if (r.sides[d.side] === theirSide) rounds.push({ d, ri }); });
  const N = rounds.length;
  const label = areaList.map(prettyPlace).join(" / ") || "this area";
  const marks: MapMark[] = [];
  const examples: Example[] = [];
  const sections: ReportSection[] = [];
  const tips: string[] = [];

  // Your area itself (for the map).
  for (const d of demos) {
    const P = d.ins.pos;
    for (let i = 0; i < P.r.length && marks.length < 400; i += 7) if (inArea(co.ofSample(d, i))) marks.push({ x: P.x[i], y: P.y[i], z: P.z[i], kind: "area" });
  }

  // Utility of theirs landing in the area.
  const util = new Map<string, { rounds: Set<string>; s: number[]; by: Map<string, number>; from: Map<string, number> }>();
  // Fights in the area.
  let theirKills = 0, theirDeaths = 0, firstFights = 0, firstWon = 0;
  const killers = new Map<string, number>();
  const killWeapons = new Map<string, number>();
  const contactS: number[] = [];

  if (side === "CT") {
    // ---- You defend; they attack.
    let visited = 0, hits = 0, fakes = 0, planted = 0, retakeLost = 0;
    const entryS: number[] = [];
    const hitS: number[] = [];
    const approach = new Map<string, number>();
    const who = new Map<string, { name: string; n: number; s: number[] }>();
    const peak: number[] = [];
    const post = new Map<string, number>();
    for (const { d, ri } of rounds) {
      const r = d.ins.rounds[ri];
      let first: number | null = null;
      const occupancy = new Map<number, number>();
      for (const pi of opp(d)) {
        const tr = co.track(d, ri, pi);
        let prev: string | null = null;
        let entered = false;
        for (const i of tr) {
          const s = d.ins.pos.s[i];
          if (s > r.length) break;
          const c = co.ofSample(d, i);
          if (inArea(c)) {
            occupancy.set(s, (occupancy.get(s) ?? 0) + 1);
            if (!entered) {
              entered = true;
              if (first === null || s < first) first = s;
              if (prev) approach.set(prev, (approach.get(prev) ?? 0) + 1);
              const k = keyOf(d, pi);
              const w = who.get(k) ?? { name: d.ins.players[pi].name, n: 0, s: [] };
              w.n += 1; w.s.push(s); who.set(k, w);
              if (s <= 30 && marks.length < 900) marks.push({ x: d.ins.pos.x[i], y: d.ins.pos.y[i], z: d.ins.pos.z[i], kind: "enemy" });
            }
          } else prev = c;
        }
      }
      const maxIn = Math.max(0, ...occupancy.values());
      peak.push(maxIn);
      if (first !== null) { visited += 1; entryS.push(first); }
      const plantHere = !!r.plant && inArea(co.locate(r.plant.x, r.plant.y, r.plant.z));
      const executed = plantHere || maxIn >= 3;
      if (executed) {
        hits += 1;
        if (examples.length < 8) examples.push(ex(d, ri, Math.max(0, (first ?? 0) - 5)));
        const hs = plantHere ? r.plant!.s : [...occupancy].filter(([, n]) => n >= 3).map(([s]) => s).sort((a, b) => a - b)[0];
        if (hs !== undefined) hitS.push(hs);
      }
      // Pressure here (utility or 2+ players) but the plant went elsewhere.
      const utilHere = d.ins.nades.filter((g) => g.r === ri && d.ins.players[g.p]?.team === d.side && inArea(co.locate(g.lx, g.ly, g.lz))).length;
      if (!plantHere && r.plant && (utilHere >= 2 || maxIn >= 2)) fakes += 1;
      if (plantHere) {
        planted += 1;
        if (r.winner === d.side) retakeLost += 1;
        for (const pi of opp(d)) {
          const c = co.at(d, ri, pi, r.plant!.s + 10);
          if (c) post.set(c, (post.get(c) ?? 0) + 1);
        }
      }
    }
    const me = median(entryS);
    const mh = median(hitS);
    sections.push({
      title: "How often they come to you",
      lines: [
        line(`They reach ${label} in ${pct(visited, N)}% of their T rounds${me !== null ? `, first player usually at ${fmt(me)}` : ""}.`, visited, N),
        line(`Full hit on your area (plant here or 3+ players at once) in ${pct(hits, N)}% of rounds${mh !== null ? `, usually around ${fmt(mh)}` : ""}.`, hits, N),
        ...(fakes ? [line(`Fake pressure: ${plural(fakes, "round")} with utility or 2+ players here before planting elsewhere.`, fakes, N)] : []),
        line(`Most players here at once: ${peak.length ? `${median(peak)} typically, ${Math.max(...peak)} at most` : "—"}.`),
      ],
    });
    const app = [...approach].sort((a, b) => b[1] - a[1]);
    const appTotal = app.reduce((a, [, n]) => a + n, 0);
    if (app.length) {
      sections.push({ title: "Where they come from", lines: app.slice(0, 5).map(([c, n]) => line(`Through ${prettyPlace(c)}: ${pct(n, appTotal)}% of entries.`, n, appTotal)) });
    }
    const whoList = [...who.values()].sort((a, b) => b.n - a.n);
    if (whoList.length) {
      sections.push({
        title: "Who comes to your area",
        lines: whoList.slice(0, 5).map((w) => line(`${w.name}: in ${pct(w.n, N)}% of rounds, usually by ${fmt(median(w.s) ?? 0)}.`, w.n, N)),
      });
    }
    if (planted) {
      const pp = [...post].sort((a, b) => b[1] - a[1]);
      const tot = pp.reduce((a, [, n]) => a + n, 0);
      sections.push({
        title: "After they plant here",
        lines: [
          line(`They planted in your area ${plural(planted, "time")} and won ${pct(retakeLost, planted)}% of those rounds.`, retakeLost, planted),
          ...pp.slice(0, 4).map(([c, n]) => line(`Post-plant: ${pct(n, tot)}% of players play from ${prettyPlace(c)}.`, n, tot)),
        ],
      });
    }
    // Tips
    if (hits / Math.max(1, N) >= 0.4) tips.push(`They hit your area a lot (${pct(hits, N)}%). Ask for an early rotator and save utility for the hit${mh !== null ? ` around ${fmt(mh)}` : ""}.`);
    else if (visited / Math.max(1, N) < 0.3) tips.push(`They rarely come to ${label}. You can play for information and rotate early when they show elsewhere.`);
    if (app[0] && appTotal >= 3) tips.push(`Most entries come through ${prettyPlace(app[0][0])} (${pct(app[0][1], appTotal)}%). Molly or flash that path at ${me !== null ? fmt(Math.max(0, me - 5)) : "the usual time"}.`);
    if (whoList[0] && whoList[0].n >= 3) tips.push(`${whoList[0].name} is the one who comes to you most. Know their timing: ${fmt(median(whoList[0].s) ?? 0)}.`);
    if (fakes >= 2) tips.push(`They fake your area (${fakes} times). Don't call a full rotate on utility alone; wait for bodies.`);
  } else {
    // ---- You attack; they defend.
    const count15: number[] = [];
    const defenders = new Map<string, { name: string; n: number; spots: string[] }>();
    let stacks = 0, retakes = 0, retakeWon = 0, early = 0;
    const earlyBy = new Map<string, number>();
    for (const { d, ri } of rounds) {
      const r = d.ins.rounds[ri];
      let n = 0;
      for (const pi of opp(d)) {
        const c = co.at(d, ri, pi, 15);
        if (inArea(c)) {
          n += 1;
          const k = keyOf(d, pi);
          const e = defenders.get(k) ?? { name: d.ins.players[pi].name, n: 0, spots: [] };
          e.n += 1; e.spots.push(c!); defenders.set(k, e);
          const i = co.track(d, ri, pi).find((j) => Math.abs(d.ins.pos.s[j] - 15) <= 1);
          if (i !== undefined && marks.length < 900) marks.push({ x: d.ins.pos.x[i], y: d.ins.pos.y[i], z: d.ins.pos.z[i], kind: "enemy" });
        }
      }
      count15.push(n);
      const n20 = opp(d).filter((pi) => inArea(co.at(d, ri, pi, 20))).length;
      if (n20 >= 3) stacks += 1;
      // Their early aggression in or from your area (kills by them before 0:25).
      const ek = d.ins.kills.filter((k) => k.r === ri && k.s <= 25 && k.k >= 0 && d.ins.players[k.k]?.team === d.side
        && (inArea(co.locate(k.vx, k.vy, k.vz)) || (k.kx !== null && inArea(co.locate(k.kx, k.ky!, k.kz!)))));
      if (ek.length) { early += 1; for (const k of ek) earlyBy.set(d.ins.players[k.k].name, (earlyBy.get(d.ins.players[k.k].name) ?? 0) + 1); }
      // Plants by the other team in this area: how they retake.
      if (r.plant && inArea(co.locate(r.plant.x, r.plant.y, r.plant.z))) {
        retakes += 1;
        if (r.winner === d.side) retakeWon += 1;
        if (examples.length < 8) examples.push(ex(d, ri, Math.max(0, r.plant.s - 8)));
      }
    }
    const dist = new Map<number, number>();
    for (const n of count15) dist.set(Math.min(3, n), (dist.get(Math.min(3, n)) ?? 0) + 1);
    sections.push({
      title: `How they hold ${label}`,
      lines: [0, 1, 2, 3].filter((k) => dist.get(k)).map((k) => line(`${k === 3 ? "3 or more" : k} defender${k === 1 ? "" : "s"} at 0:15 in ${pct(dist.get(k)!, N)}% of rounds.`, dist.get(k)!, N)),
    });
    const defs = [...defenders.values()].sort((a, b) => b.n - a.n);
    if (defs.length) {
      sections.push({
        title: "Who defends it and where",
        lines: defs.slice(0, 4).map((e) => {
          const t = topShares(e.spots, 2).map((x) => `${prettyPlace(x.c)} ${Math.round(x.share * 100)}%`).join(", ");
          return line(`${e.name}: here in ${pct(e.n, N)}% of rounds (${t}).`, e.n, N);
        }),
      });
    }
    sections.push({
      title: "Stacks, aggression and retakes",
      lines: [
        line(`Stack (3+ here at 0:20) in ${pct(stacks, N)}% of rounds.`, stacks, N),
        line(`Early kills by them in or from this area (before 0:25) in ${pct(early, N)}% of rounds${earlyBy.size ? `, mostly ${[...earlyBy].sort((a, b) => b[1] - a[1])[0][0]}` : ""}.`, early, N),
        ...(retakes ? [line(`When their opponents planted here they won the retake ${retakeWon} of ${retakes} times.`, retakeWon, retakes)] : []),
      ],
    });
    const main = defs[0];
    if (main && main.n / Math.max(1, N) >= 0.5) tips.push(`${main.name} is the usual defender (${pct(main.n, N)}%), mostly at ${prettyPlace(topShares(main.spots, 1)[0].c)}. Pre-aim and flash that spot.`);
    if ((dist.get(1) ?? 0) / Math.max(1, N) >= 0.5) tips.push(`Usually only one player holds ${label}. A fast, flashed 2-man take wins it before help arrives.`);
    if (stacks / Math.max(1, N) >= 0.25) tips.push(`They stack here ${pct(stacks, N)}% of the time. Check with utility before committing; punish a stack by hitting the other site.`);
    if (early / Math.max(1, N) >= 0.25) tips.push(`They take early fights here. Don't walk in dry in the first 25 seconds; hold a crossfire or use utility first.`);
  }

  // Utility (both cases: theirs landing in your area).
  for (const { d, ri } of rounds) {
    for (const g of d.ins.nades) {
      if (g.r !== ri || g.type === "decoy" || d.ins.players[g.p]?.team !== d.side) continue;
      if (!inArea(co.locate(g.lx, g.ly, g.lz))) continue;
      const t = g.type === "incendiary" ? "molotov" : g.type;
      const u = util.get(t) ?? util.set(t, { rounds: new Set(), s: [], by: new Map(), from: new Map() }).get(t)!;
      u.rounds.add(`${d.replayId}:${ri}`); u.s.push(g.s);
      u.by.set(d.ins.players[g.p].name, (u.by.get(d.ins.players[g.p].name) ?? 0) + 1);
      const from = co.locate(g.ox, g.oy, g.oz);
      u.from.set(from, (u.from.get(from) ?? 0) + 1);
      if (marks.length < 1300) marks.push({ x: g.lx, y: g.ly, z: g.lz, kind: t as MapMark["kind"] });
    }
    // Fights in the area.
    const ks = d.ins.kills.filter((k) => k.r === ri && (inArea(co.locate(k.vx, k.vy, k.vz)) || (k.kx !== null && inArea(co.locate(k.kx, k.ky!, k.kz!)))))
      .sort((a, b) => a.s - b.s);
    if (ks.length) {
      firstFights += 1;
      contactS.push(ks[0].s);
      if (ks[0].k >= 0 && d.ins.players[ks[0].k]?.team === d.side) firstWon += 1;
    }
    for (const k of ks) {
      if (k.k >= 0 && d.ins.players[k.k]?.team === d.side) {
        theirKills += 1;
        killers.set(d.ins.players[k.k].name, (killers.get(d.ins.players[k.k].name) ?? 0) + 1);
        const w = (k.w ?? "?").replace(/^weapon_/, "");
        killWeapons.set(w, (killWeapons.get(w) ?? 0) + 1);
        if (k.kx !== null && marks.length < 1500) marks.push({ x: k.kx, y: k.ky!, z: k.kz!, kind: "kill" });
      } else if (d.ins.players[k.v]?.team === d.side) {
        theirDeaths += 1;
        if (marks.length < 1500) marks.push({ x: k.vx, y: k.vy, z: k.vz, kind: "death" });
      }
    }
  }
  const NAMES: Record<string, string> = { smoke: "Smokes", flash: "Flashes", molotov: "Molotovs", he: "HE grenades" };
  const utilLines = [...util].sort((a, b) => b[1].rounds.size - a[1].rounds.size).map(([t, u]) => {
    const by = [...u.by].sort((a, b) => b[1] - a[1])[0];
    const from = [...u.from].sort((a, b) => b[1] - a[1])[0];
    return line(`${NAMES[t] ?? t} into your area in ${pct(u.rounds.size, N)}% of rounds, usually at ${fmt(median(u.s) ?? 0)}${by ? `, mostly ${by[0]}` : ""}${from ? ` from ${prettyPlace(from[0])}` : ""}.`, u.rounds.size, N);
  });
  if (utilLines.length) sections.push({ title: "Their utility in your area", lines: utilLines });
  const topW = [...killWeapons].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([w]) => weaponName(w)).join(" and ");
  const topK = [...killers].sort((a, b) => b[1] - a[1])[0];
  const mc = median(contactS);
  sections.push({
    title: "Fights in your area",
    lines: [
      firstFights
        ? line(`First fight here: they win ${pct(firstWon, firstFights)}% (${plural(firstFights, "round")} with a fight${mc !== null ? `, first contact around ${fmt(mc)}` : ""}).`, firstWon, firstFights)
        : line("No fights here in these rounds."),
      line(`They got ${plural(theirKills, "kill")} and lost ${plural(theirDeaths, "player")} here.${topK ? ` Top fragger here: ${topK[0]} (${topK[1]}).` : ""}${topW ? ` Mostly with the ${topW}.` : ""}`),
    ],
  });
  const flashU = util.get("flash");
  if (side === "CT" && flashU && flashU.rounds.size / Math.max(1, N) >= 0.3) tips.push(`Expect flashes into your area at about ${fmt(median(flashU.s) ?? 0)}: turn away and re-peek, or fall back to a deeper spot.`);
  if (side === "T" && util.get("molotov") && util.get("molotov")!.rounds.size / Math.max(1, N) >= 0.3) tips.push(`They molly your approach at about ${fmt(median(util.get("molotov")!.s) ?? 0)}: wait it out or take the other path.`);
  if (firstFights >= 3 && firstWon / firstFights >= 0.6) tips.push(`They win most first fights here (${pct(firstWon, firstFights)}%). Don't take the first duel alone; trade with a teammate.`);
  if (firstFights >= 3 && firstWon / firstFights <= 0.35) tips.push(`They lose most first fights here (${pct(firstWon, firstFights)}%): taking the duel is good for you.`);

  const headline = side === "CT"
    ? `Defending ${label} against their T side (${N} rounds).`
    : `Attacking ${label} against their CT side (${N} rounds).`;
  return { side, area: areaList, rounds: N, headline, sections, tips, marks, examples };
}

/** Every callout seen in these demos, most used first (for area pickers). */
export function calloutList(co: Callouts): string[] {
  return [...co.centres].sort((a, b) => b[1].n - a[1].n).map(([c]) => c);
}

