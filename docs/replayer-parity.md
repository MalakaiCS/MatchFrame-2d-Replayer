# Matchframe2D Replayer: reference parity matrix

**Parity claim: PENDING. Functional parity with the Skybox EDGE 2D Replayer has not been demonstrated.**
No row is "verified". No material workflow has been compared against the reference.

## Audit status

| Item | Value |
| --- | --- |
| Reference product | Skybox EDGE 2D Replayer, full-access tier |
| Reference observation date | 2026-11-18/19: owner-provided screenshots (OBS-SHOT-01 to 06): team overview, match page, **one 2D Replayer view**, the replayer scoreboard with the setpos popover, player stats, and the tier table |
| Reference tier observed | Every screenshot shows a "Get Free Trial / Enjoy the Pro membership" prompt, so this is **probably the Core 2D Replayer tier**, not Full access (tier table: Tier 3 = Core, Tier 2 = Advanced, Tier 1 = Full access). Advanced and Full-access replayer features remain unobserved |
| Public sources consulted | The brief's summary of the official EDGE page and Skybox pricing. `skybox.gg` was **unreachable** from the build sandbox on 2026-11-18 (HTTP connect failed), so the public pages have not been re-read first-hand |
| Fixtures used | **11 real CS2 demos** supplied by the owner (Google Drive, 2026-11-19), all GOTV/SourceTV:

- 7 tournament demos (Digital Crusade S7) on Dust2, Mirage, Inferno, Ancient, Nuke, Cache and Anubis;
- 1 scrim on Inferno;
- 3 matchmaking demos on Mirage.

Also the deterministic SYNTHETIC generator for edge cases. Demos are not committed; see `worker/tests/test_real_demos.py` |
| Parser | Awpy 3.3.0 (pinned). Column mapping from the Awpy 3.3.0 dataset guide, **validated on the 11 real demos** (all parse; buy classes agree with Awpy's in 100% of team-rounds) |
| Matrix last updated | 2026-11-18 |
| Owner scope decisions (2026-11-18) | POV demos are out of scope; a voice-comms sample recording with a known sync point is not required |

### Evidence categories

- **verified**: observed in the reference (date, tier, steps recorded) and compared on the same permitted fixture.
- **publicly described**: named on the public EDGE page or pricing page (per the brief). The detailed behaviour is not yet observed.
- **needs reference access**: the behaviour or default cannot be established without the reference viewer.
- **Matchframe product choice**: specified by the brief or chosen by Matchframe. It is not a parity claim.

### Status columns

- **Impl.**: `done` / `partial` / `not started` / `blocked`.
- **Test**: test reference and result against Matchframe's own fixtures. A pass here is **not** a reference comparison.
- **Ref. compare**: the side-by-side result against the reference on the same fixture. This is `pending` everywhere.

### What is needed to close the audit

1. An authorised full-access EDGE account, or owner-provided screen recordings and walkthroughs, covering each row's "Open question".
2. At least three permitted real CS2 demos: one GOTV on each of Mirage, Dust II and Nuke. Also wanted: one with overtime, one scrim, and one public-catalogue demo. Run each through both viewers.

---

## 1. Open a demo

| ID | Feature | Reference source / observed steps | Expected result | Conditions | Evidence | Impl. | Test | Ref. compare | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OPEN-01 | Upload a CS2 demo | Not observed | Upload, processing and ready states shown; replay opens | GOTV demos | publicly described (public and POV demos) | done | `api.test.ts`, `viewer.spec.ts` (synthetic); **real `.rar` (Nuke, 234 MB → ready in 23.7 s) and `.dem.bz2` (Mirage MM, 259 MB → 43.3 s) uploaded through the UI**: pass | pending | Which formats does EDGE accept (`.dem` only, `.dem.gz`, `.zip`, `.bz2`)? What is the size limit? |
| OPEN-02 | Size limit | Not observed | Configurable cap, default 512 MiB (`MAX_DEMO_BYTES`). Rejected before upload with the size in MiB | all | Matchframe product choice (brief default) | done | `api.test.ts` "rejects oversized…": pass | pending | The reference limit |
| OPEN-03 | Compressed uploads | n/a | `.dem.bz2` (Valve matchmaking), `.dem.gz`, `.zip` and `.rar` (tournaments/scrims) with exactly one `.dem` are extracted by the worker. Extraction is size-capped (`MAX_EXTRACTED_DEMO_BYTES`, 1.5 GiB) and never uses member paths. Multiple demos → `ARCHIVE_MULTIPLE_DEMOS`; damaged → `ARCHIVE_CORRUPT`. `.7z/.xz/.zst/.tar` are refused | real-world distribution formats | Matchframe product choice (owner's demos arrive in these formats) | done | `test_archive.py`, `test_jobs.py::test_compressed_upload_is_extracted_and_parsed`, real uploads: pass | pending | Which formats does the reference accept? Should a multi-demo archive create a series? |
| OPEN-04 | CS:GO (Source 1) demo | Not observed | Rejected: "This is a CS:GO demo" (`LEGACY_DEMO`) | `HL2DEMO` header | Matchframe product choice | done | `test_header.py`, `test_jobs.py`: pass | pending | Does the reference support CS:GO? (Out of scope unless verified) |
| OPEN-05 | Invalid or corrupt demo | Not observed | Finalise rejects files without the `PBDEMS2` header. Parser failures become `PARSE_ERROR` and are not retried | all | Matchframe product choice | done | `api.test.ts`, `test_jobs.py`: pass | pending | Reference error wording and recovery path |
| OPEN-06 | POV demo | n/a | **Out of scope (owner decision, 2026-11-18).** Existing POV handling (partial-coverage badge, unknown players) is kept but not validated or required for release | POV recordings | Matchframe product choice | partial (not required) | `test_transform.py::test_pov_partial_coverage` (synthetic): pass | n/a | n/a |
| OPEN-07 | Duplicate finalisation | n/a | The second call returns the same replay. One job only | all | Matchframe product choice | done | `api.test.ts` "finalisation is idempotent"; `test_jobs.py::test_duplicate_enqueue_is_idempotent`: pass | n/a | n/a |
| OPEN-08 | Source expiry and re-upload | n/a | The source is deleted after a successful parse. Failed or pending sources expire (default 3 days). `SOURCE_MISSING` shows a re-upload path | all | Matchframe product choice | done | `test_jobs.py::test_missing_source_asks_for_reupload`: pass | n/a | n/a |
| OPEN-09 | Multipart demos | Not observed | Not supported | n/a | needs reference access | not started | n/a | pending | Does EDGE join split recordings? (Awpy 3.3.0 supports multipart input) |

## 2. Find match replays

| ID | Feature | Reference source / observed steps | Expected result | Conditions | Evidence | Impl. | Test | Ref. compare | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LIB-01 | Library of private uploads with statuses | Not observed | Lists own, team, granted and entitled catalogue replays with Queued/Processing/Ready/Failed status. Polls while processing | n/a | Matchframe product choice | done | `api.test.ts` "team grant…" (library listing): pass | pending | Reference library layout, sort order and columns |
| LIB-02 | Search and map filter | Not observed | Text search over title, teams, file and map. Map dropdown | n/a | Matchframe product choice | done | Manual, via UI | pending | Reference search fields |
| LIB-03 | Public / competition catalogue | Not observed | Catalogue tab lists entries with provider, licence and entitlement. Locked entries show no replay id | Licensed feeds only | publicly described (public demos) | partial | `api.test.ts` covers access rules; **no catalogue content exists** | pending | Which competitions does EDGE cover? **Matchframe has no licensed feed yet** (see `docs/catalogue.md`) |
| LIB-04 | Series map selection | Not observed | Replays sharing a `seriesId` show a map selector in the workspace header | Series uploads | needs reference access | done | Manual, via UI | pending | How does the reference group a series and pick maps? |
| LIB-05 | Playlists in the library | Not observed | Playlists tab with search and create | n/a | publicly described (playlists) | done | `api.test.ts` "playlists": pass | pending | Reference playlist list behaviour |

## 3. Navigate match and rounds

| ID | Feature | Reference source / observed steps | Expected result | Conditions | Evidence | Impl. | Test | Ref. compare | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NAV-01 | Header: map, teams, score, Share | Not observed | Map name, team names with side markers, score before the current round, final score, Share | all | Matchframe product choice (brief) | done | `viewer.spec.ts`: pass | pending | Does the reference show the score before or after the selected round? |
| NAV-02 | Round strip with winner and number | Not observed | One chip per playable round: number, winner side shape (CT circle / T triangle), P/OT tags, gap at half boundaries | all | Matchframe product choice | done | `viewer.spec.ts`: pass | pending | n/a |
| NAV-03 | Stable team identity through side swaps | n/a | Team A = CT in round 1. Each later round is assigned by majority vote of known players, with an expected-swap fallback (logged) | all | Matchframe product choice | done | `test_transform.py::test_stable_team_identity_through_side_swaps`: pass (synthetic) | pending (real demo) | Verify on a real demo with substitutes or reconnects |
| NAV-04 | Overtime | n/a | OT rounds flagged. Halves follow `mp_overtime_maxrounds`. Header half scores show "OT a:b" | MR12 + MR3 OT | Matchframe product choice | done | synthetic test, plus **real 16–14 overtime demo** (FURIA vs Falcons, Ancient: OT rounds 25–30, OT half starts 25 and 28, OT 4:2): pass | pending | Side rule at the regulation→OT boundary is a fallback only; on the real OT demo the majority vote decided every round |
| NAV-05 | Next/previous round | Not observed | Buttons and `[` `]`. Moves within the filtered list by actual match order | all | needs reference access | done | `viewer.spec.ts`: pass | pending | Reference shortcut keys |
| NAV-06 | Autoplay into next round | Not observed | On by default. At round end, continues into the next (filtered) round | all | needs reference access | done | Manual | pending | Reference default (on/off)? Does it skip post-round time? |
| NAV-07 | Freeze-time skip | Not observed | "Skip freeze time" toggle (off by default). `F` jumps to the freeze end | rounds with `freeze_end` | needs reference access | done | Manual | pending | Reference default |
| NAV-08 | Round boundaries | n/a | `[startTick, endTick)`, where `endTick` = next round's start (or official end + 1 for the last round). Warmup, pre-restart, incomplete and knife rounds are excluded | all | Matchframe product choice | done | `test_transform.py` boundary/restart/knife tests: pass (synthetic) | pending | Compare round count and boundaries with the reference on 3 real demos |
| NAV-10 | Rename teams on a match | OBS-SHOT-02 pencil icons | Pencil next to each team name. Edits are stored as overrides (`team_a_override`/`team_b_override`), survive reprocessing, and empty input restores the demo's name. Owner, or team owner/coach | all | verified (visible; behaviour not observed) | done | `api.test.ts` "team names": pass | pending | Who may rename in the reference? Is the rename per user or global? |
| NAV-11 | Per-half score breakdown | OBS-SHOT-02 "(12:0; 1:0)" | Header shows "(1st half; 2nd half; OT total)", each number coloured by that team's side | all | verified (visible) | done | visual (screenshot) | pending | How does the reference break down overtime? |
| NAV-12 | Back button and match-page entry | OBS-SHOT-02/03 | "‹ Back" to the library. The replayer opens from library rows (the reference opens from a match page) | all | verified (visible) | done | E2E | pending | n/a |
| NAV-09 | Event jumps | Not observed | `J`/`L` and buttons jump to the previous/next kill or bomb event at its exact tick | all | needs reference access | done | `viewer.test.ts` "event jumps land on recorded ticks": pass | pending | Which event types does the reference jump between? |

## 4. Play and seek

| ID | Feature | Reference source / observed steps | Expected result | Conditions | Evidence | Impl. | Test | Ref. compare | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PLAY-01 | Play/pause | Not observed | Button, Space, K | all | needs reference access | done | `viewer.spec.ts`: pass | pending | Reference keys |
| PLAY-02 | Scrubbing | Not observed | Range input over the round's ticks, with kill/bomb/freeze/bookmark markers | all | needs reference access | done | `viewer.spec.ts`: pass | pending | Does the reference scrub per round or per match? |
| PLAY-03 | Seek shortcuts | Not observed | ←/→ ±5 s. Shift+←/→ ± one sample (4 ticks). Home/End | all | needs reference access | done | `viewer.spec.ts`: pass | pending | **Reference step sizes** |
| PLAY-04 | Speeds | Not observed | 0.25×, 0.5×, 1×, 2×, 4×, 8×. `,`/`.` step through them | all | needs reference access | done | `viewer.spec.ts`: pass | pending | **Reference speed list** |
| PLAY-08 | Bomb segment on timeline | OBS-SHOT-03 | Shaded red "Bomb" region from the plant to the defuse/explosion (or round end) | rounds with a plant | verified (visible) | done | visual | pending | n/a |
| PLAY-05 | Phase clock | n/a | Freeze / round / post-plant countdown from convars and recorded ticks. Falls back to labelled elapsed time | all | Matchframe product choice | done | `viewer.test.ts` "clock": pass | pending | Compare clock readings at three ticks per phase against the reference |
| PLAY-06 | Deterministic seek | n/a | `frameAt(payload, tick)` is pure. Forward, backward and random seek orders give identical frames | all | Matchframe product choice (brief) | done | `viewer.test.ts` "deterministic seeking": pass | n/a | n/a |
| PLAY-07 | Interpolation | n/a | Positions are linearly interpolated, and yaw takes the shortest arc, only between compatible samples. Deaths, teleports, gaps over 2 samples and floor changes snap or hide | all | Matchframe product choice (brief) | done | `viewer.test.ts` "players": pass | pending | Visual smoothness vs reference |

## 5. Observe players and bomb

| ID | Feature | Reference source / observed steps | Expected result | Conditions | Evidence | Impl. | Test | Ref. compare | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OBS-01 | Players, names, view direction | Not observed | Circles coloured by side (CT cyan, T amber) with a view cone, a direction pointer and a name label (owner preference, 2026-11-19) | all | needs reference access | done | `viewer.spec.ts` screenshot (manual review) | pending | Reference marker semantics (numbers vs names) |
| OBS-02 | Alive/dead | n/a | Dead from the recorded kill tick. The death marker (×) persists for the round | all | Matchframe product choice (brief) | done | `viewer.test.ts`: pass | pending | n/a |
| OBS-03 | Selection and follow | Not observed | Click a marker or player row to select. "Follow selected player" centres the view | all | needs reference access | done | Manual | pending | Reference follow behaviour |
| OBS-04 | Pan and zoom | Not observed | Drag, wheel zoom about the cursor, ± buttons, `0` / double-click reset | all | needs reference access | done | `viewer.test.ts` "zooming keeps the cursor point fixed": pass | pending | n/a |
| OBS-05 | Player state fields | OBS-SHOT-03 (per-team scoreboards) | HP, armour/helmet, kit, bomb, active weapon, money, inventory (when the demo provides them), shown with CS2 equipment icons | GOTV | needs reference access | done | Manual | pending | **Which fields does the reference display?** |
| OBS-06 | Bomb state | n/a | carried / dropped (with position) / planting / planted (site, position) / defusing / defused / exploded. Exact location is omitted when unrecorded | all | Matchframe product choice (brief) | done | `test_transform.py::test_bomb_lifecycle`, `viewer.test.ts`: pass (synthetic) | pending | Verify against a real demo; Awpy has no defuse-begin position |
| OBS-07 | Multi-floor (Nuke) | n/a | Floor from the z threshold (`zMax −495` on Nuke) with a ±40-unit uncertainty band. Floor selector: other-floor players drawn hollow with ↑/↓ | Nuke, Vertigo | Matchframe product choice | partial | `test_transform.py::test_nuke_floors`, `viewer.test.ts`: pass | pending | **Thresholds unverified.** Validate routes between floors with real footage |

## 6. Inspect events and utility

| ID | Feature | Reference source / observed steps | Expected result | Conditions | Evidence | Impl. | Test | Ref. compare | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EVT-01 | Kill feed and click-to-seek | Not observed | In-radar kill feed (last 6 s of replay time, CS2 weapon and headshot/wallbang/smoke/blind/no-scope icons), Events tab and timeline markers. A click seeks to the recorded tick | all | needs reference access | done | `viewer.spec.ts` "kill click lands on the recorded tick": pass | pending | Event time alignment vs reference |
| EVT-02 | Plant/defuse/explosion events | Not observed | Listed with site and actor | all | needs reference access | done | `test_transform.py`: pass | pending | n/a |
| UTIL-01 | Grenade flight paths | Not observed | Recorded projectile positions only. Detonation-only grenades show no invented path | all | Matchframe product choice (brief) | done | `test_transform.py::test_detonation_only_fire_has_no_invented_path`: pass | pending | Reference grenade controls (filter by type/player?) |
| UTIL-02 | Smoke and fire areas | n/a | Configured estimates (smoke r=144, fire r=150), dashed and labelled "est." | all | Matchframe product choice | done | `test_transform.py`: pass | pending | Reference area shapes |
| UTIL-03 | Smoke break / dispersal | Not observed | HE detonation within (smoke r + 128) of an active smoke → disruption for 2.0 s, cut out of the smoke and labelled "inferred" | GOTV with HE events | publicly described (smoke breaking) | partial | `test_transform.py::test_smoke_disruption_inferred`, `viewer.test.ts`: pass | pending | **Data records only the HE detonation, not the cleared shape (inference).** Does the reference show bullet holes? What is its duration and shape? Compare on an observed example |
| UTIL-04 | Concurrent grenades | n/a | Two concurrent grenades from one player are never merged | all | Matchframe product choice (brief) | done | `test_transform.py::test_concurrent_grenades_same_thrower_not_merged`: pass | n/a | n/a |
| UTIL-05 | Utility layer toggles | Not observed | Layers menu: names, grenade paths, utility, death markers | all | needs reference access | done | Manual | pending | Reference toggles |

## 7. Filter rounds

| ID | Feature | Reference source / observed steps | Expected result | Conditions | Evidence | Impl. | Test | Ref. compare | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FILT-01 | Pistol rounds | Not observed | Regulation rounds 1 and maxRounds/2+1. Overtime rounds are never pistols | all | publicly described | done | `viewer.test.ts`, `viewer.spec.ts`: pass | pending | Does the reference count OT half starts as pistol? |
| FILT-02 | Gun rounds | Not observed | Every non-pistol round, including OT | all | publicly described | done | `viewer.test.ts`: pass | pending | **Is "gun round" the reference term for non-pistol, or for full buys?** |
| FILT-03 | Buy type | OBS-SHOT-05 vocabulary; categories confirmed by the project owner (2026-11-19) | Pistol (by round), then team equipment value at freeze end: Eco <$5k, Half buy $5k–$19,999, Full buy ≥$20k. Unknown values match only "Unknown" | demos with economy | needs reference access | done | `test_transform.py::test_buy_thresholds`, `viewer.test.ts`: pass | pending | Reference thresholds and labels |
| FILT-04 | Side, winner, overtime, bomb planted | Not observed | AND across categories, OR within a category | all | Matchframe product choice | done | `viewer.test.ts` "round filters": pass | pending | Which additional filters does the reference expose? |
| FILT-05 | Filtered navigation keeps the actual round and score | n/a | Original round IDs, numbers, ticks and scores are preserved. Focus stays on the filter control | all | Matchframe product choice (brief) | done | `viewer.test.ts`, `viewer.spec.ts`: pass | pending | n/a |

## 8. Review and collaborate

| ID | Feature | Reference source / observed steps | Expected result | Conditions | Evidence | Impl. | Test | Ref. compare | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| REV-01 | Bookmarks | Not observed | Create at the current tick (B), edit, delete, jump. Personal or team scope. Marker on the timeline | all | publicly described | done | `api.test.ts` "bookmarks and notes": pass | pending | Do reference bookmarks hold time ranges? Are they per user or per team? |
| REV-02 | Notes | Not observed | Create at the current tick (N), edit, delete, jump. Personal or team scope | all | publicly described | done | `api.test.ts`, `viewer.spec.ts`: pass | pending | Rich text? Mentions? Threading? |
| REV-03 | Playlists | Not observed | Create, rename, delete. Add the current moment with a label. Reorder (optimistic version, transactional). Play entry-to-entry across replays | all | publicly described | done | `api.test.ts` "playlists" including the concurrency test: pass | pending | Reference playlist item kinds (moment / round / range) and playback behaviour |
| REV-04 | Team access to review items | Not observed | Roles owner/coach/analyst/player/viewer. Team items require the team to have replay access. Unavailable entries never leak replay metadata | all | needs reference access | done | `api.test.ts`: pass | pending | Reference role model |
| REV-05 | Revision anchors | n/a | Anchors store replay, revision, round and tick. They migrate only when the round still contains the tick, otherwise they show as unavailable | reprocessed replays | Matchframe product choice (brief) | done | Code path covered by `anchorStatus`; no dedicated test yet | n/a | n/a |
| REV-06 | Map drawing / annotation | OBS-SHOT-03: hand (pan), pencil (draw), X (clear) | Pan/draw toggle (`D`), four pen colours, freehand strokes stored in radar-image coordinates (they follow pan and zoom), kept per round for the session, X clears the current round | all | verified (tools visible; behaviour not observed) | done | manual (screenshot) | pending | Are drawings saved or shared? Per round or per moment? Colours, shapes, eraser? |

## 9. Voice comms

| ID | Feature | Reference source / observed steps | Expected result | Conditions | Evidence | Impl. | Test | Ref. compare | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AUD-01 | Upload MP3 | Not observed | MP3 only (ID3 or MPEG frame header), ≤300 MiB, private storage | all | publicly described (voice comm integration) | done | `api.test.ts` "voice comms": pass | pending | **Reference accepted formats**; multiple tracks or channels? |
| AUD-02 | Sync to the playhead | n/a | The replay is the master clock. Audio time = (tick × tickInterval − offset). Drift tolerance 120 ms. Muted above 4×. Silent outside the recorded range | all | Matchframe product choice (brief) | done | `viewer.test.ts` "audio sync": pass | n/a | A measured drift test on a real recording is **not required** (owner decision, 2026-11-18) |
| AUD-03 | Alignment controls | Not observed | Offset nudges (±100 ms, ±1 s). "Align to this moment" from a typed audio time | all | needs reference access | done | Manual | pending | Reference alignment UI |
| AUD-04 | Audio permissions | n/a | Uploader and track team only. Hidden from read-only links unless "Include in read-only links" is set. Stream URLs are short-lived and re-authorised on every range request | all | Matchframe product choice (brief) | done | `api.test.ts`: pass | n/a | n/a |

## 10. Share review moments

| ID | Feature | Reference source / observed steps | Expected result | Conditions | Evidence | Impl. | Test | Ref. compare | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SHARE-01 | Link to a moment (`?r=&t=`) | n/a | Opens the round and time. Malformed input is clamped, with a notice | all | Matchframe product choice | done | `viewer.test.ts` "share links", `viewer.spec.ts`: pass | n/a | n/a |
| SHARE-02 | Revocable read-only link | n/a | Token in the `#s=` fragment, sent as the `X-Share-Token` header, stored as SHA-256. Revocation blocks the next request | all | Matchframe product choice (brief) | done | `api.test.ts` "read-only links", `viewer.spec.ts`: pass | n/a | n/a |
| SHARE-03 | Team share | Not observed | Owner grants teams or users by email | all | needs reference access | done | `api.test.ts`: pass | pending | **Reference share actions and team review flow** |
| SHARE-04 | Delete | n/a | Owner only. Access ends immediately. Cleanup job removes objects | all | Matchframe product choice (brief) | done | `api.test.ts` "deletion", `test_jobs.py::test_cleanup_job_removes_objects`: pass | n/a | n/a |

## 11. Maps

The release map list depends on the reference audit. All values are in `web/src/shared/maps.json`.

| ID | Map | Calibration | Landmark check (3 per floor) | Radar asset | Status / gap |
| --- | --- | --- | --- | --- | --- |
| MAP-01 | Mirage | Official overview (−3230, 1713), scale 5.0 | **verified**: 99.91% of 45,792 real positions on the playable area | shipped (cs2-map-icons) | Done |
| MAP-02 | Dust II | Official overview (−2476, 3239), scale 4.4 | **verified**: 99.96% of 57,207 | shipped | Done |
| MAP-03 | Nuke | Official overview (−3453, 2887), scale 7.0; lower floor z < −495 (official vertical sections) | **verified on both floors**: upper 100.00% of 48,441; lower 100.00% of 5,663 | shipped (upper + lower) | Done |
| MAP-04 | Inferno, Ancient, Anubis, Cache | Official overview values | **verified**: 99.96% / 99.96% / 100.00% / 100.00% of 47,324 / 38,732 / 28,677 / 45,952 | shipped | Done |
| MAP-06 | Overpass, Train, Vertigo | Official overview values; Train lower floor z < −50 and Vertigo lower floor z < 11700 (official vertical sections) | not yet: no real demo on these maps | shipped (incl. lower floors) | Needs one real demo per map |
| MAP-05 | Reference map list | Not observed | n/a | n/a | needs reference access: which maps does EDGE support? |

## 12. Accessibility and states

| ID | Feature | Expected result | Evidence | Impl. | Test |
| --- | --- | --- | --- | --- | --- |
| A11Y-01 | Side readable without colour | Owner chose colour-only circles (2026-11-19). Side is still given in text: team names in the scoreboard headers, kill feed and events, and aria labels | owner decision overrides brief | changed | Visual review |
| A11Y-02 | Shortcuts do not capture text input | Shortcuts are ignored in text fields and while a dialog is open | Matchframe product choice (brief) | done | `viewer.spec.ts`: pass |
| A11Y-03 | Labelled controls | Every icon button has an accessible name. Timeline markers describe the event. The scrubber has `aria-valuetext` | Matchframe product choice | done | `viewer.spec.ts` (role-based selectors) |
| A11Y-04 | Narrow screens | Map and playback stay visible. Round and filter strip collapsible | Matchframe product choice (brief) | done | `viewer.spec.ts` "narrow screen": pass |
| STATE-01 | Empty and error states | Library empty, catalogue empty, no rounds match, round load failure with retry, processing, failed with re-upload, revoked link | Matchframe product choice | done | `api.test.ts`, `viewer.spec.ts`: pass |

## Reference observations

Screenshots are used only to identify functionality. Nothing from their layout, styling or assets is copied.

### OBS-SHOT-01: EDGE team overview (owner screenshot, 2026-11-18, probably not the full-access tier)

Functional observations (text only):

- **Navigation**: Games → Matches; 2D Tools → 2D Replayer; Statistics → Player Stats, Leaderboards. A "Demo" button with an upload icon sits at the bottom of the sidebar, which is probably the demo upload entry point.
- **Steam integration banner**: "Connect your Steam account and enter your sharecode and authentication code to get matches fetched automatically", with a "Connect Steam" action. This suggests EDGE can import the user's own matchmaking demos automatically.
- **Team overview filters**:
  - Team selector, with a player-count chip ("8").
  - Map scope ("All maps") and side ("Both sides / CT / T").
  - Time window ("3 months") and sample size ("100 matches").
  - Own buy type ("All buys") and opponent buy type ("All buys", marked "OPP"), plus a generic "Filters" menu.
  - A copy-link button.
- **Comparison and summary**: "Comparing To" with a team set and "Edit Comparison". Totals for maps (59) and rounds (1308), and "Show Matches".
- **Per-map cards**: win rate, map count, recent results dots, 1st-pick and decider win rates, and 1st-pick, ban and played counts.
- **Per-player cards**: T and CT role labels (Pack, Lurk, Anchor, Rotation) with info and stat icons.

Scope assessment:

- The overview, statistics and leaderboard pages are **outside the 2D Replayer boundary** (team scouting and statistics) and are not planned.
- Two leads are relevant to the replayer and are added below as rows needing reference access: the Steam auto-import, and the own/opponent buy-type split for round filters.

### OBS-SHOT-02: EDGE match page (owner screenshot, 2026-11-18)

- **Header**:
  - Map name and both team names, each with a **pencil (rename) icon**.
  - Final score coloured per team, with a **per-half breakdown "(12:0; 1:0)"** coloured by side.
  - "Played on <date>".
- **"OPEN IN 2D REPLAYER" button**: the match page is the replayer's entry point.
- **Scoreboard per team**: role, HLTV rating, K/A/D, KD diff, K/D, ADR, KAST, UDR, opening duels and rounds played. Both sides / CT / T toggle. One player is marked with an "E" badge (meaning unknown).
- **Scope**: the scoreboard statistics are match analytics, outside the replayer boundary. The rename and half-score behaviour are implemented (NAV-10, NAV-11).

### OBS-SHOT-03: EDGE 2D Replayer, Train, round 1 (owner screenshot, 2026-11-19, probably Core tier)

- **Layout**: "Back" button at the top left. Radar centred. Two team scoreboard panels on the right, one per team, framed in that team's side colour. A tool row at the bottom left, a round selector, then the transport bar.
- **Radar**: player dots with **name labels in boxes**, and a bomb marker.
- **Scoreboard per player**:
  - Name in capitals.
  - **Ammo "clip/reserve"** (e.g. 30/120, 12/24, 20/120) next to primary and secondary weapon icons.
  - Health bar with the number in the side colour.
  - Armour icon and money.
  - Defuse-kit and bomb icons.
  - The team header shows the score.
- **Tool row**: settings (gear), keyboard (shortcuts), **hand (pan, selected)**, **pencil (draw)**, **X (clear drawings)**. A **"MULTI ROUND"** toggle is visible but greyed out (likely a higher-tier feature).
- **Round selector**: numbered rounds 1–13 with an underline coloured by the winning side. The current round is highlighted. A **dashed divider marks halftime** (between 12 and 13). Prev/next arrows.
- **Transport**: play button with a speed badge ("1x"), a stopwatch with the round clock "1:55" (countdown), and a timeline:
  - vertical event ticks coloured by side;
  - a **shaded red "Bomb" segment** from plant to round end, with a bomb icon at the plant and a defuse icon at the end.

### OBS-SHOT-04: replayer scoreboard, setpos popover (owner screenshot, 2026-11-19)

Next to a player row, a popover shows the in-game console command **"setpos 1594.838 -1434.9…"** (three decimals) with a copy button.

### OBS-SHOT-05: player stats page (owner screenshot, 2026-11-19)

- Statistics, out of scope.
- Relevant lead for FILT-03: EDGE's buy-type vocabulary includes **"Full Buy"**, **"Half Buy + Eco"** and **"Pistol Rounds"**. This suggests reference categories of Pistol / Eco / Half buy / Full buy, against Matchframe's Eco / Semi-eco / Semi-buy / Full.

### OBS-SHOT-06: EDGE tier table (owner screenshot, 2026-11-19)

| Feature | Tier 3 | Tier 2 | Tier 1 |
| --- | --- | --- | --- |
| 2D Replayer | Core | Advanced | Full access |
| Public demos & POV demos | Unlimited | Unlimited | Unlimited + full support |
| Filters across platform | Very limited | Limited | Full access |

Pattern Finder, Playbook & Match Prep and Veto simulation are separate products, out of scope. The brief targets **Tier 1 (Full access)**; the differences between the tiers are unknown.

### OBS-SHOT-07: same-demo comparison, EDGE vs Matchframe (owner screenshot, 2026-11-19)

Demo: owner's matchmaking Mirage demo (`mm1.dem`), round 3. EDGE's clock shows **1:25**, which Matchframe's countdown reads at freeze end + 30.2–31.2 s (tick 15576).

| Item | EDGE | Matchframe | Result |
| --- | --- | --- | --- |
| Score before round 3 | Team Alpha 1, Team Bravo 1 | 1 : 1 | **match** |
| Team names (no clan tags) | "Team Alpha" / "Team Bravo" | was "Team A"/"Team B" → **changed to "Team Alpha"/"Team Bravo"** | match after fix |
| Sides | Team Alpha CT | Team A(lpha) CT | **match** |
| Health, 10 players | spood 100, deqny 0, Kronk 0, OilyMexican 80, Mala 100; Lasty 0, Melon 0, sun 63, illu 100, ted3 100 | identical | **match** |
| Money, 10 players | 1900, 2850, 600, 3850, 2950; 150, 450, 400, 100, 0 | identical | **match** |
| Magazine, 6 alive players | 35, 13, 35; 13, 4, 6 | identical | **match** |
| Reserve, 6 alive players | 4, 3, 4; 2, 2, 3 (weapon entity `m_pReserveAmmo[0]`) | identical with `WORKER_RECORDED_RESERVE=1`; previously an estimate (90/80/…) that **did not match**, now removed | match (opt-in) |
| Kill feed | Melon→deqny; Kronk • deqny→Melon (assist shown); OilyMexican→-Lasty (headshot); sun→Kronk | same 4 kills, order and headshot; **assist added** to the feed | match after fix |
| Dropped bomb | C4 on the ground, upper right (A side) | C4 drawn at the same place | match (visual) |
| Bomb timeline segment | red "Bomb" span with plant icon and defuse icon | red "Bomb" span | match (visual) |

Additional reference behaviours seen (open):

- **Timeline**:
  - small triangles along the bottom edge, coloured by side (probably kills);
  - dashed light vertical lines (probably a time grid);
  - solid coloured lines (meaning unknown).
- **Round strip**: an orange clock-like icon under round 13 (possibly a tactical timeout or halftime marker).
- **Radar**:
  - a thin red line from a player (possibly a shot tracer or line of sight);
  - smokes drawn as textured clouds;
  - dead players as small dark dots rather than ×.
- **Scoreboard**: dead players are greyed out, right-aligned, and show 0 HP and money only.

## Features found in the reference but missing from the brief

| ID | Feature | Source | Evidence | Impl. | Open question |
| --- | --- | --- | --- | --- | --- |
| NEW-01 | Automatic match import via Steam (sharecode + game authentication code) | OBS-SHOT-01 banner | needs reference access | not started | Is this part of the 2D Replayer workflow or a platform feature? It needs Valve match-history API access and demo download from Valve replay servers |
| NEW-02 | Separate own vs opponent buy-type filters | OBS-SHOT-01 filter bar ("All buys", "OPP All buys") | needs reference access | partial: the round filters already pick the team for the buy filter (`buyTeam`) but cannot set both teams independently | Does the 2D Replayer's round list expose own and opponent buy filters? What buy categories does it list? |
| NEW-04 | Ammo (clip / reserve) per player | OBS-SHOT-03, **OBS-SHOT-07 (same demo)** | verified | **done**: magazine via demoparser2, matching EDGE on all players. Reserve = weapon entity `m_pReserveAmmo[0]`, matching EDGE exactly, behind `WORKER_RECORDED_RESERVE=1` because Awpy's entity scan needs about 6.6–10 GiB per demo. demoparser2 mis-decodes this field. Default: magazine only | Read the active weapon's `m_iClip1` and reserve through `demo.ticks(players_only=False)` on weapon entities, joined to the active-weapon handle. Needs a real demo to build and verify |
| NEW-07 | Multi-map archives (BO3 downloads) | owner's demos (2026-11-19) | Matchframe product choice | done: one replay per map, linked as a series with a map selector. Tested on 2 real BO3 `.rar` files | Does the reference import a series from one archive? |
| NEW-08 | Partial and truncated recordings | owner's demos (2026-11-19) | Matchframe product choice | done: real round numbers and scoreboard-seeded score for a recording starting at round 7; truncated tail ignored with a warning | How does the reference show a recording that starts mid-match? |
| NEW-09 | EDGE-style viewer layout | owner request "make the replays at least resemble Skybox EDGE" (2026-11-19) | OBS-SHOT screenshots of EDGE | done: radar with team scoreboards on the right (ammo, weapon, HP bar, armour, money, utility; dead players struck through), round bar of numbers underlined in the winner's side colour with a halftime divider, transport with play/speed badge, clock and a timeline showing a 10 s grid, side-coloured kill triangles and the bomb span; events/notes/bookmarks/playlists/comms moved to a Review drawer; soft smoke/fire clouds, boxed name tags and an optional muted radar. Matchframe branding kept; players are side-coloured circles with a view pointer | Exact EDGE spacing, fonts and icon set are not copied |
| NEW-10 | Round links | owner request "each round to contain its own link … share a certain round with everyone" (2026-11-19) | Matchframe product choice | done: "Round link" button in the round bar and in Share. The link opens one round for anyone without an account (other rounds and review data return 404). The owner or a team coach creates it; copying again returns the same link until "Revoke all links". Members without manage rights copy a plain link that needs access. Tests: `api.test.ts` round-link case, `viewer.spec.ts` round-link case | Round-link tokens are derived from the link id with AUTH_SECRET; rotating the secret turns existing round links off |
| NEW-11 | Public website and login gate | owner request "a massive front end website … with the 2D replayer behind it and the login screen" (2026-11-19) | Matchframe product choice | done: marketing site at "/" (hero, features, product tour with real screenshots, how it works, audiences, maps, privacy, FAQ, footer with Valve disclaimer); library, upload, teams and playlists redirect signed-out visitors to /login?next=…; replay pages send signed-out visitors without a valid link to /login. Tests: `api.test.ts` "website and login gate", `viewer.spec.ts` website case | No pricing, testimonials or usage numbers are shown because none exist yet |
| NEW-12 | Personal and team plans | owner request "teams subscriptions and personal subscriptions … teams anyone in a team can use it vs a personal subscription is only for the one person" (2026-11-19) | EDGE tier table screenshot | done: Stripe Checkout, billing portal and signed webhooks; personal plan covers one account everywhere, team plan covers every member for the team library; owner-only team billing; optional member cap; manual grants script; links stay free; enforcement behind BILLING_ENABLED. Tests: `tests/api/billing.test.ts` (8, against a fake Stripe) | Prices are set in Stripe, not in code |
| NEW-13 | Player stats per round | owner request "pick out the ones closest to Skybox EDGE" (2026-11-19) | EDGE player stats screenshot | done: worker 0.2.0 records K/D/A, ADR, KAST, HS, opening duels, trades, clutches, multi-kills, utility damage and flashes per round; cross-checked against Awpy (docs/data-contract.md) | Older replays need re-processing or re-upload |
| NEW-14 | Match stats page | as above | EDGE match page screenshot | done: /replays/<id>/stats with sortable player tables, team cards, economy chart and round history, filters by side and half | Rating uses the public HLTV 1.0 formula, not HLTV 2.x |
| NEW-15 | Team overview and opponent scouting | as above | EDGE team overview screenshot | done: /stats lists every named in-game team in your demos; /stats/team shows record, side/pistol/opening/clutch rates, per-map table, roster stats, matches and opponents (each opponent links to its own page) | Teams are grouped by name; demos with fallback names are left out until renamed |
| NEW-16 | Heatmaps and grenade lineup library | as above (ideas #3, #28, #29, #127, #129) | EDGE-style analysis | done: on the match page (per team) and the team overview (per map, across up to 30 demos): position, kill and death heatmaps filtered by side, time in round, player and floor; utility view clusters smokes/flashes/molotovs/HEs by landing spot with throw lines, use count, round win % and links to each throw. Built from published round data, so older demos work without re-processing | Lineups are grouped by landing spot (160 units), not by exact throw position |
| NEW-17 | Move demos between Personal and Team; team invite links | owner request (ideas #1, #66) | EDGE team workspace | done: a Move control on your own demos (Personal or any team you can upload to; refused when the destination is not covered by a plan); invite links per team with role and expiry, revocable, joining via /join/<token> (sign-up from the link works), member cap respected | Owners are still added by email, never by link |
| NEW-18 | Speed: priority processing and bulk upload | owner request (ideas #85, #291; #16 and #194 were already in place) | Matchframe product choice | done: jobs carry a priority (migration 009) and the worker claims higher priority first; uploads and re-processing by plan holders get priority when plans are on; series maps inherit it. The upload page queues up to 20 files, uploads them one at a time with per-file progress and follows each through processing | Resumable uploads (#292), parallel parsing (#97) and regional storage (#196) are not done |
| NEW-19 | Movement trails; AWP and round filters for heatmaps | ideas #2, #241, #243/#40 | EDGE-style analysis | done | — |
| NEW-20 | Round auto-tagging and round search | ideas #35, #36, #50 | EDGE-style analysis | done: /stats/rounds searches every demo you can open by map, team, side, result, plant site and tags (economy, T-side pace, opening duels, retake / post-plant, save), linking to each round | Fakes and set-play names are not detected |
| NEW-21 | Team trends, watchlist, tendencies and scouting report | ideas #39, #47, #43, #141 | EDGE team overview | done: team overview adds a trend chart (round difference and team rating per map), a tendencies panel (T-side pace and site split, post-plant and retake conversion, pistol/eco/half/full/anti-eco results, saves, opening duels), a Watch button (watched teams listed first on Stats with new-demo counts) and a Scouting report button that prints the page or saves it as PDF | Email alerts for watched teams are not sent |
| NEW-22 | Yearly and per-seat team billing | ideas #71, #271 | EDGE tier table | done: optional yearly prices with a Monthly / Yearly switch and saving; optional per-seat team pricing with the Stripe quantity following the roster (prorated). Tests: billing.test.ts | Prices are set in Stripe |
| NEW-23 | Clip export | idea #14 | EDGE-style review | done: Clip in the viewer's tool row records the radar (with score, round and clock burned in) as a WebM for 10/20/30 s or to round end, at the current speed, then downloads it; runs in the browser | DOM overlays (kill feed, scoreboards) are not in the video |
| NEW-24 | Compare two rounds | idea #12 | EDGE-style review | done: tick two rounds in Find rounds to open /replays/compare, two radars on one clock from freeze end with play, speed and scrubber | — |
| NEW-25 | Tactic boards | ideas #55, #56 | EDGE-style review | done: /tactics personal and team boards (players, utility at real size, bomb, labels, pen and arrows in four colours, floors), autosave with conflict detection; viewer "Board" copies the current positions, smokes, molotovs and bomb onto a new board | Animated boards (#54) are not done |
| NEW-05 | Multi-round mode | OBS-SHOT-03 (greyed toggle) | needs reference access (higher tier) | not started | What does it do: overlay several rounds, or play rounds back to back? Which tier? |
| NEW-06 | setpos copy | OBS-SHOT-04 | verified (visible) | done: selecting a player shows `setpos x y z` (3 decimals) with Copy | Does the reference also offer `setang`? Where exactly is it triggered (hover or click)? |
| NEW-03 | Copy-link button on filtered views | OBS-SHOT-01 link icon | needs reference access | done for the replayer (filters are kept in `?f=` and the moment in `?r=&t=`) | Does the replayer's link carry filters? |
