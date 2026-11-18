import { z } from "zod";
import { requireUser } from "@/lib/access";
import { q1 } from "@/lib/db";
import { env } from "@/lib/env";
import { badRequest, body, json, route } from "@/lib/http";
import { newId } from "@/lib/ids";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

const Req = z.object({
  filename: z.string().min(1).max(255),
  size: z.number().int().positive(),
});

/** Create a bounded, short-lived upload slot for one .dem file. */
export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  const { filename, size } = await body(req, Req);
  const lower = filename.toLowerCase();
  if (/\.(gz|bz2|zip|rar|7z|xz|zst)$/.test(lower)) {
    throw badRequest("Compressed archives are not accepted. Extract the archive and upload the .dem file.", "COMPRESSED_ARCHIVE");
  }
  if (!lower.endsWith(".dem")) throw badRequest("Only CS2 .dem files are accepted.", "UNSUPPORTED_FORMAT");
  if (size > env.maxDemoBytes) {
    throw badRequest(`The demo is ${(size / 2 ** 20).toFixed(0)} MiB; the limit is ${(env.maxDemoBytes / 2 ** 20).toFixed(0)} MiB.`, "TOO_LARGE");
  }
  const pending = await q1<{ n: number }>(
    "select count(*)::int as n from uploads where owner_id = $1 and status = 'pending' and expires_at > now()", [user.id]);
  if ((pending?.n ?? 0) >= 10) throw badRequest("Too many uploads in progress. Finish or wait for them first.", "RATE_LIMITED");
  const id = newId();
  const key = `uploads/${user.id.replace(/[^A-Za-z0-9-]/g, "")}/${id}.dem`;
  const target = await getStorage().createUploadTarget(key, size, env.maxDemoBytes, "application/octet-stream");
  const row = await q1<{ expires_at: string }>(
    `insert into uploads(id, owner_id, object_key, filename, declared_size, max_bytes, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7)) returning expires_at`,
    [id, user.id, key, filename.slice(0, 255), size, env.maxDemoBytes, env.uploadSlotSeconds],
  );
  return json({ uploadId: id, upload: target, maxBytes: env.maxDemoBytes, expiresAt: row!.expires_at }, { status: 201 });
});
