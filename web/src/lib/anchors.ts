import type { Manifest } from "@/shared/contract";
import type { Access } from "./access";
import { badRequest, conflict } from "./http";
import { loadManifest } from "./manifest";

export interface Anchor {
  roundId: string;
  tick: number;
  endTick?: number | null;
}

export async function manifestFor(a: Access): Promise<Manifest> {
  if (a.replay.status !== "ready" || !a.replay.published_prefix) throw conflict("The replay is not ready yet.", "NOT_READY");
  return loadManifest(a.replay.published_prefix);
}

/** Validate an anchor against the published revision. Returns the revision to store. */
export function validateAnchor(m: Manifest, anchor: Anchor) {
  const r = m.rounds.find((x) => x.id === anchor.roundId);
  if (!r) throw badRequest("Unknown round.", "BAD_ANCHOR");
  if (anchor.tick < r.startTick || anchor.tick >= r.endTick) throw badRequest("The moment is outside the round.", "BAD_ANCHOR");
  if (anchor.endTick != null && (anchor.endTick <= anchor.tick || anchor.endTick > r.endTick)) {
    throw badRequest("The range end must be later in the same round.", "BAD_ANCHOR");
  }
  return { revision: m.revision, round: r };
}

export type AnchorStatus = "current" | "migrated" | "unavailable";

/**
 * Anchors store absolute demo ticks. A new revision of the same demo keeps the
 * same ticks, so an anchor migrates only when its round still exists and still
 * contains the tick. Otherwise it is surfaced as unavailable, never moved.
 */
export function anchorStatus(
  m: Manifest | null,
  revision: number,
  roundId: string,
  tick: number,
): { status: AnchorStatus; displayNumber: number | null } {
  if (!m) return { status: "unavailable", displayNumber: null };
  const r = m.rounds.find((x) => x.id === roundId);
  if (!r || tick < r.startTick || tick >= r.endTick) return { status: "unavailable", displayNumber: null };
  return { status: revision === m.revision ? "current" : "migrated", displayNumber: r.displayNumber };
}
