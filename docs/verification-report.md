# Verification report: Matchframe2D Replayer

Date: 2026-11-18 · Branch: `claude/ecstatic-dijkstra-eem8d7`

## Verdict

**Functional parity with the Skybox EDGE 2D Replayer: NOT PASSED (pending).** The claim cannot be made yet:

1. **No reference access.** No authorised EDGE account, recordings or walkthroughs were available, and `skybox.gg` was unreachable from the build environment. Every reference-dependent row in [`replayer-parity.md`](replayer-parity.md) is still "publicly described" or "needs reference access", and none is "verified".
2. **No real CS2 demo.** Public demo sources were blocked and none was supplied. The Awpy adapter is written against the Awpy 3.3.0 dataset guide, but **it has not been run on a real `.dem`**. All end-to-end runs used the labelled SYNTHETIC fixture generator.
3. **Not deployed.** There was no Railway or DNS access. [`railway.md`](railway.md) gives the exact steps, marked pending.

The engineering vertical slice and the full workflow surface are implemented and pass their own tests on synthetic data. The parity audit, real-demo validation and deployment remain open.

## What was built

- **Web** (`web/`, Next.js 16, TypeScript):
  - Library: imports with statuses, search, map filter, catalogue tab, playlists.
  - Upload flow with client-side header checks and progress.
  - Replay workspace: Canvas 2D radar, timeline markers, transport controls, round strip with filters, a single dock (players, events, notes, bookmarks, playlists, comms), and a header with map, teams, score and Share.
  - Share dialog with moment links, revocable read-only links, team/user grants and deletion. Teams page and playlist page.
- **API**: every route in the brief's route contract, plus grants, teams, reprocess and audio streaming. Every manifest, payload, review and audio request is authorised. Responses carry `Cache-Control: private, no-store`. Share tokens arrive only via the `X-Share-Token` header and are stored as SHA-256.
- **Auth**: Better Auth 1.7.25 (email and password) with Matchframe team roles: owner, coach, analyst, player, viewer.
- **Worker** (`worker/`, Python 3.13, Awpy 3.3.0 pinned):
  - Durable PostgreSQL job queue: `SKIP LOCKED` claim, lease and heartbeat, exponential backoff, permanent vs transient failure classes, a crash ceiling, and a guarded publish that requires a valid lease and the matching revision.
  - Per-attempt object prefixes. A resource-bounded parse subprocess with a timeout. Streaming download with a size cap and a temporary-disk check.
  - Scheduled maintenance: expired upload slots, expired sources, abandoned prefixes.
- **Data contract** v1 ([`data-contract.md`](data-contract.md)): manifest, round summaries, columnar round payloads, events, bomb, grenades, effects with inferred smoke disruption, and capabilities.
- **Storage**: a local filesystem driver for development and an S3-compatible driver for production (presigned PUT with signed `Content-Length`; reads proxied).

## Test results (this environment)

| Suite | Command | Result |
| --- | --- | --- |
| Worker unit and transform (synthetic) | `cd worker && pytest -q` | **44 passed** |
| Worker job queue against PostgreSQL 16 | (included above) | lease reclaim, stale-worker publish blocked, superseded revision blocked, backoff, crash ceiling, worker restart, cleanup, maintenance: **pass** |
| Web unit (playback determinism, clock, filters, maps, share URLs, audio sync) | `cd web && npx vitest run` | **28 passed** |
| API integration, fs storage | `MF_BASE_URL=http://localhost:3000 npx vitest run` | **25 passed** |
| API integration, S3 storage (moto 5.2.5 emulator) | `MF_BASE_URL=http://localhost:3001 npx vitest run` | **25 passed** |
| Browser E2E (Chromium) | `npx playwright test --trace off` | **4 passed** |
| Type check and production build | `npx tsc --noEmit`, `npx next build` | pass |
| Standalone server bundle | `node .next/standalone/server.js` + `scripts/migrate.mjs` | migrations applied; health 200 |

Brief acceptance scenarios covered on **synthetic** data:

- Async upload, parse and open of all rounds.
- POV partial coverage.
- Multi-floor map (Nuke floors).
- Overtime, and stable team identity through halftime and OT swaps.
- A kill click lands on the recorded tick.
- Identical frames for forward, backward and random seeks, including bomb state, simultaneous utility, overlay expiry and smoke disruption.
- Pistol, gun and combined filters with original round IDs preserved, plus empty and unknown-economy cases.
- Bookmark, note and playlist create, edit, reorder (including a concurrent race), reopen and delete, with cross-user isolation.
- Audio privacy for anonymous viewers, link viewers and teammates.
- Invalid demo, duplicate completion, worker restart, unsupported map, oversized upload.
- An expired lease cannot publish over a successful replacement.
- A copied link opens the selected moment in a clean session, and a revoked link fails on a fresh request.
- Narrow-screen layout.

Not covered:

- Anything against the reference.
- Any real demo, including real POV and catalogue demos.
- The "slow previous-round response" case. Stale fetches are aborted in code (`RoundCache.cancelExcept`), but no test throttles a single round.
- Audio drift against a real recording.

## Benchmark (synthetic, not representative of real-demo parsing)

| Item | Value |
| --- | --- |
| Device | 4 vCPU Intel Xeon @ 2.10 GHz, 15 GiB RAM, Linux; headless Chromium (Playwright 1.65, browser build 1243) |
| Network | Chrome DevTools throttling: 25 Mbps down / 10 Mbps up, 30 ms latency, cache disabled, against localhost |
| Demo | SYNTHETIC full match: 29 rounds (12–12 + 4–1 OT), 10 players, 16 Hz samples. Input file 31 bytes (parameters only) |
| Compressed round payloads | min 91 KB, median 113 KB, max 139 KB; 3.29 MB for the whole match |
| Processing (upload → ready) | 10.3 s wall; generation + transform 8.84 s in the parse subprocess; peak child RSS 483 MiB |
| Time to interactive playback (already processed replay, cold load) | 298–370 ms (3 runs). **Goal < 2 s: met on this setup** |
| Seek within a loaded round | ≤ 33.6 ms to painted frame (bounded by two 60 Hz frames). **Goal < 100 ms: met** |
| Next-round switch (idle prefetch) | 12 ms |

Payload size is about 4× above an ideal compact encoding: JSON with 0.1-unit quantisation, gzip level 6. It still meets the load goal. If real demos come out larger, delta-encode the columnar arrays first.

**Real-demo numbers are still needed**: Awpy parse duration and peak worker memory for a 100–300 MB GOTV demo, compressed round sizes, and time to interactive on the deployed origin.

## Defects found and fixed during verification

- Next.js stripped the route's `Content-Encoding: gzip` and recompressed, giving double-gzipped payloads. Payloads are now served as explicit gzip bytes (`X-Content-Format: application/json+gzip`) and decompressed with `DecompressionStream`.
- AWS SDK v3 presigned PUT URLs carried a CRC32 of an empty body (`x-amz-checksum-crc32=AAAAAA==`), which S3-compatible stores reject. Fixed with `requestChecksumCalculation: "WHEN_REQUIRED"`.
- A workspace grid overflow let the stage cover the dock tabs. Fixed with constrained grid and flex sizing.
- Inventory changes were emitted grouped by player, not by tick. They are now sorted, and the client no longer assumes order.
- A revoked or forged share token returned 401 (sign-in prompt). It now returns 404 ("link revoked or unavailable").

## Unresolved workflows and dependencies

| # | Item | Blocker / next step |
| --- | --- | --- |
| 1 | Reference audit (all "needs reference access" rows) | Full-access EDGE account or owner recordings. Fill observation date, tier and steps per row |
| 2 | Real-demo validation | Permitted GOTV demos (Mirage, Dust II, Nuke, one OT, one scrim) and one POV. Run `awpy_source.load` and compare rounds, scores, sides, event ticks and positions with the reference |
| 3 | Awpy adapter on real files | Column mapping follows the 3.3.0 guide. Check `bombsite`, grenade `type` values, raw `*_detonate` fields, `player_disconnect.xuid` and the GOTV/POV detection from `client_name` |
| 4 | Parser memory cap | `WORKER_PARSE_MEMORY_BYTES` uses `RLIMIT_AS` (virtual memory). Confirm it does not kill a healthy Awpy parse, or set it to `0` and rely on the container limit |
| 5 | Map calibration and radar assets | Three landmarks per floor for each release map. Cleared radar images or Matchframe-original radars. Nuke floor routes |
| 6 | Smoke disruption | Inferred from HE detonations only. Compare shape and duration with the reference on an observed example |
| 7 | Map drawing / annotation tools | Not implemented: their existence and operations in the reference are unknown |
| 8 | Catalogue content | No licensed feed (see [`catalogue.md`](catalogue.md)) |
| 9 | Voice comms | Accepted formats, multi-track and channel behaviour, and alignment UI need the reference. Drift on a real recording with a known sync point is unmeasured |
| 10 | Playback defaults | Speeds, seek steps, shortcuts, autoplay and freeze-skip defaults need the reference |
| 11 | Deployment | Railway project, private Postgres, bucket with CORS, the `2d.matchframe.tv` DNS records Railway issues, and HTTPS/CORS/share-origin checks ([`railway.md`](railway.md)) |
| 12 | Account flows | No email provider is configured, so there is no email verification or password reset. Rate limiting is Better Auth's per-instance in-memory limiter |
| 13 | Matchframe brand | No Matchframe design tokens or brand assets were in the repo. Replace the placeholder wordmark and tokens when available |
| 14 | Docker images | The Dockerfiles were not built here (no Docker daemon). The standalone bundle they package was verified |
| 15 | CI | `.github/workflows/ci.yml` mirrors the commands above but has not run on GitHub yet |
