import { z } from "zod";
import { MANAGE_ROLES, replayAccess } from "@/lib/access";
import { manifestFor, validateAnchor } from "@/lib/anchors";
import { q, q1 } from "@/lib/db";
import { body, forbidden, json, notFound, route } from "@/lib/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; itemId: string }> };

const TABLES = {
  bm_: { table: "bookmarks", author: "owner_id" },
  nt_: { table: "notes", author: "author_id" },
} as const;

async function load(req: Request, ctx: Ctx) {
  const { id, itemId } = await ctx.params;
  const a = await replayAccess(req, id);
  if (!a.user || !a.canReview) throw forbidden();
  const t = TABLES[itemId.slice(0, 3) as keyof typeof TABLES];
  if (!t) throw notFound();
  const row = await q1<Record<string, unknown>>(
    `select *, ${t.author} as author from ${t.table} where id = $1 and replay_id = $2`,
    [itemId, id],
  );
  if (!row) throw notFound();
  const isAuthor = row.author === a.user.id;
  const teamRole = row.team_id ? a.teams.find((x) => x.team_id === row.team_id)?.role : undefined;
  if (!row.team_id && !isAuthor) throw notFound(); // other users' personal items are invisible
  if (row.team_id && !teamRole) throw notFound();
  const canEdit = isAuthor || (teamRole !== undefined && MANAGE_ROLES.includes(teamRole));
  if (!canEdit) throw forbidden("Only the author or a team coach can change this item.");
  return { a, table: t.table, row, itemId };
}

const Patch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(5000).optional(),
  roundId: z.string().optional(),
  tick: z.number().int().optional(),
  endTick: z.number().int().nullable().optional(),
});

export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const { a, table, row, itemId } = await load(req, ctx);
  const p = await body(req, Patch);
  const sets: string[] = [];
  const vals: unknown[] = [itemId];
  const add = (c: string, v: unknown) => {
    vals.push(v);
    sets.push(`${c} = $${vals.length}`);
  };
  if (p.tick !== undefined || p.roundId !== undefined || p.endTick !== undefined) {
    const m = await manifestFor(a);
    const anchor = {
      roundId: p.roundId ?? (row.round_id as string),
      tick: p.tick ?? Number(row.tick),
      endTick: p.endTick === undefined ? ((row.end_tick as number | null) ?? null) : p.endTick,
    };
    const { revision } = validateAnchor(m, anchor);
    add("round_id", anchor.roundId);
    add("tick", anchor.tick);
    add("revision", revision);
    if (table === "bookmarks") add("end_tick", anchor.endTick ?? null);
  }
  if (table === "bookmarks" && p.title !== undefined) add("title", p.title);
  if (table === "notes" && p.body !== undefined) add("body", p.body);
  if (sets.length) await q(`update ${table} set ${sets.join(", ")}, updated_at = now() where id = $1`, vals);
  return json({ ok: true });
});

export const DELETE = route(async (req: Request, ctx: Ctx) => {
  const { table, itemId } = await load(req, ctx);
  await q(`delete from ${table} where id = $1`, [itemId]);
  return json({ ok: true });
});
