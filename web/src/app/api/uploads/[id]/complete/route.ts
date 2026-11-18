import { z } from "zod";
import { requireUser } from "@/lib/access";
import { tx } from "@/lib/db";
import { env } from "@/lib/env";
import { badRequest, body, conflict, json, notFound, route } from "@/lib/http";
import { newId } from "@/lib/ids";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

const Req = z.object({
  title: z.string().max(200).optional(),
  teamId: z.string().max(64).nullable().optional(),
  seriesId: z.string().max(64).regex(/^[A-Za-z0-9_-]+$/).nullable().optional(),
  seriesMapIndex: z.number().int().min(1).max(7).nullable().optional(),
});

const MAGIC_CS2 = Buffer.from("PBDEMS2\0", "latin1");
const MAGIC_SYNTH = Buffer.from("MFSYNTH1", "latin1");

/** Finalise an upload exactly once: verify ownership and size, then create the replay and its parse job. */
export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser(req);
  const { id } = await ctx.params;
  const opts = await body(req, Req);
  const storage = getStorage();

  return tx(async (c) => {
    const up = (await c.query("select * from uploads where id = $1 for update", [id])).rows[0];
    if (!up || up.owner_id !== user.id) throw notFound();
    if (up.status === "completed") {
      const r = (await c.query("select id, status from replays where id = $1", [up.replay_id])).rows[0];
      return json({ replayId: r.id, status: r.status, duplicate: true });
    }
    if (up.status !== "pending") throw conflict("This upload slot has expired. Start the upload again.", "UPLOAD_EXPIRED");
    const size = await storage.size(up.object_key);
    if (size === null) throw badRequest("No file was received for this upload.", "UPLOAD_MISSING");
    if (size > Number(up.max_bytes) || size !== Number(up.declared_size)) {
      await storage.delete(up.object_key);
      await c.query("update uploads set status = 'rejected' where id = $1", [id]);
      throw badRequest("The uploaded file size does not match the upload request.", "SIZE_MISMATCH");
    }
    const head = await storage.readHead(up.object_key, 8);
    if (!head.equals(MAGIC_CS2) && !(process.env.MF_ALLOW_SYNTHETIC === "1" && head.equals(MAGIC_SYNTH))) {
      await storage.delete(up.object_key);
      await c.query("update uploads set status = 'rejected' where id = $1", [id]);
      const code = head.subarray(0, 7).toString("latin1") === "HL2DEMO" ? "LEGACY_DEMO" : "INVALID_DEMO";
      throw badRequest(
        code === "LEGACY_DEMO" ? "This is a CS:GO demo. Only CS2 demos are supported." : "The file is not a CS2 demo (missing PBDEMS2 header).",
        code,
      );
    }
    let teamId: string | null = null;
    if (opts.teamId) {
      const m = (await c.query("select role from team_members where team_id = $1 and user_id = $2", [opts.teamId, user.id])).rows[0];
      if (!m || m.role === "viewer") throw badRequest("You cannot add replays to that team.", "FORBIDDEN_TEAM");
      teamId = opts.teamId;
    }
    const replayId = newId(20);
    await c.query(
      `insert into replays(id, owner_id, team_id, title, status, visibility, source_key, source_size, source_filename,
                           source_expires_at, series_id, series_map_index)
       values ($1,$2,$3,$4,'queued',$5,$6,$7,$8, now() + make_interval(secs => $9), $10, $11)`,
      [replayId, user.id, teamId, opts.title || null, teamId ? "team" : "private", up.object_key, size, up.filename,
        env.pendingSourceTtlSeconds, opts.seriesId ?? null, opts.seriesMapIndex ?? null],
    );
    await c.query("insert into jobs(replay_id, revision, kind) values ($1, 1, 'parse') on conflict do nothing", [replayId]);
    await c.query("update uploads set status = 'completed', replay_id = $2, completed_at = now() where id = $1", [id, replayId]);
    return json({ replayId, status: "queued", duplicate: false }, { status: 201 });
  });
});
