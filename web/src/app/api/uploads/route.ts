import { z } from "zod";
import { requireUser } from "@/lib/access";
import { assertCanStartUpload, assertCanUploadTo } from "@/lib/billing";
import { q1 } from "@/lib/db";
import { env } from "@/lib/env";
import { badRequest, body, json, route } from "@/lib/http";
import { newId } from "@/lib/ids";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Plain demos and the archive formats demos are distributed in (Valve: .dem.bz2; tournaments/scrims: .rar/.zip). */
const ACCEPTED = /\.(dem|bz2|gz|zip|rar)$/;

const Req = z.object({
  filename: z.string().min(1).max(255),
  size: z.number().int().positive(),
  /** Where the replay will go; checked against plans up front so a large upload is not wasted. */
  teamId: z.string().max(64).nullable().optional(),
  /** The client can upload in parts and resume; large files then use a multipart upload. */
  resumable: z.boolean().optional(),
});

/** Create a bounded, short-lived upload slot for one .dem file. */
export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  const { filename, size, teamId, resumable } = await body(req, Req);
  if (teamId !== undefined) await assertCanUploadTo(user.id, teamId);
  else await assertCanStartUpload(user.id);
  const lower = filename.toLowerCase();
  if (/\.(7z|xz|zst|tar)$/.test(lower)) {
    throw badRequest("This archive type is not supported. Upload a .dem, .dem.bz2, .dem.gz, .zip or .rar file.", "UNSUPPORTED_ARCHIVE");
  }
  if (!ACCEPTED.test(lower)) {
    throw badRequest("Upload a CS2 demo: .dem, or a .dem.bz2, .dem.gz, .zip or .rar containing one .dem.", "UNSUPPORTED_FORMAT");
  }
  if (size > env.maxDemoBytes) {
    throw badRequest(`The demo is ${(size / 2 ** 20).toFixed(0)} MiB; the limit is ${(env.maxDemoBytes / 2 ** 20).toFixed(0)} MiB.`, "TOO_LARGE");
  }
  const pending = await q1<{ n: number }>(
    "select count(*)::int as n from uploads where owner_id = $1 and status = 'pending' and expires_at > now()", [user.id]);
  if ((pending?.n ?? 0) >= 10) throw badRequest("Too many uploads in progress. Finish or wait for them first.", "RATE_LIMITED");
  const id = newId();
  const key = `uploads/${user.id.replace(/[^A-Za-z0-9-]/g, "")}/${id}.dem`;
  if (resumable && size >= env.multipartMinBytes) {
    const multipartId = await getStorage().startMultipart(key, "application/octet-stream");
    const row = await q1<{ expires_at: string }>(
      `insert into uploads(id, owner_id, object_key, filename, declared_size, max_bytes, expires_at, multipart_id, part_size)
       values ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7), $8, $9) returning expires_at`,
      [id, user.id, key, filename.slice(0, 255), size, env.maxDemoBytes, env.resumableHours, multipartId, env.partBytes],
    );
    return json({
      uploadId: id, multipart: { partSize: env.partBytes, parts: Math.ceil(size / env.partBytes) },
      maxBytes: env.maxDemoBytes, expiresAt: row!.expires_at,
    }, { status: 201 });
  }
  const target = await getStorage().createUploadTarget(key, size, env.maxDemoBytes, "application/octet-stream");
  const row = await q1<{ expires_at: string }>(
    `insert into uploads(id, owner_id, object_key, filename, declared_size, max_bytes, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7)) returning expires_at`,
    [id, user.id, key, filename.slice(0, 255), size, env.maxDemoBytes, env.uploadSlotSeconds],
  );
  return json({ uploadId: id, upload: target, maxBytes: env.maxDemoBytes, expiresAt: row!.expires_at }, { status: 201 });
});
