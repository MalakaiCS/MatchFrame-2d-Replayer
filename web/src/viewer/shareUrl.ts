/**
 * Stable deep links: /replays/<id>?r=<round-id>&t=<round-ms>[#s=<share-token>]
 * The share token lives in the fragment, so it is never sent to the server in
 * the URL or logged; the client sends it in the X-Share-Token header.
 */
import type { Manifest, RoundSummary } from "@/shared/contract";

export const CANONICAL_ORIGIN = "https://2d.matchframe.tv";

export function buildReplayUrl(origin: string, replayId: string, roundId?: string, ms?: number, shareToken?: string | null): string {
  const u = new URL(`/replays/${encodeURIComponent(replayId)}`, origin);
  if (roundId) u.searchParams.set("r", roundId);
  if (ms !== undefined) u.searchParams.set("t", String(Math.max(0, Math.round(ms))));
  if (shareToken) u.hash = `s=${shareToken}`;
  return u.toString();
}

export function shareTokenFromHash(hash: string): string | null {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  const v = new URLSearchParams(h).get("s");
  return v && /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : null;
}

/**
 * Resolve ?r=&t= against the manifest. Malformed or out-of-range input is
 * clamped to a safe value: unknown round -> first round; time clamped into the round.
 */
export function resolveMoment(m: Manifest, r: string | null, t: string | null): { round: RoundSummary; tick: number; clamped: boolean } {
  let clamped = false;
  let round = m.rounds.find((x) => x.id === r);
  if (!round) {
    round = m.rounds[0];
    clamped = r !== null;
  }
  let tick = round.freezeEndTick ?? round.startTick;
  if (t !== null) {
    const ms = Number(t);
    if (Number.isFinite(ms) && ms >= 0) {
      tick = round.startTick + Math.round(ms / m.tickIntervalMs);
      if (tick >= round.endTick) {
        tick = round.endTick - 1;
        clamped = true;
      }
    } else clamped = true;
  }
  return { round, tick, clamped };
}
