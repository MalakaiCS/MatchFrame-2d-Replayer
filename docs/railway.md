# Deploying Matchframe2D Replayer on Railway

**Status: PENDING.** The build environment had no Railway account or DNS access. Nothing has been deployed and `2d.matchframe.tv` is not configured. Follow these steps with project-owner access. Railway's UI changes often, so check each step against Railway's current docs.

## Topology

| Service | Source | Public? | Notes |
| --- | --- | --- | --- |
| `web` | this repo, `web/Dockerfile` | **yes**: custom domain `2d.matchframe.tv` | Next.js app and API. Runs migrations at start |
| `worker` | this repo, `worker/Dockerfile` | **no**: no domain, no TCP proxy | Awpy parser, job loop, maintenance. Scale replicas for throughput |
| `Postgres` | Railway PostgreSQL | **no** public TCP proxy | Reached over Railway's private network |
| Object storage | A Railway bucket, or any S3-compatible bucket (Cloudflare R2, AWS S3) | **private** bucket | Browsers upload with short-lived presigned PUT URLs. Reads always go through `web` |

## Steps

1. **Create the project** and add a PostgreSQL database. Remove or disable any public TCP proxy on the database so it is private-only.
2. **Create the bucket.** Use a Railway bucket if your plan offers one, otherwise R2 or S3.
   - Keep it private: no public read, no website hosting.
   - Note the endpoint, bucket name, access key and secret key.
   - Add a CORS rule so browsers can upload directly:

   ```json
   [
     {
       "AllowedOrigins": ["https://2d.matchframe.tv"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["content-type", "content-length"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   - Add a lifecycle rule that aborts incomplete multipart uploads after 1 day. This is a safety net; uploads use a single PUT.
3. **Add the `web` service** from the GitHub repo. Settings:
   - Root Directory: empty (repo root). Railway's Config as Code (`railway.json`) is deprecated and is not used.
   - Variable `RAILWAY_DOCKERFILE_PATH=web/Dockerfile`. Without it, Railway's automatic builder (Railpack) fails with "could not determine how to build the app".
   - Settings → Deploy: Healthcheck Path `/api/health`; Restart Policy "On Failure".
   - Variables:
     - `DATABASE_URL=${{Postgres.DATABASE_URL}}` (the private URL)
     - `APP_ORIGIN=https://2d.matchframe.tv`
     - Sign-ups are accepted from `APP_ORIGIN`, `https://2d.matchframe.tv`, and Railway's generated domain (picked up automatically from `RAILWAY_PUBLIC_DOMAIN`). Add other addresses with `TRUSTED_ORIGINS` (comma-separated). Any other origin gets "Invalid origin".
     - `AUTH_SECRET=<openssl rand -base64 48>`
     - `STORAGE_DRIVER=s3`
     - `S3_BUCKET`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` (the endpoint browsers can reach), `S3_REGION`
     - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
     - `MAX_DEMO_BYTES=1073741824` (1 GiB; BO3 archives are 300–600 MB)
     - `ALLOW_SIGNUP=1` (or `0` for invite-only)
     - Leave `MF_ALLOW_SYNTHETIC` unset.
4. **Add the `worker` service** from the same repo. Settings:
   - Root Directory: empty. Variable `RAILWAY_DOCKERFILE_PATH=worker/Dockerfile`.
   - Settings → Deploy: Restart Policy "Always"; no health check.
   - Variables: `DATABASE_URL`, the same `STORAGE_DRIVER`/`S3_*`/`AWS_*` values, and `MAX_DEMO_BYTES=1073741824`.
   - `WORKER_PARSE_MEMORY_BYTES=0`: rely on the service memory limit. The parser's virtual address space can exceed its real use.
   - `WORKER_RECORDED_RESERVE=0` (magazine-only ammo) needs **at least 4 GB RAM**; peak on a 548 MB demo was 2.3 GiB. `WORKER_RECORDED_RESERVE=1` (reserve shown like EDGE) needs about **12 GB RAM**.
   - Optional: `MAX_EXTRACTED_DEMO_BYTES` (default 1.5 GiB), `WORKER_MAX_TMP_BYTES` (default 4 GiB of temporary disk).
   - **Do not generate a domain** for the worker.
5. **Deploy** both services. The web container runs `scripts/migrate.mjs`, which is idempotent and advisory-locked, before starting.
6. **Custom domain**: in `web` → Settings → Networking, add `2d.matchframe.tv`. Railway shows the DNS records to create, typically a `CNAME` for `2d` pointing at the Railway target, and possibly a `TXT` verification record. Create exactly those records at the DNS provider for `matchframe.tv`. DNS names are case-insensitive; the product name keeps the casing "Matchframe2D Replayer".
7. **Verify**:
   - `curl -sI https://2d.matchframe.tv/api/health` returns 200 over valid HTTPS.
   - Sign up, upload a real `.dem`, and watch the worker logs for `published replay … rounds`.
   - In the browser network tab, the upload PUT goes to the bucket endpoint with no CORS error, and round payloads come from `2d.matchframe.tv/api/replays/<id>/rounds/rNN`.
   - Create a read-only link: it starts with `https://2d.matchframe.tv/replays/…#s=…` and opens in a private window. Revoke it, reload, and it is refused.
   - The worker and Postgres have no public domains.

## Operations

- **Scaling**: run several worker replicas safely. Jobs are claimed with `FOR UPDATE SKIP LOCKED` and leased (`WORKER_LEASE_SECONDS`, heartbeat every `WORKER_HEARTBEAT_SECONDS`).
- **Crashes and restarts**: an expired lease is reclaimed by another worker. A job that keeps crashing stops after `max_attempts` (5) with `WORKER_CRASH`.
- **Maintenance** runs inside the worker every `MAINTENANCE_EVERY_S` under an advisory lock. It expires stale upload slots, removes expired sources, and deletes abandoned revision prefixes.
- **Backups**: enable Railway Postgres backups. Bucket contents can be rebuilt only while sources are kept, so treat the bucket as primary data for published replays.


## Round links and AUTH_SECRET

Round links (one round, viewable without an account) use a token derived from the link id and
`AUTH_SECRET`. Keep `AUTH_SECRET` stable: rotating it signs everyone out and turns existing round
links off (new ones can be copied straight away). Run the migrations on deploy as usual; the
web service's start command already applies `004_round_share_links.sql`.

## Plans and Stripe (personal and team subscriptions)

Plans are off until you turn them on, so the site works before Stripe is set up.

1. In Stripe, create two products with a recurring price each: **Personal** and **Team**. Copy the
   price ids (`price_...`).
2. In Stripe → Developers → Webhooks, add an endpoint
   `https://2d.matchframe.tv/api/billing/webhook` with these events:
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,
   `customer.subscription.paused`, `customer.subscription.resumed`. Copy its signing secret (`whsec_...`).
3. In Stripe → Settings → Billing → Customer portal, turn the portal on (cancel, update card, invoices).
4. On the Railway **web** service, set the variables below, then redeploy:

   | Variable | Value |
   |---|---|
   | `STRIPE_SECRET_KEY` | `sk_live_...` (or `sk_test_...` while testing) |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_...` from step 2 |
   | `STRIPE_PRICE_PERSONAL` | the Personal price id |
   | `STRIPE_PRICE_TEAM` | the Team price id |
   | `BILLING_ENABLED` | `1` when you are ready to require plans |
   | `TEAM_PLAN_MAX_MEMBERS` | optional member cap for team plans (`0` = none) |

What each plan covers:

- **Personal**: one account, everywhere (own library, uploads, replays shared with them, and any team they are in).
- **Team**: every member of that team, for the team library (upload to the team, open and review team
  replays and replays shared with the team). Members only need a free account. Only the team owner can buy
  or manage it.
- **Links**: read-only and round links are free to watch for anyone.
- Without a plan, a signed-in user can still delete their replays and revoke links.

Granting a plan by hand (partners, comps, testing), from the web service's shell (`railway ssh`, or
`railway run` locally with the production `DATABASE_URL`):

```bash
node scripts/grant-plan.mjs personal player@example.com --until 2027-01-31 --note "partner"
```

```bash
node scripts/grant-plan.mjs team "Harbour Esports"
```

```bash
node scripts/grant-plan.mjs list
```

```bash
node scripts/grant-plan.mjs revoke personal player@example.com
```

### Yearly and per-seat pricing (optional)

- **Yearly:** create a yearly recurring price for each product in Stripe and set
  `STRIPE_PRICE_PERSONAL_YEARLY` and/or `STRIPE_PRICE_TEAM_YEARLY`. The plans page then shows a
  Monthly / Yearly switch with the saving.
- **Per seat:** set `TEAM_PLAN_PER_SEAT=1` and make the Team price a per-unit price ("£X per member").
  Checkout starts at the team's member count (at least `TEAM_PLAN_MIN_SEATS`), and adding or removing
  members (by email, invite link or removal) updates the subscription quantity with proration.

## Resumable uploads

Files of 32 MiB or more upload in 16 MiB parts (S3 multipart) and can be resumed for 24 hours:
choosing the same file again after a dropped connection continues with the missing parts.

- The bucket's CORS rule must allow `PUT` from the site's origin (already needed for uploads).
  No extra exposed headers are needed: the server reads part ETags itself.
- The worker aborts expired multipart uploads. As a safety net, add a bucket lifecycle rule that
  aborts incomplete multipart uploads after 2 days, if your provider supports it.
- Tunables: `UPLOAD_MULTIPART_MIN_BYTES`, `UPLOAD_PART_BYTES` (at least 5 MiB), `RESUMABLE_UPLOAD_HOURS`.

## Anti-strat callouts

Defaults and per-player area reports use CS2 callouts, recorded by worker 0.3.0 and later. Demos
processed earlier still work with approximate places; re-process them (replay → Share → Re-process)
to get exact callouts.

## Anti-strat AI brief (optional)

The pattern finder (`/antistrat`) needs nothing extra. The "Write a game plan with AI" button and the
per-player "AI sheet" buttons appear only when `ANTHROPIC_API_KEY` is set on the web service.

- What is sent: the computed patterns for the team (shares, counts, spot labels, player names,
  rule-based counters). Demo files and positions are not sent.
- Model: `claude-opus-5-5` by default (`ANTISTRAT_MODEL` to change it). Requests opt into
  server-side refusal fallbacks (`server-side-fallback-2026-07-01`, `fallbacks: "default"`): if the
  model declines, the API re-runs the request on a fallback model in the same call, billed at that
  model's rates.
- Each click is one API call (typically a few thousand input tokens and up to ~2,000 output tokens).
  Briefs are not cached.
