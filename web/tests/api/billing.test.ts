/**
 * Plans: personal vs team coverage, Stripe checkout/portal/webhooks (against a local fake Stripe),
 * manual grants, and the member cap. Needs a server started with billing on:
 *
 *   BILLING_ENABLED=1 STRIPE_SECRET_KEY=sk_test_fake STRIPE_WEBHOOK_SECRET=whsec_test \
 *   STRIPE_PRICE_PERSONAL=price_personal STRIPE_PRICE_TEAM=price_team TEAM_PLAN_MAX_MEMBERS=3 \
 *   STRIPE_API_HOST=localhost STRIPE_API_PORT=12111 STRIPE_API_PROTOCOL=http \
 *   AUTH_RATE_LIMIT=0 npx next start -p 3001
 *   MF_BASE_URL=http://localhost:3000 MF_BILLING_BASE_URL=http://localhost:3001 npx vitest run tests/api/billing.test.ts
 */
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE = process.env.MF_BILLING_BASE_URL ?? "";
const FAKE_PORT = Number(process.env.STRIPE_FAKE_PORT ?? 12111);
const WHSEC = "whsec_test";
const run = Math.random().toString(36).slice(2, 8);

class Client {
  cookies = new Map<string, string>();
  email = "";
  id = "";
  constructor(public name: string, public share: string | null = null) {}
  async req(p: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers);
    headers.set("Origin", BASE);
    if (this.cookies.size) headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (this.share) headers.set("X-Share-Token", this.share);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(init.json);
    }
    const res = await fetch(BASE + p, { ...init, headers, body, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return res;
  }
  async json<T = any>(p: string, init: RequestInit & { json?: unknown } = {}, expectStatus?: number): Promise<T> {
    const r = await this.req(p, init);
    const t = await r.text();
    if (expectStatus !== undefined) expect(r.status, `${init.method ?? "GET"} ${p}: ${t}`).toBe(expectStatus);
    return (t ? JSON.parse(t) : null) as T;
  }
  async signup() {
    this.email = `${this.name}-${run}@example.test`;
    const r = await this.json("/api/auth/sign-up/email", { method: "POST", json: { email: this.email, password: "correct-horse-battery", name: this.name } }, 200);
    this.id = r.user.id;
    return this;
  }
}

// ---- fake Stripe: just enough of the API for checkout, portal, customers and prices
const calls: { method: string; path: string; body: URLSearchParams }[] = [];
let fake: Server;
let nCustomers = 0;
function startFake() {
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = new URLSearchParams(raw);
      const p = (req.url ?? "").split("?")[0];
      calls.push({ method: req.method ?? "", path: p, body });
      const send = (o: unknown, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json", "Request-Id": "req_fake" });
        res.end(JSON.stringify(o));
      };
      if (req.method === "POST" && p === "/v1/customers") return send({ id: `cus_${++nCustomers}_${run}`, object: "customer" });
      if (req.method === "POST" && p === "/v1/checkout/sessions") return send({ id: `cs_${calls.length}`, object: "checkout.session", url: `https://checkout.stripe.test/${calls.length}` });
      if (req.method === "POST" && p === "/v1/billing_portal/sessions") return send({ id: "bps_1", object: "billing_portal.session", url: "https://billing.stripe.test/session" });
      if (req.method === "GET" && p === "/v1/prices/price_personal") return send({ id: "price_personal", object: "price", unit_amount: 900, currency: "gbp", recurring: { interval: "month", interval_count: 1 } });
      if (req.method === "GET" && p === "/v1/prices/price_team") return send({ id: "price_team", object: "price", unit_amount: 4900, currency: "gbp", recurring: { interval: "month", interval_count: 1 } });
      send({ error: { type: "invalid_request_error", message: `fake stripe: no route ${req.method} ${p}` } }, 404);
    });
  });
  return new Promise<void>((r) => fake.listen(FAKE_PORT, "127.0.0.1", () => r()));
}

const stripeSdk = new Stripe("sk_test_fake");
let eventClock = Math.floor(Date.now() / 1000);
async function webhook(type: string, sub: Record<string, unknown>, opts: { created?: number; secret?: string } = {}) {
  const created = opts.created ?? ++eventClock;
  const payload = JSON.stringify({ id: `evt_${created}_${Math.random()}`, object: "event", type, created, data: { object: { object: "subscription", ...sub } } });
  const header = stripeSdk.webhooks.generateTestHeaderString({ payload, secret: opts.secret ?? WHSEC });
  return fetch(`${BASE}/api/billing/webhook`, { method: "POST", body: payload, headers: { "Stripe-Signature": header, "Content-Type": "application/json" } });
}
const subObj = (id: string, status: string, metadata: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  id, status, metadata, customer: "cus_x", cancel_at_period_end: false,
  items: { object: "list", data: [{ id: `si_${id}`, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] }, ...extra,
});

function synthetic(params: Record<string, unknown>) {
  return Buffer.concat([Buffer.from("MFSYNTH1"), Buffer.from(JSON.stringify(params))]);
}
async function upload(c: Client, teamId: string | null) {
  const data = synthetic({ map: "de_mirage", winners: "AB" });
  const slot = await c.json("/api/uploads", { method: "POST", json: { filename: "m.dem", size: data.length, teamId } }, 201);
  const url = /^https?:/.test(slot.upload.url) ? slot.upload.url : BASE + slot.upload.url;
  expect((await fetch(url, { method: "PUT", body: new Uint8Array(data), headers: slot.upload.headers })).status).toBe(200);
  const done = await c.json(`/api/uploads/${slot.uploadId}/complete`, { method: "POST", json: { teamId } }, 201);
  for (let i = 0; i < 90; i++) {
    const r = await c.json(`/api/replays/${done.replayId}`);
    if (r.replay?.status === "ready") return done.replayId as string;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error("processing timed out");
}

const alice = new Client("alice"); // personal plan
const tom = new Client("tom"); // team owner, no personal plan
const mia = new Client("mia"); // team member
const zed = new Client("zed");
const sam = new Client("sam");
let teamId = "";

describe.skipIf(!BASE)("plans", () => {
  beforeAll(async () => {
    await startFake();
    for (const c of [alice, tom, mia, zed, sam]) await c.signup();
    teamId = (await tom.json("/api/teams", { method: "POST", json: { name: `Plan team ${run}` } }, 201)).id;
    await tom.json(`/api/teams/${teamId}/members`, { method: "POST", json: { email: mia.email, role: "player" } }, 201);
  }, 60_000);
  afterAll(() => new Promise<void>((r) => (fake ? fake.close(() => r()) : r())));

  it("locks uploads for accounts without a plan and shows prices from Stripe", async () => {
    const b = await alice.json("/api/billing", {}, 200);
    expect(b.enabled).toBe(true);
    expect(b.access.canUse).toBe(false);
    expect(b.prices.personal).toEqual({ amount: 900, currency: "gbp", interval: "month", intervalCount: 1 });
    const r = await alice.json("/api/uploads", { method: "POST", json: { filename: "a.dem", size: 10 } }, 402);
    expect(r.error.code).toBe("SUBSCRIPTION_REQUIRED");
  });

  it("personal checkout carries the owner in metadata and reuses the Stripe customer", async () => {
    const c1 = await alice.json("/api/billing/checkout", { method: "POST", json: { kind: "personal" } }, 201);
    expect(c1.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const sess = calls.filter((c) => c.path === "/v1/checkout/sessions").at(-1)!.body;
    expect(sess.get("mode")).toBe("subscription");
    expect(sess.get("line_items[0][price]")).toBe("price_personal");
    expect(sess.get("subscription_data[metadata][kind]")).toBe("personal");
    expect(sess.get("subscription_data[metadata][userId]")).toBe(alice.id);
    const before = calls.filter((c) => c.path === "/v1/customers").length;
    await alice.json("/api/billing/checkout", { method: "POST", json: { kind: "personal" } }, 201);
    expect(calls.filter((c) => c.path === "/v1/customers").length).toBe(before);
    // Portal needs a customer, which alice now has.
    expect((await alice.json("/api/billing/portal", { method: "POST", json: { kind: "personal" } }, 201)).url).toContain("billing.stripe.test");
    expect((await zed.req("/api/billing/portal", { method: "POST", json: { kind: "personal" } })).status).toBe(400);
  });

  it("rejects webhooks with a bad signature and applies valid ones", async () => {
    expect((await webhook("customer.subscription.created", subObj(`sub_a_${run}`, "active", { kind: "personal", userId: alice.id }), { secret: "whsec_wrong" })).status).toBe(400);
    const noSig = await fetch(`${BASE}/api/billing/webhook`, { method: "POST", body: "{}" });
    expect(noSig.status).toBe(400);
    const ok = await webhook("customer.subscription.created", subObj(`sub_a_${run}`, "active", { kind: "personal", userId: alice.id }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).applied).toBe(true);
    const b = await alice.json("/api/billing", {}, 200);
    expect(b.personal.active).toBe(true);
    expect(b.personal.provider).toBe("stripe");
    expect(b.access.canUse).toBe(true);
    // A second checkout is refused while the plan is active.
    expect((await alice.req("/api/billing/checkout", { method: "POST", json: { kind: "personal" } })).status).toBe(409);
  });

  it("team plan: only the owner buys it, then every member can upload to and open team replays", async () => {
    expect((await mia.req("/api/billing/checkout", { method: "POST", json: { kind: "team", teamId } })).status).toBe(403);
    expect((await zed.req("/api/billing/checkout", { method: "POST", json: { kind: "team", teamId } })).status).toBe(404);
    await tom.json("/api/billing/checkout", { method: "POST", json: { kind: "team", teamId } }, 201);
    const sess = calls.filter((c) => c.path === "/v1/checkout/sessions").at(-1)!.body;
    expect(sess.get("line_items[0][price]")).toBe("price_team");
    expect(sess.get("subscription_data[metadata][teamId]")).toBe(teamId);

    // Before the webhook nobody on the team is covered.
    expect((await mia.req("/api/uploads", { method: "POST", json: { filename: "a.dem", size: 10, teamId } })).status).toBe(402);
    await webhook("customer.subscription.created", subObj(`sub_t_${run}`, "active", { kind: "team", teamId }));

    expect((await mia.req("/api/uploads", { method: "POST", json: { filename: "a.dem", size: 10, teamId } })).status).toBe(201);
    // The team plan does not cover a personal library.
    expect((await mia.req("/api/uploads", { method: "POST", json: { filename: "a.dem", size: 10, teamId: null } })).status).toBe(402);
    const teamReplay = await upload(tom, teamId);
    expect((await mia.req(`/api/replays/${teamReplay}`)).status).toBe(200);
    expect((await mia.req(`/api/replays/${teamReplay}/rounds/r01`)).status).toBe(200);
    const mb = await mia.json("/api/billing", {}, 200);
    expect(mb.access).toMatchObject({ personal: false, coveredTeams: [teamId], canUse: true });
    expect(mb.teams[0]).toMatchObject({ id: teamId, canManageBilling: false });
    expect(mb.teams[0].plan.active).toBe(true);
    // Tom has only the team plan: moving the team demo to his personal library would lock it, so it is refused.
    const moved = await tom.json(`/api/replays/${teamReplay}`, { method: "PATCH", json: { teamId: null, visibility: "private" } }, 402);
    expect(moved.error.code).toBe("SUBSCRIPTION_REQUIRED");
  }, 120_000);

  it("a personal replay shared with a team-plan member stays locked for them, but links are free", async () => {
    const own = await upload(alice, null);
    await alice.json(`/api/replays/${own}/grants`, { method: "POST", json: { email: mia.email } }, 201);
    const locked = await mia.json(`/api/replays/${own}`, {}, 402);
    expect(locked.error.code).toBe("SUBSCRIPTION_REQUIRED");
    const { token } = await alice.json(`/api/replays/${own}/share`, { method: "POST" }, 201);
    expect((await new Client("anon", token).req(`/api/replays/${own}`)).status).toBe(200);
  }, 120_000);

  it("an older webhook cannot undo a newer one; a lapsed owner can still delete", async () => {
    const own = await upload(alice, null);
    const t = ++eventClock + 100;
    await webhook("customer.subscription.deleted", subObj(`sub_a_${run}`, "canceled", { kind: "personal", userId: alice.id }), { created: t });
    const late = await webhook("customer.subscription.updated", subObj(`sub_a_${run}`, "active", { kind: "personal", userId: alice.id }), { created: t - 50 });
    expect((await late.json()).applied).toBe(false);
    expect((await alice.json("/api/billing", {}, 200)).personal.active).toBe(false);
    expect((await alice.req(`/api/replays/${own}`)).status).toBe(402);
    expect((await alice.req(`/api/replays/${own}`, { method: "DELETE" })).status).toBe(200);
    eventClock = t + 1;
  }, 120_000);

  it("the operator can grant and revoke a plan by hand", async () => {
    const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "postgres://mf:mf@localhost/matchframe" };
    const script = path.resolve(import.meta.dirname, "../../scripts/grant-plan.mjs");
    expect(execFileSync("node", [script, "personal", zed.email, "--note", "test"], { env }).toString()).toContain("granted a personal plan");
    expect((await zed.req("/api/uploads", { method: "POST", json: { filename: "a.dem", size: 10 } })).status).toBe(201);
    execFileSync("node", [script, "revoke", "personal", zed.email], { env });
    expect((await zed.req("/api/uploads", { method: "POST", json: { filename: "a.dem", size: 10 } })).status).toBe(402);
  });

  it("caps team size when TEAM_PLAN_MAX_MEMBERS is set", async () => {
    // tom + mia already; the cap in this test server is 3.
    await tom.json(`/api/teams/${teamId}/members`, { method: "POST", json: { email: zed.email, role: "viewer" } }, 201);
    const full = await tom.json(`/api/teams/${teamId}/members`, { method: "POST", json: { email: sam.email, role: "viewer" } }, 400);
    expect(full.error.code).toBe("TEAM_FULL");
    // Changing an existing member's role is not blocked by the cap.
    await tom.json(`/api/teams/${teamId}/members`, { method: "POST", json: { email: zed.email, role: "player" } }, 201);
  });
});
