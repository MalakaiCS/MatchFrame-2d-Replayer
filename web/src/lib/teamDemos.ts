/**
 * One in-game team's demos on a map, with their insights, for the pattern finder. Insights that are
 * not cached yet are built a few per request; the rest are reported as pending (the page asks again).
 */
import { z } from "zod";
import type { SessionUser } from "./auth";
import { q } from "./db";
import { badRequest, notFound } from "./http";
import { insightsFor } from "./insights";
import type { TeamDemo } from "./patterns";
import { indexedReplays, teamKey } from "./statIndex";
import { statReplays } from "./statQuery";
import type { TeamKey } from "@/shared/contract";

export const MAX_TEAM_DEMOS = 40;
const BUILD_BUDGET = 6;

export interface DemoMeta {
  id: string; title: string | null; when: string; opponent: string; side: TeamKey; score: string; won: boolean | null; ready: boolean;
}

export async function loadTeamDemos(user: SessionUser, u: URL, name: string, map: string, onlyIds: string[] | null) {
  const rows = (await statReplays(user, u)).filter((r) => r.map_id === map);
  const { replays, pending: unindexed } = await indexedReplays(rows);
  const key = teamKey(name);
  const matched = replays
    .map((r) => ({ r, side: (["A", "B"] as TeamKey[]).find((k) => r.summary.teams[k].nameSource !== "fallback" && teamKey(r.summary.teams[k].name) === key) }))
    .filter((x): x is { r: (typeof replays)[number]; side: TeamKey } => !!x.side)
    .slice(0, MAX_TEAM_DEMOS);
  if (!matched.length) throw notFound();
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const cached = new Set((await q<{ replay_id: string; revision: number }>(
    "select replay_id, revision from replay_insights where replay_id = any($1::text[])", [matched.map((x) => x.r.id)],
  )).filter((c) => rowById.get(c.replay_id)?.published_revision === c.revision).map((c) => c.replay_id));

  const wanted = onlyIds ? new Set(onlyIds) : null;
  let budget = BUILD_BUDGET;
  let pending = unindexed;
  const demos: TeamDemo[] = [];
  const list: DemoMeta[] = [];
  for (const { r, side } of matched) {
    const other: TeamKey = side === "A" ? "B" : "A";
    const t = r.summary.teams;
    const won = t[side].score > t[other].score ? true : t[side].score < t[other].score ? false : null;
    const meta: DemoMeta = {
      id: r.id, title: r.title, when: r.playedAt ?? r.createdAt, opponent: t[other].name, side,
      score: `${t[side].score}–${t[other].score}`, won, ready: cached.has(r.id),
    };
    list.push(meta);
    if (wanted && !wanted.has(r.id)) continue;
    if (!cached.has(r.id)) {
      if (budget <= 0) { pending += 1; continue; }
      budget -= 1;
    }
    try {
      const ins = await insightsFor(rowById.get(r.id)!);
      meta.ready = true;
      demos.push({ replayId: r.id, side, ins, when: meta.when, opponent: meta.opponent });
    } catch (e) {
      console.error("[antistrat] insights failed", r.id, e instanceof Error ? e.message : e);
    }
  }
  return { demos, list, pending };
}

/** Comma-separated replay ids from the query, or null for all of the team's demos. */
export function idsParam(u: URL): string[] | null {
  const raw = (u.searchParams.get("ids") ?? "").trim();
  if (!raw) return null;
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length > 100 || ids.some((id) => !/^[\w-]{1,64}$/.test(id))) throw badRequest("Bad demo list.");
  return ids;
}

const Area = z.array(z.string().trim().min(1).max(40)).max(8);
/** Body of the per-player reports request (also used by the per-player AI brief). */
export const ReportsReq = z.object({
  opponent: z.string().trim().min(1).max(80),
  map: z.string().trim().min(1).max(64),
  ids: z.array(z.string().regex(/^[\w-]{1,64}$/)).max(100).nullable().default(null),
  space: z.enum(["all", "personal", "team"]).default("all"),
  teamId: z.string().max(64).optional(),
  players: z.array(z.object({
    name: z.string().trim().min(1).max(40),
    role: z.object({ CT: z.string().max(60).optional(), T: z.string().max(60).optional() }).default({}),
    CT: Area, T: Area,
  })).min(1).max(10),
});
