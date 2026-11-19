/**
 * Automatic round tags from a replay's insights, from one team's point of view. Rules (documented
 * in docs/data-contract.md, "Round tags"):
 *
 * - Economy: pistol; the team's buy (eco / half buy / full buy); anti-eco = full buy against an eco.
 * - Pace (T side): fast plant (planted within 35 s of freeze end), execute (35-70 s), late plant
 *   (after 70 s), no plant.
 * - Outcome: retake won (CT defused), post-plant won (T planted and won), save (the losing team still
 *   had 2+ players alive when the round was decided), opening kill / opening death.
 */
import type { Side, TeamKey } from "@/shared/contract";
import type { Insights } from "./insights";

export const TAGS = [
  "pistol", "eco", "half_buy", "full_buy", "anti_eco", "fast_plant", "execute", "late_plant", "no_plant",
  "retake_won", "post_plant_won", "save", "opening_kill", "opening_death",
] as const;
export type Tag = (typeof TAGS)[number];

export const TAG_LABELS: Record<Tag, string> = {
  pistol: "Pistol", eco: "Eco", half_buy: "Half buy", full_buy: "Full buy", anti_eco: "Anti-eco",
  fast_plant: "Fast plant", execute: "Execute", late_plant: "Late plant", no_plant: "No plant",
  retake_won: "Retake won", post_plant_won: "Post-plant won", save: "Save", opening_kill: "Opening kill", opening_death: "Opening death",
};

export interface RoundView {
  index: number; id: string; number: number; side: Side; won: boolean; tags: Tag[];
  plantSite: string | null; plantS: number | null; length: number; buy: string | null; oppBuy: string | null;
}

export function roundView(ins: Insights, ri: number, team: TeamKey): RoundView {
  const rd = ins.rounds[ri];
  const opp: TeamKey = team === "A" ? "B" : "A";
  const side = rd.sides[team];
  const won = rd.winner === team;
  const tags: Tag[] = [];
  const buy = rd.buy?.[team] ?? null;
  const oppBuy = rd.buy?.[opp] ?? null;
  if (rd.pistol) tags.push("pistol");
  else {
    if (buy === "eco" || buy === "half_buy" || buy === "full_buy") tags.push(buy);
    if (buy === "full_buy" && oppBuy === "eco") tags.push("anti_eco");
  }
  if (side === "T") {
    if (!rd.plant) tags.push("no_plant");
    else if (rd.plant.s < 35) tags.push("fast_plant");
    else if (rd.plant.s <= 70) tags.push("execute");
    else tags.push("late_plant");
  }
  if (rd.plant) {
    if (side === "CT" && won && rd.defused) tags.push("retake_won");
    if (side === "T" && won) tags.push("post_plant_won");
  }
  // Survivors when the round was decided.
  const roster = new Map<number, TeamKey>(ins.players.map((p, i) => [i, p.team]));
  const dead = new Set(ins.kills.filter((k) => k.r === ri && k.s <= rd.length).map((k) => k.v));
  // Only players who were in this round (they have positions in it) count.
  const present = new Set<number>();
  for (let i = 0; i < ins.pos.r.length; i++) if (ins.pos.r[i] === ri) present.add(ins.pos.p[i]);
  const alive = (k: TeamKey) => [...present].filter((i) => roster.get(i) === k && !dead.has(i)).length;
  if (!won && alive(team) >= 2 && rd.winner) tags.push("save");
  const first = ins.kills.filter((k) => k.r === ri).sort((a, b) => a.s - b.s)[0];
  if (first) {
    if (first.k >= 0 && roster.get(first.k) === team && roster.get(first.v) !== team) tags.push("opening_kill");
    else if (roster.get(first.v) === team) tags.push("opening_death");
  }
  return {
    index: ri, id: rd.id, number: rd.n, side, won, tags, plantSite: rd.plant?.site ?? null, plantS: rd.plant?.s ?? null,
    length: rd.length, buy, oppBuy,
  };
}
