import { z } from "zod";
import { REVIEW_ROLES, userTeams } from "./access";
import { q1 } from "./db";
import { forbidden, notFound } from "./http";

/** Board contents. Positions are radar-image pixels of the map (0..imageSize). */
export const BoardData = z.object({
  floor: z.number().int().min(0).max(3).default(0),
  tokens: z.array(z.object({
    id: z.string().max(40),
    kind: z.enum(["ct", "t", "smoke", "flash", "molotov", "he", "bomb", "text"]),
    x: z.number().min(-200).max(2248),
    y: z.number().min(-200).max(2248),
    label: z.string().max(40).optional(),
  })).max(200),
  strokes: z.array(z.object({
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    width: z.number().min(1).max(12),
    arrow: z.boolean().optional(),
    points: z.array(z.tuple([z.number(), z.number()])).min(2).max(2000),
  })).max(300),
});
export type BoardDataT = z.infer<typeof BoardData>;

export interface BoardRow {
  id: string; owner_id: string; team_id: string | null; name: string; map_id: string; data: BoardDataT; version: number; updated_at: string;
}

/** A board you may see: your own, or your team's. `edit` also requires a review role on team boards. */
export async function boardFor(userId: string, id: string, edit: boolean): Promise<BoardRow> {
  const b = await q1<BoardRow>("select * from tactic_boards where id = $1", [id]);
  if (!b) throw notFound();
  if (b.owner_id === userId) return b;
  if (b.team_id) {
    const role = (await userTeams(userId)).find((t) => t.team_id === b.team_id)?.role;
    if (role) {
      if (edit && !REVIEW_ROLES.includes(role)) throw forbidden("Viewers cannot edit team boards.");
      return b;
    }
  }
  throw notFound();
}
