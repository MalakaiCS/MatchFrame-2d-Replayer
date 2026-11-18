import { env } from "@/lib/env";
import { badRequest, HttpError, json, route } from "@/lib/http";
import { getFsStorage, verifyFsUpload } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Local-development upload target (STORAGE_DRIVER=fs). In production the browser PUTs to a signed S3 URL. */
export const PUT = route(async (req: Request) => {
  if (env.storageDriver !== "fs") throw new HttpError(404, "NOT_FOUND", "Not found.");
  const u = new URL(req.url);
  const key = u.searchParams.get("key") ?? "";
  const size = Number(u.searchParams.get("size"));
  const exp = Number(u.searchParams.get("exp"));
  const sig = u.searchParams.get("sig") ?? "";
  if (!verifyFsUpload(key, size, exp, sig)) throw new HttpError(403, "UPLOAD_EXPIRED", "The upload link has expired. Start the upload again.");
  if (!req.body) throw badRequest("Empty upload.");
  try {
    await getFsStorage().writeStream(key, req.body, size);
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (m === "TOO_LARGE" || m === "SIZE_MISMATCH") throw badRequest("The uploaded size does not match the declared size.", "SIZE_MISMATCH");
    throw e;
  }
  return json({ ok: true });
});
