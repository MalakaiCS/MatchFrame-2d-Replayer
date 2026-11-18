import { replayAccess } from "@/lib/access";
import { q, q1 } from "@/lib/db";
import { forbidden, json, route } from "@/lib/http";
import { newId, newToken, sha256 } from "@/lib/ids";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

async function owner(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const a = await replayAccess(req, id);
  if (a.via !== "owner") throw forbidden("Only the owner can manage link sharing.");
  return a;
}

export const GET = route(async (req: Request, ctx: Ctx) => {
  const a = await owner(req, ctx);
  const links = await q<{ id: string; created_at: string }>(
    "select id, created_at from share_links where replay_id = $1 and revoked_at is null order by created_at desc", [a.replay.id]);
  return json({ active: links.length > 0, links });
});

/** Create a read-only link. The token is returned once; only its SHA-256 hash is stored. */
export const POST = route(async (req: Request, ctx: Ctx) => {
  const a = await owner(req, ctx);
  const token = newToken();
  const link = await q1<{ id: string; created_at: string }>(
    "insert into share_links(id, replay_id, token_hash, created_by) values ($1,$2,$3,$4) returning id, created_at",
    [newId(), a.replay.id, sha256(token), a.user!.id]);
  return json({ id: link!.id, token, createdAt: link!.created_at }, { status: 201 });
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
