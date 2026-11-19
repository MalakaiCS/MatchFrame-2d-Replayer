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
