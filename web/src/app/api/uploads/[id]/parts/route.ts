import { z } from "zod";
import { requireUser } from "@/lib/access";
import { q1 } from "@/lib/db";
import { badRequest, body, conflict, json, notFound, route } from "@/lib/http";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

interface Up { id: string; owner_id: string; object_key: string; declared_size: string; status: string; multipart_id: string | null; part_size: string | null; expired: boolean }

async function multipartUpload(req: Request, ctx: Ctx) {
  const user = await requireUser(req);
  const { id } = await ctx.params;
  const up = await q1<Up>("select *, expires_at < now() as expired from uploads where id = $1", [id]);
  if (!up || up.owner_id !== user.id || !up.multipart_id || !up.part_size) throw notFound();
  if (up.status !== "pending" || up.expired) throw conflict("This upload can no longer be resumed. Start it again.", "UPLOAD_EXPIRED");
  const size = Number(up.declared_size);
  const partSize = Number(up.part_size);
  const parts = Math.ceil(size / partSize);
  const sizeOf = (n: number) => (n < parts ? partSize : size - partSize * (parts - 1));
  return { up, size, partSize, parts, sizeOf };
}

/** Which parts are already uploaded (so the browser can resume). */
export const GET = route(async (req: Request, ctx: Ctx) => {
  const { up, size, partSize, parts, sizeOf } = await multipartUpload(req, ctx);
  const done = (await getStorage().listParts(up.object_key, up.multipart_id!)).filter((p) => p.partNumber <= parts && p.size === sizeOf(p.partNumber));
  return json({ size, partSize, parts, done: done.map((p) => p.partNumber) });
});

const Req = z.object({ partNumbers: z.array(z.number().int().min(1)).min(1).max(20) });

/** Signed upload targets for some parts (each exactly its part size). */
export const POST = route(async (req: Request, ctx: Ctx) => {
  const { up, parts, sizeOf } = await multipartUpload(req, ctx);
  const { partNumbers } = await body(req, Req);
  if (partNumbers.some((n) => n > parts)) throw badRequest("No such part.");
  const st = getStorage();
  const targets = await Promise.all(partNumbers.map(async (n) => ({ partNumber: n, size: sizeOf(n), upload: await st.partTarget(up.object_key, up.multipart_id!, n, sizeOf(n)) })));
  return json({ targets });
});
