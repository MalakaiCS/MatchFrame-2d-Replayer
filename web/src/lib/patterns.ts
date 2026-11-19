/**
 * Pattern finder for anti-stratting: scans a team's demos on one map and reports repeatable habits,
 * each with how often it happened (n of rounds), a confidence level, example rounds and, where it
 * applies, a map spot. Deterministic: the same demos always give the same patterns.
 *
 * Inputs are the per-replay insights (positions every 2 s, kills, grenades, plants) and round tags.
 */
import type { Side, TeamKey } from "@/shared/contract";
import type { Insights } from "./insights";
import { roundView, type RoundView } from "./roundTags";

export interface TeamDemo { replayId: string; side: TeamKey; ins: Insights; when: string; opponent: string }

export interface Spot { x: number; y: number; z: number; label: string }
export interface Example { replayId: string; roundId: string; roundNumber: number; ms: number }
export interface Pattern {
  id: string;
  category: "positions" | "setups" | "site" | "pace" | "openings" | "utility" | "awp" | "economy" | "aggression";
  side: Side | "both";
  player?: string;
  title: string;
  detail: string;
  /** Share of the relevant rounds (0..1), and the counts behind it. */
  share: number; n: number; of: number;
  confidence: "strong" | "moderate" | "weak";
  counter: string;
  spot?: Spot;
  examples: Example[];
}

const SITE_RADIUS = 900;
const ZONE = 420;

const pct = (n: number, of: number) => (of ? Math.round((100 * n) / of) : 0);
const confidence = (share: number, of: number): Pattern["confidence"] =>
  of >= 8 && share >= 0.7 ? "strong" : of >= 5 && share >= 0.5 ? "moderate" : "weak";
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** Bomb site centres from plant positions in these demos (both teams' plants). */
export function siteCentres(demos: TeamDemo[]): Record<string, { x: number; y: number; z: number }> {
  const acc: Record<string, { x: number; y: number; z: number; n: number }> = {};
  for (const d of demos) {
    for (const r of d.ins.rounds) {
      const p = r.plant;
      if (!p?.site) continue;
      const k = p.site.toUpperCase();
      const a = (acc[k] ??= { x: 0, y: 0, z: 0, n: 0 });
      a.x += p.x; a.y += p.y; a.z += p.z; a.n += 1;
    }
  }
  return Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, { x: a.x / a.n, y: a.y / a.n, z: a.z / a.n }]));
}

/** "on A site", "near B", "between the sites", "away from the sites". */
export const at = (label: string) => (label.endsWith(" site") ? `on ${label}` : label === "between sites" ? "between the sites" : label);

function labeller(sites: Record<string, { x: number; y: number }>) {
  return (x: number, y: number) => {
    let best: [string, number] | null = null;
    for (const [k, c] of Object.entries(sites)) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (!best || d < best[1]) best = [k, d];
    }
    if (best && best[1] <= SITE_RADIUS * 0.6) return `${best[0]} site`;
    if (best && best[1] <= SITE_RADIUS * 1.4) return `near ${best[0]}`;
    if (Object.keys(sites).length >= 2) {
      const [a, b] = Object.values(sites);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (Math.hypot(mid.x - x, mid.y - y) < SITE_RADIUS) return "between sites";
    }
    return "away from the sites";
  };
}

/** Group points into zones (grid cells), returning the most used zone and its mean position. */
function topZone(points: { x: number; y: number; z: number; ex: Example }[]) {
  const cells = new Map<string, typeof points>();
  for (const p of points) {
    const k = `${Math.round(p.x / ZONE)}:${Math.round(p.y / ZONE)}`;
    const list = cells.get(k) ?? [];
    list.push(p);
    cells.set(k, list);
  }
  // Merge each cell with its neighbours so a spot on a cell border is not split.
  let best: { pts: typeof points; key: string } | null = null;
  for (const [k] of cells) {
    const [cx, cy] = k.split(":").map(Number);
    const pts: typeof points = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) pts.push(...(cells.get(`${cx + dx}:${cy + dy}`) ?? []));
    // Keep only points close to this cell's centre.
    const centre = { x: cx * ZONE, y: cy * ZONE };
    const near = pts.filter((p) => Math.hypot(p.x - centre.x, p.y - centre.y) <= ZONE * 1.1);
    if (!best || near.length > best.pts.length) best = { pts: near, key: k };
  }
  if (!best || !best.pts.length) return null;
  const n = best.pts.length;
  const mean = best.pts.reduce((a, p) => ({ x: a.x + p.x / n, y: a.y + p.y / n, z: a.z + p.z / n }), { x: 0, y: 0, z: 0 });
  return { count: n, mean: { x: Math.round(mean.x), y: Math.round(mean.y), z: Math.round(mean.z) }, examples: best.pts.map((p) => p.ex) };
}

/** Positions of each player in each round at about `secs` after freeze end. */
function positionsAt(ins: Insights, secs: number) {
  const out = new Map<string, { x: number; y: number; z: number }>(); // `${round}:${player}`
  const P = ins.pos;
  for (let i = 0; i < P.r.length; i++) {
    if (Math.abs(P.s[i] - secs) > 1) continue;
    const k = `${P.r[i]}:${P.p[i]}`;
    if (!out.has(k)) out.set(k, { x: P.x[i], y: P.y[i], z: P.z[i] });
  }
  return out;
}

const ex = (d: TeamDemo, ri: number, secs = 0): Example => {
  const r = d.ins.rounds[ri];
  return { replayId: d.replayId, roundId: r.id, roundNumber: r.n, ms: Math.max(0, Math.round((r.freeze - r.startTick) * d.ins.tickMs + secs * 1000)) };
};

export interface PatternReport {
  demos: number; rounds: { T: number; CT: number };
  sites: string[];
  players: { key: string; name: string }[];
  patterns: Pattern[];
}

export function findPatterns(demos: TeamDemo[]): PatternReport {
  const sites = siteCentres(demos);
  const label = labeller(sites);
  const patterns: Pattern[] = [];
  const views: { d: TeamDemo; ri: number; v: RoundView }[] = [];
  for (const d of demos) for (let ri = 0; ri < d.ins.rounds.length; ri++) views.push({ d, ri, v: roundView(d.ins, ri, d.side) });
  const bySide = (s: Side) => views.filter((x) => x.v.side === s);
  const T = bySide("T");
  const CT = bySide("CT");

  // Player identities across demos (Steam id, else in-demo id).
  const names = new Map<string, string>();
  const keyOf = (d: TeamDemo, pi: number) => d.ins.players[pi].steamId ?? d.ins.players[pi].id;
  for (const d of demos) d.ins.players.forEach((p, i) => { if (p.team === d.side) names.set(keyOf(d, i), p.name); });

  // ---- 1. Where each player stands (CT at 0:15, T at 0:20)
  for (const [side, secs] of [["CT", 15], ["T", 20]] as const) {
    const pts = new Map<string, { x: number; y: number; z: number; ex: Example }[]>();
    const total = new Map<string, number>();
    for (const { d, ri, v } of bySide(side)) {
      const at = positionsAt(d.ins, secs);
      d.ins.players.forEach((p, pi) => {
        if (p.team !== d.side) return;
        const pos = at.get(`${ri}:${pi}`);
        if (!pos) return;
        const k = keyOf(d, pi);
        total.set(k, (total.get(k) ?? 0) + 1);
        (pts.get(k) ?? pts.set(k, []).get(k)!).push({ ...pos, ex: ex(d, ri, secs - 3) });
      });
      void v;
    }
    for (const [k, list] of pts) {
      const of = total.get(k) ?? 0;
      const z = topZone(list);
      if (!z || of < 3) continue;
      const share = z.count / of;
      if (share < 0.4) continue;
      const where = label(z.mean.x, z.mean.y);
      patterns.push({
        id: `pos-${side}-${k}`, category: "positions", side, player: names.get(k),
        title: where.endsWith(" site") || where.startsWith("near ")
          ? `${names.get(k)} is ${at(where)} at ${fmt(secs)} on ${side}`
          : `${names.get(k)} holds the same spot ${at(where)} at ${fmt(secs)} on ${side}`,
        detail: `${z.count} of ${of} ${side} rounds (${pct(z.count, of)}%). The spot is marked on the map.`,
        share, n: z.count, of, confidence: confidence(share, of),
        counter: side === "CT"
          ? `Expect ${names.get(k)} here early: pre-aim or flash this spot, or hit away from it.`
          : `${names.get(k)} is reliably here at ${fmt(secs)}: set a crossfire or throw utility on this spot.`,
        spot: { ...z.mean, label: where }, examples: z.examples.slice(0, 6),
      });
    }
  }

  // ---- 2. CT setups: stacks (3+ players near one site at 0:20)
  if (Object.keys(sites).length) {
    const stack = new Map<string, Example[]>();
    let counted = 0;
    for (const { d, ri } of CT) {
      const at = positionsAt(d.ins, 20);
      const near: Record<string, number> = {};
      d.ins.players.forEach((p, pi) => {
        if (p.team !== d.side) return;
        const pos = at.get(`${ri}:${pi}`);
        if (!pos) return;
        for (const [s, c] of Object.entries(sites)) if (Math.hypot(c.x - pos.x, c.y - pos.y) <= SITE_RADIUS * 1.3) near[s] = (near[s] ?? 0) + 1;
      });
      counted += 1;
      for (const [s, n] of Object.entries(near)) if (n >= 3) (stack.get(s) ?? stack.set(s, []).get(s)!).push(ex(d, ri, 17));
    }
    for (const [s, list] of stack) {
      const share = list.length / Math.max(1, counted);
      if (list.length < 2) continue;
      patterns.push({
        id: `stack-${s}`, category: "setups", side: "CT", title: `Stacks ${s} (3+ players) at 0:20`,
        detail: `${list.length} of ${counted} CT rounds (${pct(list.length, counted)}%).`,
        share, n: list.length, of: counted, confidence: confidence(share, counted),
        counter: `When you see signs of a ${s} stack (no contact elsewhere, utility on ${s}), hit the other site or split late.`,
        spot: { ...sites[s], label: `${s} site` }, examples: list.slice(0, 6),
      });
    }
  }

  // ---- 3. T site choice: overall, pistols, by buy
  const siteRows = (rows: typeof T, what: string, id: string) => {
    const planted = rows.filter((x) => x.v.plantSite);
    if (planted.length < 2) return;
    const counts: Record<string, Example[]> = {};
    for (const { d, ri, v } of planted) (counts[v.plantSite!.toUpperCase()] ??= []).push(ex(d, ri, Math.max(0, (v.plantS ?? 0) - 10)));
    const [site, list] = Object.entries(counts).sort((a, b) => b[1].length - a[1].length)[0];
    const share = list.length / planted.length;
    patterns.push({
      id: `site-${id}`, category: "site", side: "T", title: `${what}: plant ${site} ${pct(list.length, planted.length)}% of the time`,
      detail: `${list.length} of ${planted.length} plants${what === "All T rounds" ? "" : ` in ${what.replace(/^T /, "T-side ")}`} were on ${site}.`,
      share, n: list.length, of: planted.length, confidence: confidence(share, planted.length),
      counter: share >= 0.6 ? `Lean your CT setup towards ${site}${id === "pistol" ? " on pistol rounds" : ""}; rotate early on ${site} contact.` : "No strong site preference: play a default and rotate on information.",
      spot: sites[site] ? { ...sites[site], label: `${site} site` } : undefined, examples: list.slice(0, 6),
    });
  };
  siteRows(T, "All T rounds", "all");
  siteRows(T.filter((x) => x.v.tags.includes("pistol")), "T pistol rounds", "pistol");
  siteRows(T.filter((x) => x.v.tags.includes("eco") || x.v.tags.includes("half_buy")), "T eco and half-buy rounds", "lowbuy");
  siteRows(T.filter((x) => x.v.tags.includes("full_buy")), "T full-buy rounds", "full");

  // ---- 4. T pace
  if (T.length >= 3) {
    const fast = T.filter((x) => x.v.tags.includes("fast_plant"));
    const late = T.filter((x) => x.v.tags.includes("late_plant"));
    const plants = T.filter((x) => x.v.plantS !== null);
    const avg = plants.length ? plants.reduce((a, x) => a + (x.v.plantS ?? 0), 0) / plants.length : null;
    for (const [rows, name, id, counter] of [
      [fast, "Fast hits (plant before 0:35)", "fast", "Expect early pressure: keep utility for the first 30 seconds and don't over-rotate early."],
      [late, "Slow rounds (plant after 1:10)", "late", "They take their time: use the early round to take space and gather information."],
    ] as const) {
      if (rows.length < 2) continue;
      const share = rows.length / T.length;
      patterns.push({
        id: `pace-${id}`, category: "pace", side: "T", title: `${name} in ${pct(rows.length, T.length)}% of T rounds`,
        detail: `${rows.length} of ${T.length} T rounds.${avg !== null ? ` Average plant at ${fmt(avg)}.` : ""}`,
        share, n: rows.length, of: T.length, confidence: confidence(share, T.length), counter,
        examples: rows.slice(0, 6).map(({ d, ri }) => ex(d, ri)),
      });
    }
  }

  // ---- 5. Opening duels: who and where, per side
  for (const side of ["CT", "T"] as const) {
    const rows = bySide(side);
    const per = new Map<string, { won: number; lost: number; pts: { x: number; y: number; z: number; ex: Example }[] }>();
    let duels = 0;
    for (const { d, ri } of rows) {
      const first = d.ins.kills.filter((k) => k.r === ri).sort((a, b) => a.s - b.s)[0];
      if (!first) continue;
      const killerOurs = first.k >= 0 && d.ins.players[first.k]?.team === d.side;
      const victimOurs = d.ins.players[first.v]?.team === d.side;
      const pi = killerOurs ? first.k : victimOurs ? first.v : -1;
      if (pi < 0) continue;
      duels += 1;
      const k = keyOf(d, pi);
      const e = per.get(k) ?? { won: 0, lost: 0, pts: [] };
      if (killerOurs) e.won += 1; else e.lost += 1;
      const pos = killerOurs && first.kx !== null ? { x: first.kx, y: first.ky!, z: first.kz! } : { x: first.vx, y: first.vy, z: first.vz };
      e.pts.push({ ...pos, ex: ex(d, ri, Math.max(0, first.s - 4)) });
      per.set(k, e);
    }
    for (const [k, e] of per) {
      const took = e.won + e.lost;
      const share = took / Math.max(1, duels);
      if (took < 3 || share < 0.25) continue;
      const z = topZone(e.pts);
      patterns.push({
        id: `open-${side}-${k}`, category: "openings", side, player: names.get(k),
        title: `${names.get(k)} takes ${pct(took, duels)}% of ${side} opening duels (wins ${pct(e.won, took)}%)`,
        detail: `${took} of ${duels} first fights, ${e.won} won.${z ? ` Most ${at(label(z.mean.x, z.mean.y))}.` : ""}`,
        share, n: took, of: duels, confidence: confidence(share, duels),
        counter: e.won >= e.lost
          ? `${names.get(k)} wins early fights: don't take the first duel alone against them; trade in pairs or use utility first.`
          : `${names.get(k)} takes early fights and loses most: hold the angle and let them come to you.`,
        spot: z ? { ...z.mean, label: label(z.mean.x, z.mean.y) } : undefined, examples: e.pts.slice(0, 6).map((p) => p.ex),
      });
    }
  }

  // ---- 6. Early utility habits (first 25 s): grenades landing at the same spot
  for (const side of ["CT", "T"] as const) {
    const rows = bySide(side);
    const groups: { type: string; x: number; y: number; z: number; list: Example[]; throwers: Map<string, number>; rounds: Set<string> }[] = [];
    for (const { d, ri } of rows) {
      for (const g of d.ins.nades) {
        if (g.r !== ri || g.s > 25 || d.ins.players[g.p]?.team !== d.side || g.type === "decoy") continue;
        let grp = groups.find((x) => x.type === g.type && Math.hypot(x.x - g.lx, x.y - g.ly) < 200);
        if (!grp) groups.push(grp = { type: g.type, x: g.lx, y: g.ly, z: g.lz, list: [], throwers: new Map(), rounds: new Set() });
        const rk = `${d.replayId}:${ri}`;
        if (grp.rounds.has(rk)) continue;
        grp.rounds.add(rk);
        grp.list.push(ex(d, ri, Math.max(0, g.s - 2)));
        const who = d.ins.players[g.p].name;
        grp.throwers.set(who, (grp.throwers.get(who) ?? 0) + 1);
      }
    }
    for (const g of groups) {
      const share = g.list.length / Math.max(1, rows.length);
      if (g.list.length < 3 || share < 0.3) continue;
      const thrower = [...g.throwers].sort((a, b) => b[1] - a[1])[0]?.[0];
      const what = g.type === "smoke" ? "Smoke" : g.type === "flash" ? "Flash" : g.type === "he" ? "HE" : "Molotov";
      patterns.push({
        id: `util-${side}-${g.type}-${Math.round(g.x)}-${Math.round(g.y)}`, category: "utility", side,
        title: `${what} ${at(label(g.x, g.y))} in ${pct(g.list.length, rows.length)}% of ${side} rounds (first 25 s)`,
        detail: `${g.list.length} of ${rows.length} rounds${thrower ? `, mostly thrown by ${thrower}` : ""}.`,
        share, n: g.list.length, of: rows.length, confidence: confidence(share, rows.length),
        counter: side === "T"
          ? `This ${what.toLowerCase()} is a tell: when it lands early, expect their default/execute through it.`
          : `Their early ${what.toLowerCase()} lands here: avoid this path early or wait it out.`,
        spot: { x: g.x, y: g.y, z: g.z, label: label(g.x, g.y) }, examples: g.list.slice(0, 6),
      });
    }
  }

  // ---- 7. AWP: the main AWPer and where their AWP kills come from
  const awp = new Map<string, { pts: { x: number; y: number; z: number; ex: Example; side: Side }[] }>();
  for (const { d, ri, v } of views) {
    for (const k of d.ins.kills) {
      if (k.r !== ri || k.k < 0 || d.ins.players[k.k]?.team !== d.side || !(k.w ?? "").toLowerCase().includes("awp") || k.kx === null) continue;
      const key = keyOf(d, k.k);
      (awp.get(key) ?? awp.set(key, { pts: [] }).get(key)!).pts.push({ x: k.kx, y: k.ky!, z: k.kz!, side: v.side, ex: ex(d, ri, Math.max(0, k.s - 4)) });
    }
  }
  const awper = [...awp.entries()].sort((a, b) => b[1].pts.length - a[1].pts.length)[0];
  if (awper && awper[1].pts.length >= 3) {
    for (const side of ["CT", "T"] as const) {
      const pts = awper[1].pts.filter((p) => p.side === side);
      const z = pts.length >= 2 ? topZone(pts) : null;
      if (!z) continue;
      const share = z.count / pts.length;
      if (z.count < 2 || share < 0.4) continue;
      patterns.push({
        id: `awp-${side}`, category: "awp", side, player: names.get(awper[0]),
        title: `AWPer ${names.get(awper[0])} gets ${side} AWP kills ${at(label(z.mean.x, z.mean.y))}`,
        detail: `${z.count} of ${pts.length} AWP kills on ${side} from this spot.`,
        share, n: z.count, of: pts.length, confidence: confidence(share, pts.length),
        counter: `Smoke or flash this AWP angle before peeking, or take a different path.`,
        spot: { ...z.mean, label: label(z.mean.x, z.mean.y) }, examples: z.examples.slice(0, 6),
      });
    }
  }

  // ---- 8. Economy: buy after losing a pistol; saves
  const afterPistolLoss: { buy: string | null; e: Example }[] = [];
  for (const d of demos) {
    d.ins.rounds.forEach((r, ri) => {
      if (!r.pistol || r.winner === d.side || !d.ins.rounds[ri + 1]) return;
      afterPistolLoss.push({ buy: d.ins.rounds[ri + 1].buy?.[d.side] ?? null, e: ex(d, ri + 1) });
    });
  }
  if (afterPistolLoss.length >= 2) {
    const forced = afterPistolLoss.filter((x) => x.buy === "half_buy" || x.buy === "full_buy");
    const share = forced.length / afterPistolLoss.length;
    patterns.push({
      id: "eco-force", category: "economy", side: "both",
      title: share >= 0.5 ? `Force-buys after losing a pistol (${pct(forced.length, afterPistolLoss.length)}%)` : `Saves after losing a pistol (${pct(afterPistolLoss.length - forced.length, afterPistolLoss.length)}%)`,
      detail: `${forced.length} of ${afterPistolLoss.length} rounds after a lost pistol were a half or full buy.`,
      share: share >= 0.5 ? share : 1 - share, n: share >= 0.5 ? forced.length : afterPistolLoss.length - forced.length, of: afterPistolLoss.length,
      confidence: confidence(share >= 0.5 ? share : 1 - share, afterPistolLoss.length),
      counter: share >= 0.5
        ? "After you win pistol, expect a force: play closer angles, keep distance with rifles and don't give up cheap kills."
        : "After you win pistol, expect an eco: don't over-peek, stack info and play for the anti-eco.",
      examples: afterPistolLoss.slice(0, 6).map((x) => x.e),
    });
  }
  const lost = views.filter((x) => !x.v.won);
  const saves = lost.filter((x) => x.v.tags.includes("save"));
  if (lost.length >= 4 && saves.length >= 2) {
    const share = saves.length / lost.length;
    patterns.push({
      id: "eco-save", category: "economy", side: "both", title: `Saves 2+ players in ${pct(saves.length, lost.length)}% of lost rounds`,
      detail: `${saves.length} of ${lost.length} lost rounds.`, share, n: saves.length, of: lost.length, confidence: confidence(share, lost.length),
      counter: "Hunt saving players late in won rounds to break their economy.",
      examples: saves.slice(0, 6).map(({ d, ri }) => ex(d, ri)),
    });
  }

  // ---- 9. Aggression: players dying in the first 20 s
  for (const side of ["CT", "T"] as const) {
    const rows = bySide(side);
    const per = new Map<string, { n: number; pts: { x: number; y: number; z: number; ex: Example }[]; of: number }>();
    for (const { d, ri } of rows) {
      d.ins.players.forEach((p, pi) => {
        if (p.team !== d.side) return;
        const k = keyOf(d, pi);
        const e = per.get(k) ?? { n: 0, pts: [], of: 0 };
        e.of += 1;
        const early = d.ins.kills.find((x) => x.r === ri && x.v === pi && x.s <= 20);
        if (early) { e.n += 1; e.pts.push({ x: early.vx, y: early.vy, z: early.vz, ex: ex(d, ri, Math.max(0, early.s - 5)) }); }
        per.set(k, e);
      });
    }
    for (const [k, e] of per) {
      const share = e.n / Math.max(1, e.of);
      if (e.n < 3 || share < 0.2) continue;
      const z = topZone(e.pts);
      patterns.push({
        id: `aggr-${side}-${k}`, category: "aggression", side, player: names.get(k),
        title: `${names.get(k)} dies in the first 20 s of ${pct(e.n, e.of)}% of ${side} rounds`,
        detail: `${e.n} of ${e.of} rounds.${z ? ` Usually ${at(label(z.mean.x, z.mean.y))}.` : ""}`,
        share, n: e.n, of: e.of, confidence: confidence(share, e.of),
        counter: `${names.get(k)} plays aggressively early: hold a tight angle on their route and punish the push.`,
        spot: z ? { ...z.mean, label: label(z.mean.x, z.mean.y) } : undefined, examples: e.pts.slice(0, 6).map((p) => p.ex),
      });
    }
  }

  for (const p of patterns) p.examples.sort((a, b) => a.replayId.localeCompare(b.replayId) || a.roundNumber - b.roundNumber);
  const rank = { strong: 0, moderate: 1, weak: 2 } as const;
  patterns.sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.share - a.share);
  return {
    demos: demos.length, rounds: { T: T.length, CT: CT.length }, sites: Object.keys(sites).sort(),
    players: [...names].map(([key, name]) => ({ key, name })),
    patterns,
  };
}
