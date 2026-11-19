import { z } from "zod";
import { requireUser, userTeams } from "@/lib/access";
import { appOrigin, stripe } from "@/lib/billing";
import { q1 } from "@/lib/db";
import { badRequest, body, forbidden, json, notFound, route } from "@/lib/http";

export const dynamic = "force-dynamic";

const Req = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal") }),
  z.object({ kind: z.literal("team"), teamId: z.string().min(1).max(64) }),
]);

/** Open Stripe's billing portal (change card, cancel, invoices) for your plan or your team's. */
export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  const p = await body(req, Req);
  if (p.kind === "team") {
    const me = (await userTeams(user.id)).find((t) => t.team_id === p.teamId);
    if (!me) throw notFound();
    if (me.role !== "owner") throw forbidden("Only a team owner can manage the team plan.");
  }
  const row = await q1<{ stripe_customer_id: string }>(
    `select stripe_customer_id from billing_customers where ${p.kind === "personal" ? "user_id" : "team_id"} = $1`,
    [p.kind === "personal" ? user.id : p.teamId]);
  if (!row) throw badRequest("There is no billing account yet. Subscribe first.", "NO_CUSTOMER");
  const session = await stripe().billingPortal.sessions.create({
    customer: row.stripe_customer_id,
    return_url: `${appOrigin()}/billing`,
  });
  return json({ url: session.url }, { status: 201 });
});
