/**
 * Round filters. Semantics (docs/data-contract.md#round-filters):
 * - Categories combine with AND; options inside a category combine with OR.
 * - An empty category does not filter.
 * - "pistol" = regulation pistol rounds (1 and first round after halftime).
 *   "gun" = every other round, including overtime.
 * - Buy filters apply to the chosen team ("A", "B" or "either"). Rounds with
 *   unknown equipment value match only the "unknown" buy option.
 * - Results keep the original RoundSummary objects (ids, display numbers, ticks, scores).
 */
import type { BuyType, RoundSummary, Side, TeamKey } from "@/shared/contract";

export type RoundKind = "pistol" | "gun";
export type BuyOption = Exclude<BuyType, "pistol"> | "unknown";

export interface RoundFilters {
  kind: RoundKind[];
  buy: BuyOption[];
  buyTeam: TeamKey | "either";
  side: { team: TeamKey; side: Side } | null;
  winner: TeamKey[];
  overtime: "all" | "only" | "exclude";
  bomb: "any" | "planted" | "not-planted";
}

export const EMPTY_FILTERS: RoundFilters = {
  kind: [], buy: [], buyTeam: "either", side: null, winner: [], overtime: "all", bomb: "any",
};

export function isEmpty(f: RoundFilters): boolean {
  return !f.kind.length && !f.buy.length && !f.side && !f.winner.length && f.overtime === "all" && f.bomb === "any";
}

function buyMatches(r: RoundSummary, team: TeamKey, opts: BuyOption[]): boolean {
  const bt = r.economy[team].buyType;
  if (bt === "pistol") return false;
  if (bt === null) return opts.includes("unknown");
  return opts.includes(bt);
}

export function matchRound(r: RoundSummary, f: RoundFilters): boolean {
  if (f.kind.length) {
    const kind: RoundKind = r.isPistol ? "pistol" : "gun";
    if (!f.kind.includes(kind)) return false;
  }
  if (f.buy.length) {
    const teams: TeamKey[] = f.buyTeam === "either" ? ["A", "B"] : [f.buyTeam];
    if (!teams.some((t) => buyMatches(r, t, f.buy))) return false;
  }
  if (f.side && r.sides[f.side.team] !== f.side.side) return false;
  if (f.winner.length && (r.winner === null || !f.winner.includes(r.winner))) return false;
  if (f.overtime === "only" && !r.isOvertime) return false;
  if (f.overtime === "exclude" && r.isOvertime) return false;
  if (f.bomb === "planted" && !r.bombPlanted) return false;
  if (f.bomb === "not-planted" && r.bombPlanted) return false;
  return true;
}

export function filterRounds(rounds: RoundSummary[], f: RoundFilters): RoundSummary[] {
  return rounds.filter((r) => matchRound(r, f));
}

/** Filters are kept in the URL so a filtered view can be shared and restored. */
export function filtersToParam(f: RoundFilters): string {
  if (isEmpty(f)) return "";
  const parts: string[] = [];
  if (f.kind.length) parts.push(`k:${f.kind.join(",")}`);
  if (f.buy.length) parts.push(`b:${f.buy.join(",")}`, `bt:${f.buyTeam}`);
  if (f.side) parts.push(`s:${f.side.team}${f.side.side}`);
  if (f.winner.length) parts.push(`w:${f.winner.join(",")}`);
  if (f.overtime !== "all") parts.push(`ot:${f.overtime}`);
  if (f.bomb !== "any") parts.push(`bomb:${f.bomb}`);
  return parts.join(";");
}

export function filtersFromParam(s: string | null): RoundFilters {
  const f: RoundFilters = { ...EMPTY_FILTERS, kind: [], buy: [], winner: [] };
  if (!s) return f;
  for (const part of s.split(";")) {
    const [k, v = ""] = part.split(":");
    const list = v.split(",").filter(Boolean);
    if (k === "k") f.kind = list.filter((x): x is RoundKind => x === "pistol" || x === "gun");
    if (k === "b") f.buy = list.filter((x): x is BuyOption => ["eco", "semi_eco", "semi_buy", "full", "unknown"].includes(x));
    if (k === "bt" && (v === "A" || v === "B" || v === "either")) f.buyTeam = v;
    if (k === "s" && /^(A|B)(CT|T)$/.test(v)) f.side = { team: v[0] as TeamKey, side: v.slice(1) as Side };
    if (k === "w") f.winner = list.filter((x): x is TeamKey => x === "A" || x === "B");
    if (k === "ot" && (v === "only" || v === "exclude")) f.overtime = v;
    if (k === "bomb" && (v === "planted" || v === "not-planted")) f.bomb = v;
  }
  return f;
}
