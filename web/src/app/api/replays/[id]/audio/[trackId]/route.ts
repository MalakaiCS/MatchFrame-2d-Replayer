import { z } from "zod";
import { replayAccess } from "@/lib/access";
import { requireManage, trackFor } from "@/lib/audio";
import { q } from "@/lib/db";
import { body, json, route } from "@/lib/http";
import { assertTeamScope } from "@/lib/review-scope";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; trackId: string }> };

const Patch = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  offsetMs: z.number().int().min(-86_400_000).max(86_400_000).optional(),
  shareWithLink: z.boolean().optional(),
  teamId: z.string().nullable().optional(),
  durationMs: z.number().int().positive().max(86_400_000).optional(),
});

export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const { id, trackId } = await ctx.params;
  const a = await replayAccess(req, id);
  const t = await trackFor(a, trackId);
  const p = await body(req, Patch);
  // Duration is reported by the uploader's browser after decoding; everything else needs manage rights.
  if (p.label !== undefined || p.offsetMs !== undefined || p.shareWithLink !== undefined || p.teamId !== undefined) requireManage(a, t);
  else if (t.uploaded_by !== a.user?.id) requireManage(a, t);
  const teamId = p.teamId === undefined ? undefined : await assertTeamScope(a, p.teamId);
  await q(
    `update audio_tracks set
       label = coalesce($2, label), offset_ms = coalesce($3, offset_ms), share_with_link = coalesce($4, share_with_link),
       team_id = case when $5 then $6 else team_id end, duration_ms = coalesce($7, duration_ms), updated_at = now()
     where id = $1`,
    [trackId, p.label ?? null, p.offsetMs ?? null, p.shareWithLink ?? null, teamId !== undefined, teamId ?? null, p.durationMs ?? null],
  );
  return json({ ok: true });
});

export const DELETE = route(async (req: Request, ctx: Ctx) => {
  const { id, trackId } = await ctx.params;
  const a = await replayAccess(req, id);
  const t = await trackFor(a, trackId);
  requireManage(a, t);
  await q("update audio_tracks set status = 'deleted', updated_at = now() where id = $1", [trackId]);
  await getStorage().delete(t.object_key).catch(() => {});
  return json({ ok: true });
});
