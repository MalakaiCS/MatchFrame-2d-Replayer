# Matchframe2D Replayer: reference parity matrix

**Parity claim: PENDING. Functional parity with the Skybox EDGE 2D Replayer has not been demonstrated.**
No row is "verified". No material workflow has been compared against the reference.

## Audit status

| Item | Value |
| --- | --- |
| Reference product | Skybox EDGE 2D Replayer, full-access tier |
| Reference observation date | **None yet**: no reference session has taken place |
| Reference tier observed | **None**: no authorised account, recordings or walkthroughs were provided |
| Public sources consulted | The brief's summary of the official EDGE page and Skybox pricing. `skybox.gg` was **unreachable** from the build sandbox on 2026-11-18 (HTTP connect failed), so the public pages have not been re-read first-hand |
| Fixtures used | Deterministic **SYNTHETIC** match generator (`worker/matchframe_worker/synthetic.py`) on Mirage, Dust II and Nuke. **No real CS2 demo was available**: public demo hosts were blocked from the sandbox, and none was supplied |
| Parser | Awpy 3.3.0 (pinned). Column mapping is taken from the Awpy 3.3.0 dataset guide in its source distribution, not from a real demo run |
| Matrix last updated | 2026-11-18 |

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
2. At least three permitted real CS2 demos: one GOTV on each of Mirage, Dust II and Nuke. Also wanted: one with overtime, one scrim, one POV, and one public-catalogue demo. Run each through both viewers.
3. Radar images cleared for redistribution (or Matchframe-original radars), plus three landmark coordinates per floor for each released map.
4. A sample voice-comms MP3 with a known sync point for one of those demos.

---

## 1. Open a demo

| ID | Feature | Reference source / observed steps | Expected result | Conditions | Evidence | Impl. | Test | Ref. compare | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OPEN-01 | Upload an uncompressed CS2 `.dem` | Not observed | Upload, processing and ready states shown; replay opens | GOTV demos | publicly described (public and POV demos) | done | `api.test.ts` "upload and processing"; `viewer.spec.ts` "sign up, upload and process" (synthetic): pass | pending | Which formats does EDGE accept (`.dem` only, `.dem.gz`, `.zip`, `.bz2`)? What is the size limit? |
| OPEN-02 | Size limit | Not observed | Configurable cap, default 512 MiB (`MAX_DEMO_BYTES`). Rejected before upload with the size in MiB | all | Matchframe product choice (brief default) | done | `api.test.ts` "rejects oversized…": pass | pending | The reference limit |
| OPEN-03 | Compressed archives | Not observed | Rejected with "Extract the archive and upload the .dem file" | `.gz/.bz2/.zip/.rar/.7z/.xz/.zst` | Matchframe product choice | done | `test_header.py`, `api.test.ts`: pass | pending | Does the reference accept archives? If yes, add server-side extraction with bounded decompression |
| OPEN-04 | CS:GO (Source 1) demo | Not observed | Rejected: "This is a CS:GO demo" (`LEGACY_DEMO`) | `HL2DEMO` header | Matchframe product choice | done | `test_header.py`, `test_jobs.py`: pass | pending | Does the reference support CS:GO? (Out of scope unless verified) |
| OPEN-05 | Invalid or corrupt demo | Not observed | Finalise rejects files without the `PBDEMS2` header. Parser failures become `PARSE_ERROR` and are not retried | all | Matchframe product choice | done | `api.test.ts`, `test_jobs.py`: pass | pending | Reference error wording and recovery path |
| OPEN-06 | POV demo | Not observed | Opens with "POV · partial coverage" badge. Players without samples are shown as "unknown" | POV recordings | publicly described | partial | `test_transform.py::test_pov_partial_coverage` (synthetic): pass | pending | **No real POV demo tested.** GOTV/POV detection uses the header `client_name`; verify on real files |
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
| NAV-04 | Overtime | n/a | OT rounds flagged. Halves follow `mp_overtime_maxrounds` | MR12 + MR3 OT | Matchframe product choice | done | `test_transform.py::test_pistol_and_overtime_flags`: pass (synthetic) | pending | Side rule at the regulation→OT boundary is a **fallback only** and unverified |
| NAV-05 | Next/previous round | Not observed | Buttons and `[` `]`. Moves within the filtered list by actual match order | all | needs reference access | done | `viewer.spec.ts`: pass | pending | Reference shortcut keys |
| NAV-06 | Autoplay into next round | Not observed | On by default. At round end, continues into the next (filtered) round | all | needs reference access | done | Manual | pending | Reference default (on/off)? Does it skip post-round time? |
| NAV-07 | Freeze-time skip | Not observed | "Skip freeze time" toggle (off by default). `F` jumps to the freeze end | rounds with `freeze_end` | needs reference access | done | Manual | pending | Reference default |
| NAV-08 | Round boundaries | n/a | `[startTick, endTick)`, where `endTick` = next round's start (or official end + 1 for the last round). Warmup, pre-restart, incomplete and knife rounds are excluded | all | Matchframe product choice | done | `test_transform.py` boundary/restart/knife tests: pass (synthetic) | pending | Compare round count and boundaries with the reference on 3 real demos |
| NAV-09 | Event jumps | Not observed | `J`/`L` and buttons jump to the previous/next kill or bomb event at its exact tick | all | needs reference access | done | `viewer.test.ts` "event jumps land on recorded ticks": pass | pending | Which event types does the reference jump between? |

## 4. Play and seek

| ID | Feature | Reference source / observed steps | Expected result | Conditions | Evidence | Impl. | Test | Ref. compare | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PLAY-01 | Play/pause | Not observed | Button, Space, K | all | needs reference access | done | `viewer.spec.ts`: pass | pending | Reference keys |
| PLAY-02 | Scrubbing | Not observed | Range input over the round's ticks, with kill/bomb/freeze/bookmark markers | all | needs reference access | done | `viewer.spec.ts`: pass | pending | Does the reference scrub per round or per match? |
| PLAY-03 | Seek shortcuts | Not observed | ←/→ ±5 s. Shift+←/→ ± one sample (4 ticks). Home/End | all | needs reference access | done | `viewer.spec.ts`: pass | pending | **Reference step sizes** |
| PLAY-04 | Speeds | Not observed | 0.25×, 0.5×, 1×, 2×, 4×, 8×. `,`/`.` step through them | all | needs reference access | done | `viewer.spec.ts`: pass | pending | **Reference speed list** |
| PLAY-05 | Phase clock | n/a | Freeze / round / post-plant countdown from convars and recorded ticks. Falls back to labelled elapsed time | all | Matchframe product choice | done | `viewer.test.ts` "clock": pass | pending | Compare clock readings at three ticks per phase against the reference |
| PLAY-06 | Deterministic seek | n/a | `frameAt(payload, tick)` is pure. Forward, backward and random seek orders give identical frames | all | Matchframe product choice (brief) | done | `viewer.test.ts` "deterministic seeking": pass | n/a | n/a |
| PLAY-07 | Interpolation | n/a | Positions are linearly interpolated, and yaw takes the shortest arc, only between compatible samples. Deaths, teleports, gaps over 2 samples and floor changes snap or hide | all | Matchframe product choice (brief) | done | `viewer.test.ts` "players": pass | pending | Visual smoothness vs reference |

## 5. Observe players and bomb

| ID | Feature | Reference source / observed steps | Expected result | Conditions | Evidence | Impl. | Test | Ref. compare | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OBS-01 | Players, names, view direction | Not observed | CT circle / T triangle with view cone and name label | all | needs reference access | done | `viewer.spec.ts` screenshot (manual review) | pending | Reference marker semantics (numbers vs names) |
| OBS-02 | Alive/dead | n/a | Dead from the recorded kill tick. The death marker (×) persists for the round | all | Matchframe product choice (brief) | done | `viewer.test.ts`: pass | pending | n/a |
| OBS-03 | Selection and follow | Not observed | Click a marker or player row to select. "Follow selected player" centres the view | all | needs reference access | done | Manual | pending | Reference follow behaviour |
| OBS-04 | Pan and zoom | Not observed | Drag, wheel zoom about the cursor, ± buttons, `0` / double-click reset | all | needs reference access | done | `viewer.test.ts` "zooming keeps the cursor point fixed": pass | pending | n/a |
| OBS-05 | Player state fields | Not observed | HP, armour/helmet, kit, bomb, active weapon, money, inventory (when the demo provides them) | GOTV | needs reference access | done | Manual | pending | **Which fields does the reference display?** |
| OBS-06 | Bomb state | n/a | carried / dropped (with position) / planting / planted (site, position) / defusing / defused / exploded. Exact location is omitted when unrecorded | all | Matchframe product choice (brief) | done | `test_transform.py::test_bomb_lifecycle`, `viewer.test.ts`: pass (synthetic) | pending | Verify against a real demo; Awpy has no defuse-begin position |
| OBS-07 | Multi-floor (Nuke) | n/a | Floor from the z threshold (`zMax −495` on Nuke) with a ±40-unit uncertainty band. Floor selector: other-floor players drawn hollow with ↑/↓ | Nuke, Vertigo | Matchframe product choice | partial | `test_transform.py::test_nuke_floors`, `viewer.test.ts`: pass | pending | **Thresholds unverified.** Validate routes between floors with real footage |

## 6. Inspect events and utility

| ID | Feature | Reference source / observed steps | Expected result | Conditions | Evidence | Impl. | Test | Ref. compare | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EVT-01 | Kill feed and click-to-seek | Not observed | Events tab and timeline markers. A click seeks to the recorded tick | all | needs reference access | done | `viewer.spec.ts` "kill click lands on the recorded tick": pass | pending | Event time alignment vs reference |
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
| FILT-03 | Buy type | Not observed | Team equipment value at freeze end: eco <$5k, semi-eco <$10k, semi-buy <$20k, full ≥$20k. Unknown values match only "Unknown" | demos with economy | needs reference access | done | `test_transform.py::test_buy_thresholds`, `viewer.test.ts`: pass | pending | Reference thresholds and labels |
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
| REV-06 | Map drawing / annotation | Not observed | **Not implemented** | n/a | needs reference access | not started | n/a | pending | Does the reference have drawing tools? Which operations? |

## 9. Voice comms

| ID | Feature | Reference source / observed steps | Expected result | Conditions | Evidence | Impl. | Test | Ref. compare | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AUD-01 | Upload MP3 | Not observed | MP3 only (ID3 or MPEG frame header), ≤300 MiB, private storage | all | publicly described (voice comm integration) | done | `api.test.ts` "voice comms": pass | pending | **Reference accepted formats**; multiple tracks or channels? |
| AUD-02 | Sync to the playhead | n/a | The replay is the master clock. Audio time = (tick × tickInterval − offset). Drift tolerance 120 ms. Muted above 4×. Silent outside the recorded range | all | Matchframe product choice (brief) | done | `viewer.test.ts` "audio sync": pass | pending | **Drift not measured against a real recording with a known sync point** |
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
| MAP-01 | Mirage | Overview origin (−3230, 1713), scale 5.0 | **not done** | none shipped | Fixture map. Gap: landmark verification and a cleared radar image |
| MAP-02 | Dust II | (−2476, 3239), scale 4.4 | **not done** | none shipped | Fixture map. Same gaps |
| MAP-03 | Nuke | (−3453, 2887), scale 7.0, lower floor z < −495 | **not done** (both floors) | none shipped | Fixture map. Gaps: landmarks, floor routes, radar images for both floors |
| MAP-04 | Inferno, Ancient, Anubis, Overpass, Train, Vertigo | Values in the registry, status `unverified` | not done | none | Parses and renders on the grid. Not part of the verified release list |
| MAP-05 | Reference map list | Not observed | n/a | n/a | needs reference access: which maps does EDGE support? |

## 12. Accessibility and states

| ID | Feature | Expected result | Evidence | Impl. | Test |
| --- | --- | --- | --- | --- | --- |
| A11Y-01 | Side readable without colour | CT circle / T triangle in the radar, round strip and side labels | Matchframe product choice (brief) | done | Visual review |
| A11Y-02 | Shortcuts do not capture text input | Shortcuts are ignored in text fields and while a dialog is open | Matchframe product choice (brief) | done | `viewer.spec.ts`: pass |
| A11Y-03 | Labelled controls | Every icon button has an accessible name. Timeline markers describe the event. The scrubber has `aria-valuetext` | Matchframe product choice | done | `viewer.spec.ts` (role-based selectors) |
| A11Y-04 | Narrow screens | Map and playback stay visible. Round and filter strip collapsible | Matchframe product choice (brief) | done | `viewer.spec.ts` "narrow screen": pass |
| STATE-01 | Empty and error states | Library empty, catalogue empty, no rounds match, round load failure with retry, processing, failed with re-upload, revoked link | Matchframe product choice | done | `api.test.ts`, `viewer.spec.ts`: pass |

## Features found in the reference but missing from the brief

None recorded: the reference has not been observed.
