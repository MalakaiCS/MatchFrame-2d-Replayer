import { gunzipSync } from "node:zlib";
import type { Manifest } from "@/shared/contract";
import { getStorage } from "./storage";

const cache = new Map<string, Manifest>();
const MAX = 64;

/** Published manifests are immutable per prefix, so they can be cached in memory. */
export async function loadManifest(prefix: string): Promise<Manifest> {
  const hit = cache.get(prefix);
  if (hit) return hit;
  const buf = await getStorage().read(`${prefix}/manifest.json.gz`);
  const m = JSON.parse(gunzipSync(buf).toString("utf8")) as Manifest;
  for (const r of m.rounds) r.payload.key = "";
  cache.set(prefix, m);
  if (cache.size > MAX) cache.delete(cache.keys().next().value!);
  return m;
}
