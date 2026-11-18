# Verification report: Matchframe2D Replayer

Date: 2026-11-18 · Branch: `claude/ecstatic-dijkstra-eem8d7`

## Verdict

**Functional parity with the Skybox EDGE 2D Replayer: NOT PASSED (pending).** The claim cannot be made yet:

1. **No reference access.** No authorised EDGE account, recordings or walkthroughs were available, and `skybox.gg` was unreachable from the build environment. Every reference-dependent row in [`replayer-parity.md`](replayer-parity.md) is still "publicly described" or "needs reference access", and none is "verified".
2. ~~No real CS2 demo.~~ **Resolved 2026-11-19**: 11 owner-supplied real GOTV demos all parse (see "Real-demo validation"). Comparison of these demos against the reference viewer is still pending.
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
- Any real demo, including catalogue demos. (POV demos are out of scope, per owner.)
- The "slow previous-round response" case. Stale fetches are aborted in code (`RoundCache.cancelExcept`), but no test throttles a single round.
- Audio drift against a real recording (not required, per owner).

## Real-demo validation (2026-11-19)

Owner-supplied demos via Google Drive: 7 tournament (`.rar`), 1 scrim (`.zip`) and 3 matchmaking (`.dem.bz2`), all GOTV. They are not committed. Regression tests are in `worker/tests/test_real_demos.py`.

| Demo | Map | Teams (clan tags) | Final | Halves | Rounds | Parse (load + transform) | Peak RSS | Round payload gz (min/med/max KB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Digital Crusade | Dust2 | BC.GAME vs WBT | 13–10 | 8:4; 5:6 | 23 | 13.9 + 8.0 s | 1000 MiB | 107 / 197 / 237 |
| Digital Crusade | Mirage | HYPERSPIRIT vs Iberian Soul | 5–13 | 4:8; 1:5 | 18 | 8.5 + 5.1 s | 718 MiB | 92 / 175 / 219 |
| Digital Crusade | Inferno | Iberian Soul vs Sashi Esport | 13–8 | 8:4; 5:4 | 21 | 12.2 + 6.7 s | 839 MiB | 59 / 180 / 263 |
| Digital Crusade | Ancient | INFINITE vs Basement Boys | 13–5 | 12:0; 1:5 | 18 | 8.9 + 5.0 s | 661 MiB | 86 / 150 / 216 |
| Digital Crusade | Nuke | Sashi Esport vs MOUZ NXT | 13–9 | 6:6; 7:3 | 22 | 10.6 + 6.5 s | 912 MiB | 80 / 175 / 234 |
| Digital Crusade | Cache | SAW vs ASTRAL | 13–7 | 10:2; 3:5 | 20 | 8.1 + 4.8 s | n/a | n/a |
| Digital Crusade | Anubis | SAW vs Bayankhongor | 13–1 | 11:1; 2:0 | 14 | 5.9 + 3.1 s | 522 MiB | 73 / 130 / 178 |
| Scrim (8PM) | Inferno | TEAM1 vs TEAM2 | 18–6 | 11:1; 7:5 | 24 | 10.9 + 6.2 s | 913 MiB | 77 / 173 / 231 |
| Matchmaking ×3 | Mirage | Team A vs Team B (no clan tags) | 18–6 · 15–9 · 7–17 | n/a | 24 each | ~10 + 7 s | 776–899 MiB | 63–91 / 133–163 / 208–247 |
| BLAST Rivals BO3, map 1 (**overtime**) | Ancient | FURIA vs Falcons | 16–14 | 7:5; 5:7; OT 4:2 | 30 | 17.8 s load | 2.3 GiB | n/a |
| BLAST Rivals BO3, map 2 (**starts at round 7**) | Dust2 | Falcons vs FURIA | 5–13 (seeded 4:2) | 5:7; 0:6 | 12 recorded | 11.9 s load | 1.6 GiB | n/a |
| CCT BO3, map 1 (**truncated**, 56 bytes) | Nuke | BAKS vs The Last Resort | 13–3 | 10:2; 3:1 | 16 | 6.7 s load | 1.0 GiB | n/a |
| CCT BO3, map 2 | Cache | The Last Resort vs BAKS | 4–13 | 1:11; 3:2 | 17 | 7.5 s load | 1.1 GiB | n/a |

Findings:

- **Every demo parsed.** Cache initially failed as `UNSUPPORTED_MAP`; it is now added to the registry.
- **Round reconstruction**:
  - No rounds were excluded.
  - Half scores and side swaps are consistent: team identity is stable across the halftime swap in all demos.
  - The clock is a countdown from the demo's convars (MM: 20 s freeze, 115.2 s round, 40 s bomb).
- **Buy classification** agrees with Awpy's own `round_economy` in 100% of 452 team-rounds (pistol = pistol, eco = eco, half buy = force, full buy = full).
- **Nuke floors**: about 12% of samples are assigned to the lower floor. The viewer's "Lower floor" mode marks upper-floor players as off-floor with ↑.
- **Radar calibration (2026-11-19, with radars installed)**: 99.91–100% of about 318,000 live-player positions from 7 real demos land on the radar's playable area (Mirage, Dust2, Inferno, Ancient, Anubis, Cache, and both Nuke floors at 100%). Registry values equal Valve's overview files. Tool: `worker/tools/radar_alignment.py`.
- **Through the real app**: `.rar` Nuke (234 MB, 363 MB extracted) went from upload to ready in 23.7 s. `.dem.bz2` Mirage (259 MB, 361 MB extracted) took 43.3 s. Worker parse took about 15 s with a peak child RSS of about 911 MiB.
- **Payload size** on real demos: median 130–197 KB per round (gzip). Time to interactive at 25 Mbps is estimated at under 0.5 s plus RTT, and still needs measuring on the deployed origin.

- **BO3 archives**: both real BO3 `.rar` uploads (596 MB and 294 MB) split into series of two replays each, with the map selector working in the viewer.
- **Ammo**: the clip is exact on real demos (AK 30, M4A1-S 20, AWP 5, falling shot by shot). The reserve is estimated; see data-contract.md#ammo.
- **Real-data bugs found and fixed**:
  - a round with no recorded start (crashed the transform);
  - a recording starting at round 7 (round numbers and score would have been wrong);
  - a truncated recording (rejected outright before);
  - corrupt gzip (would have retried forever);
  - the BLAST BO3 archive exceeding the 512 MiB upload cap (default raised to 1 GiB).
- **Peak worker memory** reached 2.3 GiB on the 548 MB overtime demo. Size the worker service accordingly (at least 4 GiB).

The two `.mp4` files in the folder are broadcast footage, not EDGE recordings. They were not used.

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
| 2 | Real-demo comparison with the reference | **Real demos now parse** (11/11). Overtime is now covered (FURIA vs Falcons, 16–14). Still needed: the same demos opened in EDGE to compare. Run `awpy_source.load` and compare rounds, scores, sides, event ticks and positions with the reference |
| 3 | Awpy adapter on real files | Column mapping follows the 3.3.0 guide. Check `bombsite`, grenade `type` values, raw `*_detonate` fields and `player_disconnect.xuid` |
| 4 | Parser memory cap | `WORKER_PARSE_MEMORY_BYTES` uses `RLIMIT_AS` (virtual memory). Confirm it does not kill a healthy Awpy parse, or set it to `0` and rely on the container limit |
| 5 | Map calibration and radar assets | Three landmarks per floor for each release map. Cleared radar images or Matchframe-original radars. Nuke floor routes |
| 6 | Smoke disruption | Inferred from HE detonations only. Compare shape and duration with the reference on an observed example |
| 7 | Map drawing / annotation tools | Not implemented: their existence and operations in the reference are unknown |
| 8 | Catalogue content | No licensed feed (see [`catalogue.md`](catalogue.md)) |
| 9 | Voice comms | Accepted formats, multi-track and channel behaviour, and alignment UI need the reference. (A measured drift test on a real recording is not required, per owner.) |
| 10 | Playback defaults | Speeds, seek steps, shortcuts, autoplay and freeze-skip defaults need the reference |
| 11 | Deployment | Railway project, private Postgres, bucket with CORS, the `2d.matchframe.tv` DNS records Railway issues, and HTTPS/CORS/share-origin checks ([`railway.md`](railway.md)) |
| 12 | Account flows | No email provider is configured, so there is no email verification or password reset. Rate limiting is Better Auth's per-instance in-memory limiter |
| 13 | Matchframe brand | No Matchframe design tokens or brand assets were in the repo. Replace the placeholder wordmark and tokens when available |
| 14 | Docker images | The Dockerfiles were not built here (no Docker daemon). The standalone bundle they package was verified |
| 15 | CI | `.github/workflows/ci.yml` mirrors the commands above but has not run on GitHub yet |
