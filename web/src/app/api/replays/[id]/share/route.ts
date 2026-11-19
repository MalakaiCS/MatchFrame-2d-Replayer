import { z } from "zod";
import { replayAccess } from "@/lib/access";
import { q, q1 } from "@/lib/db";
import { env } from "@/lib/env";
import { badRequest, forbidden, json, route } from "@/lib/http";
import { hmac, newId, newToken, sha256 } from "@/lib/ids";
import { loadManifest } from "@/lib/manifest";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

async function owner(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const a = await replayAccess(req, id);
  if (a.via !== "owner") throw forbidden("Only the owner can manage link sharing.");
  return a;
}

/**
 * Round-link tokens are derived from the link id with the server secret, so the same round
 * always gives the same link (it can be copied again later) while only a hash is stored.
 */
function roundToken(linkId: string) {
  return hmac(env.signingSecret(), `round-link:${linkId}`);
}

export const GET = route(async (req: Request, ctx: Ctx) => {
  const a = await owner(req, ctx);
  const links = await q<{ id: string; created_at: string; round_id: string | null }>(
    "select id, created_at, round_id from share_links where replay_id = $1 and revoked_at is null order by created_at desc", [a.replay.id]);
  return json({
    active: links.length > 0,
    links: links.map((l) => ({ id: l.id, createdAt: l.created_at, roundId: l.round_id })),
  });
});

const Create = z.object({ roundId: z.string().regex(/^r\d{2,3}$/).optional() }).strict();

/**
 * Create a read-only link. Without `roundId` it opens the whole replay and the token is returned
 * once. With `roundId` it opens only that round, can be created by anyone who manages the replay,
 * and is reused: asking again returns the same link until it is revoked.
 */
export const POST = route(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  // The body is optional: an empty POST creates a whole-replay link.
  const text = await req.text();
  let p: z.infer<typeof Create> = {};
  if (text.trim()) {
    try { p = Create.parse(JSON.parse(text)); } catch { throw badRequest("Expected {\"roundId\": \"rNN\"} or an empty body."); }
  }
  if (!p.roundId) {
    const a = await owner(req, ctx);
    const token = newToken();
    const link = await q1<{ id: string; created_at: string }>(
      "insert into share_links(id, replay_id, token_hash, created_by) values ($1,$2,$3,$4) returning id, created_at",
      [newId(), a.replay.id, sha256(token), a.user!.id]);
    return json({ id: link!.id, token, createdAt: link!.created_at }, { status: 201 });
  }
  const a = await replayAccess(req, id);
  if (a.via === "share" || !a.canManage) throw forbidden("Only the owner or a team coach can create round links.");
  const r = a.replay;
  const manifest = r.status === "ready" && r.published_prefix ? await loadManifest(r.published_prefix) : null;
  if (!manifest?.rounds.some((x) => x.id === p.roundId)) throw badRequest("That round is not in this replay.");
  const existing = await q1<{ id: string }>(
    "select id from share_links where replay_id = $1 and round_id = $2 and revoked_at is null", [r.id, p.roundId]);
  if (existing) return json({ id: existing.id, token: roundToken(existing.id), roundId: p.roundId });
  const linkId = newId();
  const token = roundToken(linkId);
  // A concurrent request may have created it first; the partial unique index keeps one active link per round.
  const made = await q1<{ id: string }>(
    `insert into share_links(id, replay_id, token_hash, created_by, round_id) values ($1,$2,$3,$4,$5)
     on conflict (replay_id, round_id) where round_id is not null and revoked_at is null do nothing returning id`,
    [linkId, r.id, sha256(token), a.user!.id, p.roundId]);
  if (made) return json({ id: linkId, token, roundId: p.roundId }, { status: 201 });
  const again = await q1<{ id: string }>(
    "select id from share_links where replay_id = $1 and round_id = $2 and revoked_at is null", [r.id, p.roundId]);
  return json({ id: again!.id, token: roundToken(again!.id), roundId: p.roundId });
});

/** Revoke every active link (or one, with ?linkId=). Subsequent reads with the token fail. */
export const DELETE = route(async (req: Request, ctx: Ctx) => {
  const a = await owner(req, ctx);
  const linkId = new URL(req.url).searchParams.get("linkId");
  await q(
    `update share_links set revoked_at = now() where replay_id = $1 and revoked_at is null ${linkId ? "and id = $2" : ""}`,
    linkId ? [a.replay.id, linkId] : [a.replay.id]);
  return json({ ok: true });
});
