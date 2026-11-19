import { z } from "zod";
import { requireUser } from "@/lib/access";
import { q } from "@/lib/db";
import { badRequest, body, json, route } from "@/lib/http";
import { parseSteamId } from "@/lib/steam";

export const dynamic = "force-dynamic";

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  const rows = await q<{ steam_id: string }>("select steam_id from user_steam_ids where user_id = $1 order by created_at", [user.id]);
  return json({ steamIds: rows.map((r) => r.steam_id) });
});

const Add = z.object({ steam: z.string().min(5).max(200) });

export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  const { steam } = await body(req, Add);
  const id = parseSteamId(steam);
  if (!id) {
    throw badRequest(
      /steamcommunity\.com\/id\//.test(steam)
        ? "Custom Steam links (/id/name) can't be looked up yet. Use the 17-digit SteamID64 or a /profiles/ link."
        : "Enter a 17-digit SteamID64 (starts with 7656119) or a steamcommunity.com/profiles/ link.",
      "BAD_STEAM_ID",
    );
  }
  const n = await q<{ n: number }>("select count(*)::int as n from user_steam_ids where user_id = $1", [user.id]);
  if ((n[0]?.n ?? 0) >= 5) throw badRequest("Up to 5 Steam accounts per user.");
  await q("insert into user_steam_ids(user_id, steam_id) values ($1,$2) on conflict do nothing", [user.id, id]);
  return json({ steamId: id }, { status: 201 });
});

export const DELETE = route(async (req: Request) => {
  const user = await requireUser(req);
  const id = new URL(req.url).searchParams.get("steamId") ?? "";
  await q("delete from user_steam_ids where user_id = $1 and steam_id = $2", [user.id, id]);
  return json({ ok: true });
});
