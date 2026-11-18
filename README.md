# Matchframe2D Replayer

Browser-based CS2 demo viewer for Matchframe, intended for `https://2d.matchframe.tv`. Upload a CS2 demo, then review it on a 2D radar: rounds, players, bomb, utility, filters, bookmarks, notes, playlists, voice comms and share links.

> **Parity status: pending.** This build targets functional parity with the Skybox EDGE 2D Replayer, but no reference access, recordings or real demos were available. See [`docs/replayer-parity.md`](docs/replayer-parity.md) and [`docs/verification-report.md`](docs/verification-report.md).

## Layout

```
web/       Next.js 16 + TypeScript: UI, API routes, auth (Better Auth), Canvas 2D radar
worker/    Python worker: Awpy 3.3.0 parser, durable job loop, maintenance
db/        SQL migrations (applied by web/scripts/migrate.mjs)
docs/      Parity matrix, data contract, Railway, assets and licences, catalogue, verification report
```

Shared contract: `web/src/shared/contract.ts` (types) and `web/src/shared/maps.json` (map registry, also read by the worker).

## Local development

Requirements: Node 22, Python 3.11+ (3.13 tested), PostgreSQL 14+ (16 tested), `uv` or `pip`.

1. Create the database:

```bash
createdb matchframe
```

2. Configure the web app (copy `.env.example`, then set `DATABASE_URL`, `AUTH_SECRET` and an absolute `STORAGE_FS_ROOT`):

```bash
cp .env.example web/.env.local
```

3. Install web dependencies and apply migrations:

```bash
cd web && npm ci && npm run migrate
```

4. Start the web app:

```bash
cd web && npm run dev
```

5. In another terminal, set up the worker:

```bash
cd worker && uv venv .venv && uv pip install --python .venv/bin/python -e '.[test]'
```

6. Start the worker. Use the same values as the web app; `MF_ALLOW_SYNTHETIC=1` is for development only:

```bash
cd worker && DATABASE_URL=postgres://mf:mf@localhost/matchframe STORAGE_DRIVER=fs STORAGE_FS_ROOT=/abs/path/.data/objects MF_ALLOW_SYNTHETIC=1 .venv/bin/python -m matchframe_worker.main
```

7. Open http://localhost:3000, create an account and upload a `.dem` file.

Without a real demo, generate a **synthetic** fixture. The worker accepts it only when `MF_ALLOW_SYNTHETIC=1`:

```bash
cd worker && .venv/bin/python tools/export_fixture.py --demo-file /tmp/synthetic-mirage.dem '{"map": "de_mirage"}'
```

To inspect a real demo's parser output while calibrating:

```bash
cd worker && .venv/bin/python -c "from matchframe_worker.awpy_source import load; r = load('match.dem', sample_every=4); print(r.map_name, r.rounds, r.samples.columns, r.warnings)"
```

### Production-mode local run

`next build` produces `.next/standalone`. Run it with `node .next/standalone/server.js` (`next start` warns with `output: standalone`).

## Tests

```bash
cd worker && .venv/bin/python -m pytest -q
```

Unit tests (transform rules, filters, playback, clock, maps, share links, audio sync):

```bash
cd web && npx vitest run
```

API integration tests need the server and a worker running with `MF_ALLOW_SYNTHETIC=1`:

```bash
cd web && MF_BASE_URL=http://localhost:3000 npx vitest run
```

Browser end-to-end tests. Set `PW_CHROMIUM_PATH` to use a preinstalled Chromium:

```bash
cd web && MF_BASE_URL=http://localhost:3000 npx playwright test --trace off
```

## Deployment

See [`docs/railway.md`](docs/railway.md): a public web service, a private worker, private PostgreSQL and a private S3-compatible bucket.

## Stable URLs (for ANZCSHub and other integrations)

| URL | Meaning |
| --- | --- |
| `https://2d.matchframe.tv/replays` | Library |
| `https://2d.matchframe.tv/replays/<replay-id>` | Viewer (requires access) |
| `https://2d.matchframe.tv/replays/<replay-id>?r=<round-id>&t=<ms>` | Opens a round (`r05`) at a time (ms from the round start). Out-of-range values are clamped |
| `…#s=<token>` | Read-only link token (fragment only; never logged server-side) |
| `https://2d.matchframe.tv/playlists/<playlist-id>` | Playlist |

Replay IDs are opaque and stable. Round IDs (`r01`, `r02`, …) are stable for a given demo.
