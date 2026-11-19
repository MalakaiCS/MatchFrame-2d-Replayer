import type Stripe from "stripe";
import { applyStripeSubscription, billing, stripe } from "@/lib/billing";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

const HANDLED = new Set(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "customer.subscription.paused", "customer.subscription.resumed"]);

/**
 * Stripe webhook. The signature is checked against STRIPE_WEBHOOK_SECRET over the raw body before
 * anything is read. Subscription events carry the plan owner in metadata set at checkout.
 */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !billing.configured()) return json({ error: { code: "BILLING_NOT_CONFIGURED", message: "Stripe is not configured on this server." } }, { status: 503 });
  const sig = req.headers.get("stripe-signature");
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    if (!sig) throw new Error("missing signature");
    event = stripe().webhooks.constructEvent(raw, sig, secret);
  } catch {
    return json({ error: { code: "BAD_SIGNATURE", message: "Invalid signature." } }, { status: 400 });
  }
  if (!HANDLED.has(event.type)) return json({ received: true, ignored: event.type });
  try {
    const r = await applyStripeSubscription(event.data.object as Stripe.Subscription, event.created);
    return json({ received: true, ...r });
  } catch (e) {
    console.error("[billing] webhook failed:", event.type, e instanceof Error ? e.message : e);
    // 500 makes Stripe retry later.
    return json({ error: { code: "INTERNAL", message: "Could not apply the event." } }, { status: 500 });
  }
}
