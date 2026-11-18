/**
 * Round payload cache: decode and validate only the requested round, prefetch
 * the next round when idle, cancel stale fetches, and bound memory (LRU).
 */
import { SCHEMA_VERSION, type RoundPayload } from "@/shared/contract";
import { indexRound, type RoundIndex } from "./playback";

export class PayloadError extends Error {}

/** Round payloads are served as gzip bytes (X-Content-Format: application/json+gzip). */
export async function gunzipResponse(res: Response): Promise<string> {
  if (res.headers.get("x-content-format") !== "application/json+gzip" || !res.body) return res.text();
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

export function validatePayload(p: RoundPayload, roundId: string): RoundPayload {
  if (!p || p.schemaVersion !== SCHEMA_VERSION) throw new PayloadError("Unsupported replay data version. Reload the page.");
  if (p.roundId !== roundId) throw new PayloadError("Round data does not match the requested round.");
  for (const t of p.tracks) {
    const n = t.t.length;
    for (const k of ["x", "y", "z", "yaw", "alive", "flags", "floor", "disc"] as const) {
      if (t[k].length !== n) throw new PayloadError(`Corrupt track for ${t.playerId}.`);
    }
    for (let i = 1; i < n; i++) if (t.t[i] < t.t[i - 1]) throw new PayloadError("Samples out of order.");
  }
  for (let i = 1; i < p.events.length; i++) {
    const a = p.events[i - 1];
    const b = p.events[i];
    if (b.tick < a.tick || (b.tick === a.tick && b.order < a.order)) throw new PayloadError("Events out of order.");
  }
  return p;
}

interface Entry {
  promise: Promise<RoundIndex>;
  ctrl: AbortController;
  value?: RoundIndex;
  bytes?: number;
}

export class RoundCache {
  private entries = new Map<string, Entry>();
  constructor(
    private replayId: string,
    private headers: () => Record<string, string>,
    private max = 6,
  ) {}

  has(roundId: string) {
    return !!this.entries.get(roundId)?.value;
  }

  get(roundId: string): Promise<RoundIndex> {
    const hit = this.entries.get(roundId);
    if (hit) {
      // refresh LRU position
      this.entries.delete(roundId);
      this.entries.set(roundId, hit);
      return hit.promise;
    }
    const ctrl = new AbortController();
    const promise = (async () => {
      const res = await fetch(`/api/replays/${this.replayId}/rounds/${roundId}`, {
        headers: this.headers(),
        signal: ctrl.signal,
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) throw new PayloadError(res.status === 404 ? "This round is no longer available." : `Could not load the round (${res.status}).`);
      const text = await gunzipResponse(res);
      const p = validatePayload(JSON.parse(text) as RoundPayload, roundId);
      const idx = indexRound(p);
      const e = this.entries.get(roundId);
      if (e) {
        e.value = idx;
        e.bytes = text.length;
      }
      return idx;
    })();
    promise.catch(() => this.entries.delete(roundId));
    this.entries.set(roundId, { promise, ctrl });
    this.evict();
    return promise;
  }

  /** Abort in-flight requests that are no longer wanted (e.g. after rapid round changes). */
  cancelExcept(keep: string[]) {
    for (const [id, e] of this.entries) {
      if (!e.value && !keep.includes(id)) {
        e.ctrl.abort();
        this.entries.delete(id);
      }
    }
  }

  prefetch(roundId: string | undefined) {
    if (!roundId || this.entries.has(roundId)) return;
    const run = () => void this.get(roundId).catch(() => {});
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(run, { timeout: 2000 });
    else setTimeout(run, 300);
  }

  private evict() {
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value!;
      const e = this.entries.get(oldest)!;
      if (!e.value) e.ctrl.abort();
      this.entries.delete(oldest);
    }
  }

  clear() {
    for (const e of this.entries.values()) e.ctrl.abort();
    this.entries.clear();
  }
}
