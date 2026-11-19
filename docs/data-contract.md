# Replay data contract (schema version 1)

Types: `web/src/shared/contract.ts`. Producer: `worker/matchframe_worker/transform.py`.
Versions recorded per replay: schema version, parser name and version, worker version, and map registry version.

## Time and ordering

- **Demo ticks** are authoritative for playback and event order.
- **Round window**: `[startTick, endTick)`. `endTick` is exclusive. It equals the next round's `startTick`, or the parser's official end + 1 for the last round. Post-round time therefore belongs to the round that just ended.
- **Round-relative milliseconds**: `round((tick − round.startTick) × tickIntervalMs)`, rounded half-up (`Math.round`). The inverse is clamped into the round.
- **Demo-time milliseconds** (used for audio alignment): `tick × tickIntervalMs`.
- **Event order within a tick**: a fixed type rank (freeze end < connections < throws < detonations < disruptions < bomb pickup/drop < plant/defuse begin < kill < plant < defuse < explode < round end), then source order. Each event gets an `order` index and a stable ID `"<round>:<tick>:<order>:<type>"`.

## Round selection

1. Rounds are reconstructed by the parser from game-rules state (Awpy `demo.rounds`).
2. Every round before the last match restart is excluded. A restart is detected when the round number does not increase.
3. Rounds with no decided tick or no winner are excluded as incomplete or reset.
4. Knife rounds are excluded: no player holds a firearm between freeze end and the decided tick.
5. Kept rounds get one-based display numbers `1..n` and IDs `r01`, `r02`, and so on.

## Team identity

- Team **A** is the side that is CT in the first kept round. Team **B** is the other side.
- Each later round: every already-assigned player present at freeze end votes for team A's side. The majority wins.
- On a tie, or when no known player is present, the expected-swap rule applies: halftime after `maxRounds/2`, and every `otMaxRounds/2` rounds in overtime, with no swap at the regulation→OT boundary. A warning is recorded. **This fallback is unverified against real demos.**
- New players are assigned at their first appearance by their side relative to team A.
- Player IDs: `s:<steamid64>` for humans. Bots and IDs that cannot be resolved use `b:<name>`. A reconnecting human keeps the same ID.
- Team names come from the majority clan tag (`team_clan_name`), otherwise `Team Alpha` / `Team Bravo` (as the reference names them). The source is recorded in `nameSource`.

## Round metadata

- `isPistol`: regulation rounds `1` and `maxRounds/2 + 1`. Overtime rounds are never pistols. The first round of each overtime half is flagged `isOvertimeHalfStart`.
- `economy[team].equipmentValue`: sum of `equipment_value` at the first sample at or after freeze end, or `null` when unavailable.
- `economy[team].buyType`: `pistol` if a pistol round, otherwise by value: `eco` < $5,000; `half_buy` $5,000–$19,999; `full_buy` ≥ $20,000 (categories set by the project owner to match the reference: Pistol, Eco, Half buy, Full buy). Replays processed earlier stored `semi_eco`/`semi_buy`/`full`; the viewer maps these to `half_buy`/`full_buy`. `null` when the value is unknown. The parser's own classification (Awpy: pistol/eco/force/full) is kept in `parserBuyType` for comparison.
- `coverage[playerId]`: samples present ÷ samples expected for the round window. It is `0` for players with no samples, which is the normal case for POV demos.

## Round filters

- Categories (type, buy, side, winner, overtime, bomb) combine with **AND**. Options within a category combine with **OR**. An empty category does not filter.
- Type: `pistol` = `isPistol`; `gun` = every other round.
- Buy: applies to the chosen team, or to either team. Pistol rounds never match a buy option. Unknown values match only `unknown`.
- Results are the original round objects, so IDs, display numbers, ticks and scores are unchanged.
- Filters are encoded in `?f=` (for example `k:gun;b:eco,unknown;bt:A`).

## Samples and interpolation

- Positions are sampled every `SAMPLE_EVERY_TICKS` (default 4 → 16 Hz on 64-tick demos) and quantised to 0.1 units.
- `disc[i] = 1` marks a discontinuity: the first sample, a gap over 2 sample intervals, movement faster than 1200 u/s (minimum 96 units), an alive-state change, or a floor change.
- The client interpolates only between consecutive samples that are both alive, on the same floor, with no discontinuity, within 2 sample intervals, and not across the player's recorded death. Yaw takes the shortest arc. A held sample is valid for 2 intervals; after that the player is hidden until data resumes.
- A recorded kill makes the victim dead from the kill tick, whatever the sampled health.

## Ammo

- **Clip** (`track.clip`): recorded. It is read with demoparser2 (`active_weapon_ammo`, pinned 0.42.2) at the same sample ticks, because Awpy 3.3.0 snapshots have no ammo fields. On real demos it counts down shot by shot and refills on reload.
- **Reserve** (`track.reserve`): the active weapon entity's recorded `m_pReserveAmmo[0]` (a small number, e.g. 4, 3, 2). This is exactly what the reference viewer displays, verified on a shared demo (OBS-SHOT-07).
  - It is read from Awpy's all-entity table joined on the player's active-weapon handle. That needs about 6.6 GiB for a 361 MB demo, so it is opt-in: `WORKER_RECORDED_RESERVE=1`, with `capabilities.reserveAmmo = "recorded"`.
  - When disabled, only the magazine is shown (`reserveAmmo = "none"`).
  - demoparser2's `m_pReserveAmmo` / `total_ammo_left` values are wrong for some weapons and are not used.
- `-1` means not applicable (melee, grenades, bomb) or unknown. The viewer shows `clip/reserve` (or just `clip`) next to the active weapon.

## Callouts (worker 0.3.0+)

- `track.place[i]` is an index into `payload.places` (CS2's own place names, e.g. `Apartments`, `BombsiteB`, `TopofMid`), or `-1` when unknown. It is CS2's `last_place_name`, read with demoparser2 in the same pass as the clip, at the sample ticks.
- Both fields are absent on replays processed before 0.3.0; re-process them to get callouts. The anti-strat tools then fall back to coarse labels (`A site`, `near B`, `between sites`).
- Insights (version 4) carry them as `pos.c` (index into `insights.places`). Spots without a sample (grenade landings, kills, plants) get the majority callout of nearby samples on the same level (`lib/areas.ts`, `Callouts.locate`).

## Partial and damaged recordings

- **Recording starts mid-match** (e.g. a GOTV restart): display numbers use the match's own round numbers (`r07`, "Round 7"), so pistol and overtime detection stay correct. The score before the first recorded round comes from the in-game scoreboard (`team_rounds_total`, via demoparser2). `capabilities.recordingStartsAtRound` records where the recording begins.
- **Round start not recorded**: the start is the freeze end minus `mp_freezetime`, or the first recorded tick.
- **Truncated recording** (file ends mid-command): if the decoder fails in the last 10% of the file, the incomplete tail is ignored, the demo is parsed, and a warning records how many bytes were dropped.
- **Score cross-check**: before every round, the computed score is compared with the scoreboard. Any mismatch adds a warning. On all 15 real demos there were no mismatches.

## Multi-map archives

A `.zip`/`.rar` with 2–7 `.dem` members (e.g. a BO3 download) becomes one replay per map in one series, ordered by member name (m1, m2, …):

- The uploaded replay keeps map 1. Maps 2..n get sibling replays (`<id>M<n>`), each with its own source object and parse job, the same owner, team and visibility, and the title "<title> · map n".
- Child IDs are deterministic, so a retried job never duplicates maps.
- The viewer's header shows a map selector for the series.

## Bomb

Bomb states come from Awpy bomb actions (`pickup`, `drop`, `start_plant`, `interrupt_plant`, `finish_plant`, `defuse`), the raw events `bomb_begindefuse`, `bomb_abortdefuse` and `bomb_exploded`, and the carrier flag on samples. An explosion with no event is inferred from the round-end reason and marked `provenance: inferred`. Positions are recorded only when the source has them. Defusing, defused and exploded states reuse the plant position.

## Utility

- **Projectiles**: one row per observed position from Awpy `grenades`, grouped by `(entity_id:serial, start_tick)` and split on gaps over 32 ticks. Two concurrent grenades from one player are never merged.
- **Effects**:
  - Smokes and fires use the Awpy intervals.
  - HE, flash and decoy detonations use raw `*_detonate` events and are shown for 0.5 s.
  - An effect links to its projectile by entity, otherwise by thrower, distance (≤ 250 u) and time (≤ 3 s).
  - A detonation with no projectile gets a grenade with an empty `path`, so no flight path is invented.
- **Areas**: smoke radius 144 u and fire radius 150 u are configured estimates (`radiusSource: configured-estimate`), drawn dashed and labelled "est.".
- **Smoke disruption** (inferred): an HE detonation within `smoke radius + 128 u` (with |Δz| ≤ 200 u) of an active smoke creates a 2.0 s disruption circle of radius 128 u at the HE position. Demos record only the HE detonation, not the cleared volume. The behaviour is therefore **inference**, labelled as such, and open in the parity matrix (UTIL-03).

## Capabilities

`manifest.capabilities` records what the demo supports. The viewer hides or disables controls that depend on data a demo lacks:

- `clock`: `countdown` only when round-time convars and freeze-end ticks exist; otherwise labelled elapsed time.
- `participants`: `partial` for POV demos with incomplete coverage.
- Per-field flags: `health`, `armor`, `money`, `inventory`, `economy`, `bombPosition`, `utilityPaths`, `utilityEffects`, `viewAngles`.
- `smokeDisruption`: `none` / `inferred` / `recorded`.
- `floors`: `single` / `rule-based`.

## Storage layout (private bucket)

```
uploads/<user>/<upload-id>.dem                    temporary source (deleted after a successful parse)
replays/<replay>/r<revision>/a<attempt>/manifest.json.gz
replays/<replay>/r<revision>/a<attempt>/rounds/rNN.json.gz
audio/<replay>/<track>.mp3
```

Each processing attempt writes to its own prefix. Publication is a conditional update that records the prefix and requires the job's lease to still be valid, so a stale worker cannot overwrite a replacement. Abandoned prefixes are removed by maintenance.


## Player stats (worker 0.2.0+)

Each round summary carries `playerStats`: one record per player who played the round
(`web/src/shared/contract.ts` → `PlayerRoundStats`, producer `worker/matchframe_worker/stats.py`).

| Field | Meaning |
|---|---|
| `k`, `d`, `a` | Enemy kills; deaths from any cause; assists, flash assists included |
| `fa` | Flash assists (also counted in `a`) |
| `hs` | Headshot kills |
| `tk` | Team kills (not in `k`) |
| `dmg` | Health damage to enemies until the round is decided. Each hit is capped at the victim's health left, tracked through the round from 100 |
| `ud` | The part of `dmg` from HE grenades and fire |
| `ef`, `fd` | Enemies flashed and their total blind time (seconds) |
| `ok`, `od` | Opening kill and opening death (the round's first kill) |
| `trk`, `trd` | Trade kills; traded death (the killer died to a teammate of the victim within 5 seconds) |
| `surv`, `kast` | Survived the round; KAST (kill, assist, survived or traded) |
| `cl`, `cw` | Clutch: enemies alive when the player became the last of their side (0 = none), and whether that side won |
| `eq` | Equipment value at freeze end |

Match figures in the viewer are sums over the rounds shown: ADR = `dmg` / rounds, KAST% = `kast` / rounds.

**Checks against real demos** (`worker/tools/stats_check.py`, compared with Awpy 3.3.0's match stats):
kills, deaths, headshots, opening kills and deaths, clutches played and won, utility damage and enemies
flashed match Awpy for every player on the demos checked; assists and traded deaths match for all but one
or two players. ADR differs by a few points: the parser's per-event "health before" value is unreliable
(it often repeats the round-start value), so Matchframe tracks each victim's health itself. With this
method, 132 of 136 players killed by an enemy on the Nuke demo took exactly 100 damage that round; the
other 4 were within 3 HP (fall damage).

Older replays have no `playerStats`. Re-parsing needs the original demo (`KEEP_SOURCE_AFTER_PARSE=1`
keeps it; otherwise upload the demo again). `web/scripts/reprocess-all.mjs` queues re-parses in bulk.

## Round tags (web/src/lib/roundTags.ts)

Tags are computed per round from one team's point of view, from the replay's insights:

| Tag | Rule |
|---|---|
| Pistol | Pistol round (rounds 1 and 13, and the first round of each half under other formats) |
| Eco / Half buy / Full buy | The team's buy type for the round (see Economy) |
| Anti-eco | The team full-bought against an eco |
| Fast plant / Execute / Late plant / No plant | T side only: planted < 35 s after freeze end, 35–70 s, after 70 s, or not at all |
| Retake won | CT side won by defusing |
| Post-plant won | T side planted and won |
| Save | The team lost and still had 2+ players alive when the round was decided |
| Opening kill / Opening death | The round's first kill was by / against the team |

Plant times on the search page are seconds after freeze end.
