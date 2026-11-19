import { z } from "zod";
import { requireUser, userTeams } from "@/lib/access";
import { appOrigin, billing, customerFor, planFor, priceId, seatCount, stripe } from "@/lib/billing";
import { q1 } from "@/lib/db";
import { badRequest, body, conflict, forbidden, json, notFound, route } from "@/lib/http";

export const dynamic = "force-dynamic";

const Interval = z.enum(["month", "year"]).default("month");
const Req = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal"), interval: Interval }),
  z.object({ kind: z.literal("team"), teamId: z.string().min(1).max(64), interval: Interval }),
]);

/** Start a Stripe Checkout for a personal plan (for yourself) or a team plan (team owners only). */
export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  const p = await body(req, Req);
  let customer: string;
  let metadata: Record<string, string>;
  let back: string;
  if (p.kind === "personal") {
    if ((await planFor({ userId: user.id }))?.active) throw conflict("You already have a personal plan. Manage it from Billing.", "ALREADY_SUBSCRIBED");
    customer = await customerFor({ userId: user.id, email: user.email, name: user.name });
    metadata = { kind: "personal", userId: user.id };
    back = "/billing";
  } else {
    const me = (await userTeams(user.id)).find((t) => t.team_id === p.teamId);
    if (!me) throw notFound();
    if (me.role !== "owner") throw forbidden("Only a team owner can buy or change the team plan.");
    if ((await planFor({ teamId: p.teamId }))?.active) throw conflict("This team already has a plan. Manage it from Billing.", "ALREADY_SUBSCRIBED");
    const team = await q1<{ name: string }>("select name from teams where id = $1", [p.teamId]);
    customer = await customerFor({ teamId: p.teamId, teamName: team!.name });
    metadata = { kind: "team", teamId: p.teamId, purchasedBy: user.id };
    back = `/billing?team=${encodeURIComponent(p.teamId)}`;
  }
  const price = priceId(p.kind, p.interval);
  if (!price) throw badRequest(p.interval === "year" ? "Yearly billing is not offered yet." : "This plan is not available.", "NO_PRICE");
  // Per-seat team plans start at the current member count.
  const quantity = p.kind === "team" && billing.perSeat() ? await seatCount(p.teamId) : 1;
  const origin = appOrigin();
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price, quantity }],
    client_reference_id: p.kind === "personal" ? user.id : p.teamId,
    metadata,
    subscription_data: { metadata },
    allow_promotion_codes: true,
    success_url: `${origin}${back}${back.includes("?") ? "&" : "?"}checkout=success`,
    cancel_url: `${origin}${back}${back.includes("?") ? "&" : "?"}checkout=cancelled`,
  });
  return json({ url: session.url }, { status: 201 });
});
