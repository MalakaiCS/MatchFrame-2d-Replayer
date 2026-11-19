"""Build the versioned replay contract (manifest + per-round payloads) from a RawDemo.

Pure functions only: no I/O, no database, no parser imports. Every rule here
is documented in docs/data-contract.md and covered by tests/test_transform.py.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable

import polars as pl

from .stats import round_player_stats
from . import WORKER_VERSION
from .errors import NoPlayableRounds
from .ammo import has_ammo
from .maps import MapInfo
from .raw import RawDemo

SCHEMA_VERSION = 1

FIREARM_HINTS = (
    "ak", "m4", "awp", "glock", "usp", "p2000", "p250", "deagle", "desert", "five", "tec", "cz", "dual",
    "revolver", "mac", "mp", "ump", "p90", "bizon", "famas", "galil", "sg", "aug", "ssg", "scar", "g3",
    "nova", "xm", "mag", "sawed", "negev", "m249",
)


@dataclass(frozen=True)
class TransformConfig:
    # Fallback timings when the demo has no convars (seconds). Defaults are Valve competitive values.
    default_freeze_s: float = 15.0
    default_round_s: float = 115.0
    default_c4_s: float = 40.0
    default_max_rounds: int = 24
    default_ot_max_rounds: int = 6
    # Team buy classification by team equipment value at freeze end (USD). See docs/data-contract.md.
    # Categories follow the reference: pistol / eco / half buy / full buy.
    eco_below: int = 5000
    half_buy_below: int = 20000
    # Movement discontinuities.
    max_gap_samples: int = 2
    teleport_speed_ups: float = 1200.0
    teleport_min_units: float = 96.0
    # Utility estimates (Hammer units / seconds). Labelled as estimates in the payload.
    smoke_radius: float = 144.0
    fire_radius: float = 150.0
    he_disrupt_radius: float = 128.0
    he_disrupt_seconds: float = 2.0
    he_disrupt_max_dz: float = 200.0
    instant_effect_seconds: float = 0.5
    grenade_segment_gap_ticks: int = 32
    # Effect <-> projectile association windows (seconds).
    link_window_s: float = 3.0
    link_distance: float = 250.0


@dataclass
class _Round:
    num: int
    start: int
    freeze_end: int | None
    decided: int | None
    end: int  # exclusive
    winner_side: str | None
    reason: str | None


def _norm_side(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return {2: "T", 3: "CT"}.get(int(v))
    s = str(v).strip().upper()
    if s in ("CT", "COUNTER-TERRORIST", "COUNTERTERRORIST", "3"):
        return "CT"
    if s in ("T", "TERRORIST", "2"):
        return "T"
    return None


def player_id(steamid: Any, name: Any) -> str:
    sid = "" if steamid is None else str(steamid)
    if sid in ("", "0", "None"):
        return f"b:{name or 'unknown'}"
    return f"s:{sid}"


def _r1(v: Any) -> float:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return 0.0
    return round(float(v), 1)


def _vec(x: Any, y: Any, z: Any) -> dict | None:
    if x is None or y is None:
        return None
    return {"x": _r1(x), "y": _r1(y), "z": _r1(z if z is not None else 0.0)}


def _col(df: pl.DataFrame, name: str) -> bool:
    return name in df.columns and df.height > 0 and df[name].null_count() < df.height


def _rows(df: pl.DataFrame | None) -> list[dict]:
    if df is None or df.height == 0:
        return []
    return df.to_dicts()


def classify_buy(value: int | None, is_pistol: bool, cfg: TransformConfig) -> str | None:
    if is_pistol:
        return "pistol"
    if value is None:
        return None
    if value < cfg.eco_below:
        return "eco"
    if value < cfg.half_buy_below:
        return "half_buy"
    return "full_buy"


def _has_firearm(items: Iterable[str] | None) -> bool:
    if not items:
        return False
    for it in items:
        s = str(it).lower()
        if "knife" in s or "bayonet" in s or "c4" in s or "grenade" in s or "flash" in s or "molotov" in s:
            continue
        if any(h in s for h in FIREARM_HINTS):
            return True
    return False


# ---------------------------------------------------------------------------
# Rounds
# ---------------------------------------------------------------------------


def select_rounds(raw: RawDemo) -> tuple[list[_Round], list[dict], list[str]]:
    """Return kept rounds (ordered), excluded rounds and warnings.

    Rules: drop rounds before the last match restart (round number going
    backwards), rounds with no decided tick or winner (incomplete/reset), and
    knife rounds (no player holds a firearm after freeze end).
    """
    warnings: list[str] = []
    excluded: list[dict] = []
    rows = _rows(raw.rounds)
    # A round whose start was not recorded (recording began during it) starts at its freeze end
    # minus the freeze time, or at the first recorded tick.
    freeze_ticks = int(round(float((raw.convars or {}).get("mp_freezetime", 15) or 15) * raw.tick_rate))
    first_tick = int(raw.samples["tick"].min()) if raw.samples.height else 0
    for r in rows:
        if r.get("start_tick") is None:
            anchor = r.get("freeze_end_tick") if r.get("freeze_end_tick") is not None else r.get("end_tick")
            r["start_tick"] = max(first_tick, int(anchor) - freeze_ticks) if anchor is not None else first_tick
            warnings.append(f"Round {r['round_num']} start was not recorded; it starts at the first recorded moment.")
    rows = sorted(rows, key=lambda r: (r["start_tick"], r["round_num"]))
    # Restart detection.
    restart_idx = 0
    for i in range(1, len(rows)):
        if rows[i]["round_num"] <= rows[i - 1]["round_num"]:
            restart_idx = i
    if restart_idx:
        for r in rows[:restart_idx]:
            excluded.append({"reason": "before match restart", "startTick": r["start_tick"], "endTick": r.get("end_tick")})
        warnings.append(f"{restart_idx} round(s) before a match restart were excluded.")
        rows = rows[restart_idx:]

    starts = [r["start_tick"] for r in rows]
    out: list[_Round] = []
    for i, r in enumerate(rows):
        if i + 1 < len(rows):
            end = starts[i + 1]
        elif r.get("official_end_tick") is not None:
            end = int(r["official_end_tick"]) + 1
        else:
            end = raw.last_tick + 1
        decided = r.get("end_tick")
        winner = _norm_side(r.get("winner_side"))
        if decided is None or winner is None:
            excluded.append({"reason": "incomplete or reset round", "startTick": r["start_tick"], "endTick": decided})
            continue
        end = max(end, int(decided) + 1)
        out.append(
            _Round(
                num=int(r["round_num"]),
                start=int(r["start_tick"]),
                freeze_end=None if r.get("freeze_end_tick") is None else int(r["freeze_end_tick"]),
                decided=int(decided),
                end=int(end),
                winner_side=winner,
                reason=None if r.get("reason") is None else str(r["reason"]),
            )
        )

    # Knife rounds.
    if "inventory" in raw.samples.columns and raw.samples.height:
        kept: list[_Round] = []
        for rd in out:
            lo = rd.freeze_end if rd.freeze_end is not None else rd.start
            sub = raw.samples.filter((pl.col("tick") >= lo) & (pl.col("tick") < rd.decided))
            if sub.height and not any(_has_firearm(inv) for inv in sub["inventory"].to_list()):
                excluded.append({"reason": "knife round", "startTick": rd.start, "endTick": rd.decided})
                warnings.append(f"Round at tick {rd.start} looks like a knife round and was excluded.")
                continue
            kept.append(rd)
        out = kept
    if not out:
        raise NoPlayableRounds("The demo contains no complete, playable rounds.")
    return out, excluded, warnings


def _timing(raw: RawDemo, cfg: TransformConfig) -> dict:
    cv = {k.lower(): v for k, v in (raw.convars or {}).items()}

    def num(*names: str) -> float | None:
        for n in names:
            if n in cv:
                try:
                    return float(cv[n])
                except ValueError:
                    pass
        return None

    freeze = num("mp_freezetime")
    rt = num("mp_roundtime_defuse", "mp_roundtime")
    c4 = num("mp_c4timer")
    maxr = num("mp_maxrounds")
    otmax = num("mp_overtime_maxrounds")
    src = "convars" if rt is not None else "defaults"
    return {
        "freezeTimeS": freeze if freeze is not None else cfg.default_freeze_s,
        "roundTimeS": rt * 60.0 if rt is not None else cfg.default_round_s,
        "bombTimerS": c4 if c4 is not None else cfg.default_c4_s,
        "source": src,
        "maxRounds": int(maxr) if maxr else cfg.default_max_rounds,
        "overtimeMaxRounds": int(otmax) if otmax else cfg.default_ot_max_rounds,
    }


def _round_meta(display: int, max_rounds: int, ot_max: int) -> tuple[int, bool, bool, bool]:
    """Return (half, is_overtime, is_pistol, is_ot_half_start), all from the 1-based display number."""
    reg_half = max_rounds // 2
    if display <= max_rounds:
        half = (display - 1) // reg_half + 1
        pistol = display == 1 or display == reg_half + 1
        return half, False, pistol, False
    ot_idx = display - max_rounds - 1
    ot_half = max(ot_max // 2, 1)
    half = 2 + ot_idx // ot_half + 1
    return half, True, False, ot_idx % ot_half == 0


def _expected_swap(prev_display: int, max_rounds: int, ot_max: int) -> bool:
    """Whether sides are expected to swap between prev_display and prev_display+1 (fallback only)."""
    reg_half = max_rounds // 2
    if prev_display == reg_half:
        return True
    if prev_display < max_rounds:
        return False
    if prev_display == max_rounds:
        return False  # CS2 overtime starts on the sides held at the end of regulation.
    ot_half = max(ot_max // 2, 1)
    return (prev_display - max_rounds) % ot_half == 0


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------


@dataclass
class BuildResult:
    manifest: dict
    payloads: dict[str, dict] = field(default_factory=dict)


def build(
    raw: RawDemo,
    map_info: MapInfo,
    *,
    replay_id: str,
    revision: int,
    prefix: str,
    sample_every: int,
    series: dict | None = None,
    cfg: TransformConfig = TransformConfig(),
) -> BuildResult:
    rounds, excluded, warnings = select_rounds(raw)
    warnings = list(raw.warnings) + warnings
    timing = _timing(raw, cfg)
    tick_interval_ms = 1000.0 / raw.tick_rate

    samples = raw.samples
    if samples.height:
        samples = samples.with_columns(
            pl.struct(["steamid", "name"]).map_elements(
                lambda s: player_id(s["steamid"], s["name"]), return_dtype=pl.Utf8
            ).alias("pid"),
            pl.col("side").map_elements(_norm_side, return_dtype=pl.Utf8).alias("side"),
        ).sort(["tick", "pid"])
    else:
        samples = samples.with_columns(pl.lit(None, dtype=pl.Utf8).alias("pid"))

    names: dict[str, str] = {}
    steam: dict[str, str | None] = {}
    for r in samples.select(["pid", "name", "steamid"]).unique(subset=["pid"], keep="last").to_dicts():
        names[r["pid"]] = r["name"] or r["pid"]
        steam[r["pid"]] = None if r["pid"].startswith("b:") else str(r["steamid"])

    # --- side per player per round, at freeze end (or first sample in round)
    def sides_at_round(rd: _Round) -> dict[str, str]:
        anchor = rd.freeze_end if rd.freeze_end is not None else rd.start
        sub = samples.filter((pl.col("tick") >= anchor) & (pl.col("tick") < rd.end) & pl.col("side").is_not_null())
        if sub.height == 0:
            sub = samples.filter((pl.col("tick") >= rd.start) & (pl.col("tick") < rd.end) & pl.col("side").is_not_null())
        if sub.height == 0:
            return {}
        first = sub.group_by("pid").agg(pl.col("side").first())
        return {r["pid"]: r["side"] for r in first.to_dicts()}

    team_of: dict[str, str] = {}
    a_side_by_round: list[str] = []
    for i, rd in enumerate(rounds):
        sides = sides_at_round(rd)
        votes = Counter()
        for pid, side in sides.items():
            if pid in team_of:
                votes[side if team_of[pid] == "A" else ("T" if side == "CT" else "CT")] += 1
        if i == 0:
            a_side = "CT"
        elif votes:
            (a_side, top), *rest = votes.most_common()
            if rest and rest[0][1] == top:
                prev = a_side_by_round[-1]
                a_side = ("T" if prev == "CT" else "CT") if _expected_swap(i, timing["maxRounds"], timing["overtimeMaxRounds"]) else prev
                warnings.append(f"Round {i + 1}: ambiguous team sides; used the expected side-swap rule.")
        else:
            prev = a_side_by_round[-1]
            a_side = ("T" if prev == "CT" else "CT") if _expected_swap(i, timing["maxRounds"], timing["overtimeMaxRounds"]) else prev
            warnings.append(f"Round {i + 1}: no known players present; used the expected side-swap rule.")
        a_side_by_round.append(a_side)
        for pid, side in sides.items():
            if pid not in team_of:
                team_of[pid] = "A" if side == a_side else "B"

    # Players never seen at a freeze-end anchor: assign by most common side relative to team A.
    for pid in names:
        if pid not in team_of:
            team_of[pid] = "A"
            warnings.append(f"Player {names[pid]} could not be assigned to a team reliably.")

    # Team names from clan tags (majority per team), with fallbacks.
    teams: dict[str, dict] = {}
    for key, start_side in (("A", a_side_by_round[0]), ("B", "T" if a_side_by_round[0] == "CT" else "CT")):
        clans = Counter(
            raw.clan_names.get(steam[p] or "", "") for p, t in team_of.items() if t == key and steam.get(p)
        )
        clans.pop("", None)
        if clans:
            teams[key] = {"key": key, "name": clans.most_common(1)[0][0], "nameSource": "clan", "startSide": start_side}
        else:
            teams[key] = {"key": key, "name": {"A": "Team Alpha", "B": "Team Bravo"}[key], "nameSource": "fallback", "startSide": start_side}

    players = [
        {"id": pid, "name": names[pid], "steamId": steam[pid], "isBot": pid.startswith("b:"), "team": team_of[pid]}
        for pid in sorted(names, key=lambda p: (team_of[p], names[p].lower()))
    ]

    # --- per-round summaries and payloads
    # Display numbers are the match's own round numbers, so a recording that starts mid-match
    # (e.g. at round 7) keeps "Round 7"; pistol/overtime detection uses the same numbering.
    offset = rounds[0].num - 1 if rounds[0].num > 1 and all(b.num == a.num + 1 for a, b in zip(rounds, rounds[1:])) else 0
    board = _scoreboard(raw, samples, team_of, rounds)
    score = {"A": 0, "B": 0}
    if offset:
        seed = board.get(0)
        if seed:
            score = dict(seed)
            warnings.append(f"The recording starts at round {offset + 1}; the score before it ({seed['A']}:{seed['B']}) comes from the scoreboard.")
        else:
            warnings.append(f"The recording starts at round {offset + 1}; earlier rounds are missing and the score counts from 0:0.")
    mismatches = 0
    summaries: list[dict] = []
    payloads: dict[str, dict] = {}
    econ_by_round = _parser_economy(raw)
    has_econ = _col(samples, "equipment_value")

    for i, rd in enumerate(rounds):
        display = i + 1 + offset
        rid = f"r{display:02d}"
        a_side = a_side_by_round[i]
        sides = {"A": a_side, "B": "T" if a_side == "CT" else "CT"}
        winner = None
        if rd.winner_side:
            winner = "A" if rd.winner_side == a_side else "B"
        if i in board and board[i] != score and (i or not offset):
            mismatches += 1
        before = dict(score)
        if winner:
            score[winner] += 1
        half, is_ot, is_pistol, is_ot_start = _round_meta(display, timing["maxRounds"], timing["overtimeMaxRounds"])

        economy = {}
        equipment: dict[str, int | None] = {}
        anchor = rd.freeze_end if rd.freeze_end is not None else rd.start
        for key in ("A", "B"):
            members = [p for p, t in team_of.items() if t == key]
            val = None
            n = 0
            if has_econ:
                snap = (
                    samples.filter((pl.col("tick") >= anchor) & (pl.col("tick") < rd.end) & pl.col("pid").is_in(members))
                    .group_by("pid")
                    .agg(pl.col("equipment_value").first())
                )
                n = snap.height
                for row in snap.to_dicts():
                    equipment[row["pid"]] = None if row["equipment_value"] is None else int(row["equipment_value"])
                vals = [v for v in snap["equipment_value"].to_list() if v is not None]
                val = int(sum(vals)) if vals else None
            parser_bt = econ_by_round.get((rd.num, sides[key]))
            economy[key] = {
                "equipmentValue": val,
                "buyType": classify_buy(val, is_pistol, cfg),
                "parserBuyType": parser_bt,
                "players": n,
            }

        payload, coverage, planted = _round_payload(raw, samples, rd, rid, map_info, sample_every, cfg, raw.tick_rate)
        payloads[rid] = payload
        coverage = {pid: coverage.get(pid, 0.0) for pid in sorted(names)}
        player_stats = round_player_stats(
            start=rd.start, end=rd.end, decided=rd.decided, sides=sides_at_round(rd), winner_side=rd.winner_side,
            kills=raw.kills, damages=raw.damages, blinds=raw.blinds, pid_of=player_id,
            tick_rate=raw.tick_rate, equipment=equipment,
        )
        summaries.append(
            {
                "id": rid,
                "displayNumber": display,
                "startTick": rd.start,
                "freezeEndTick": rd.freeze_end,
                "decidedTick": rd.decided,
                "endTick": rd.end,
                "sides": sides,
                "scoreBefore": before,
                "scoreAfter": dict(score),
                "winner": winner,
                "winnerSide": rd.winner_side,
                "endReason": rd.reason,
                "durationMs": round((rd.end - rd.start) * tick_interval_ms),
                "half": half,
                "isOvertime": is_ot,
                "isPistol": is_pistol,
                "isOvertimeHalfStart": is_ot_start,
                "economy": economy,
                "coverage": coverage,
                "bombPlanted": planted,
                "playerStats": player_stats,
                "payload": {"key": f"{prefix}/rounds/{rid}.json.gz", "bytes": 0, "sha256": ""},
            }
        )

    if mismatches:
        warnings.append(f"Computed score differs from the in-game scoreboard before {mismatches} round(s).")
    caps = _capabilities(raw, samples, map_info, timing, summaries)
    caps["recordingStartsAtRound"] = offset + 1
    caps["damage"] = raw.damages is not None and raw.damages.height > 0
    caps["blinds"] = raw.blinds is not None and raw.blinds.height > 0
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "replayId": replay_id,
        "revision": revision,
        "parser": {
            "name": raw.parser_name,
            "version": raw.parser_version,
            "worker": WORKER_VERSION,
            "synthetic": raw.synthetic,
        },
        "map": {
            "id": map_info.id,
            "displayName": map_info.display_name,
            "registryVersion": map_info.registry_version,
            "calibration": map_info.status,
        },
        "sourceType": raw.source_type,
        "povPlayerId": player_id(raw.pov_steamid, None) if raw.pov_steamid else None,
        "tickRate": raw.tick_rate,
        "tickIntervalMs": tick_interval_ms,
        "sampleEveryTicks": sample_every,
        "teams": teams,
        "players": players,
        "timing": timing,
        "capabilities": caps,
        "series": series,
        "finalScore": dict(score),
        "rounds": summaries,
        "excludedRounds": excluded,
        "warnings": warnings,
    }
    return BuildResult(manifest=manifest, payloads=payloads)


def _scoreboard(raw: RawDemo, samples: pl.DataFrame, team_of: dict[str, str], rounds: list["_Round"]) -> dict[int, dict[str, int]]:
    """In-game score (team A, team B) before each kept round, from the scoreboard, when available."""
    if raw.team_scores is None or raw.team_scores.height == 0:
        return {}
    by_tick: dict[int, dict[str, int]] = {}
    for r in raw.team_scores.to_dicts():
        if r["team_score"] is None:
            continue
        team = team_of.get(player_id(r["steamid"], None))
        if team:
            by_tick.setdefault(int(r["tick"]), {})[team] = int(r["team_score"])
    out = {}
    for i, rd in enumerate(rounds):
        s = by_tick.get(rd.freeze_end if rd.freeze_end is not None else rd.start)
        if s and "A" in s and "B" in s:
            out[i] = {"A": s["A"], "B": s["B"]}
    return out


def _parser_economy(raw: RawDemo) -> dict[tuple[int, str], str]:
    out = {}
    for r in _rows(raw.economy):
        side = _norm_side(r.get("side"))
        if side and r.get("buy_type") is not None:
            out[(int(r["round_num"]), side)] = str(r["buy_type"])
    return out


def _capabilities(raw: RawDemo, samples: pl.DataFrame, m: MapInfo, timing: dict, summaries: list[dict]) -> dict:
    partial = raw.source_type == "pov" and any(
        v < 0.95 for s in summaries for v in s["coverage"].values()
    )
    has_freeze = all(s["freezeEndTick"] is not None for s in summaries)
    return {
        "clock": "countdown" if (timing["source"] == "convars" and has_freeze) else "elapsed",
        "participants": "partial" if partial else "all",
        "health": _col(samples, "health"),
        "armor": _col(samples, "armor"),
        "money": _col(samples, "money"),
        "ammo": _col(samples, "clip"),
        "reserveAmmo": "recorded" if _col(samples, "reserve") else "none",
        "inventory": _col(samples, "inventory"),
        "economy": _col(samples, "equipment_value"),
        "bombPosition": _col(raw.bomb, "x"),
        "utilityPaths": raw.grenades.height > 0,
        "utilityEffects": raw.smokes.height > 0 or raw.fires.height > 0 or raw.detonations.height > 0,
        "smokeDisruption": "inferred" if (raw.smokes.height > 0 and raw.detonations.height > 0) else "none",
        "floors": "rule-based" if len(m.floors) > 1 else "single",
        "viewAngles": _col(samples, "yaw"),
    }


# ---------------------------------------------------------------------------
# Round payload
# ---------------------------------------------------------------------------

_EVENT_RANK = {
    "freeze_end": 0,
    "disconnect": 1,
    "reconnect": 2,
    "grenade_throw": 3,
    "grenade_detonate": 4,
    "smoke_disrupted": 5,
    "bomb_pickup": 6,
    "bomb_drop": 7,
    "bomb_plant_begin": 8,
    "bomb_defuse_begin": 9,
    "kill": 10,
    "bomb_plant": 11,
    "bomb_defuse": 12,
    "bomb_explode": 13,
    "round_end": 14,
}

_GRENADE_TYPES = {
    "smoke": "smoke", "smokegrenade": "smoke", "smoke_grenade": "smoke", "csmokegrenadeprojectile": "smoke",
    "flash": "flash", "flashbang": "flash", "cflashbangprojectile": "flash",
    "he": "he", "hegrenade": "he", "he_grenade": "he", "chegrenadeprojectile": "he",
    "molotov": "molotov", "cmolotovprojectile": "molotov", "incendiary": "incendiary", "incgrenade": "incendiary",
    "decoy": "decoy", "decoygrenade": "decoy", "cdecoyprojectile": "decoy",
}


def norm_grenade(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).lower().replace("weapon_", "").replace(" ", "").replace("_", "")
    if s in _GRENADE_TYPES:
        return _GRENADE_TYPES[s]
    for needle, kind in (("smoke", "smoke"), ("flash", "flash"), ("molotov", "molotov"), ("incendiary", "incendiary"),
                         ("incgrenade", "incendiary"), ("decoy", "decoy"), ("hegrenade", "he")):
        if needle in s:
            return kind
    return None


def _dist2(a: dict, b: dict) -> float:
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def _round_payload(
    raw: RawDemo,
    samples: pl.DataFrame,
    rd: _Round,
    rid: str,
    m: MapInfo,
    every: int,
    cfg: TransformConfig,
    tick_rate: float,
) -> tuple[dict, dict[str, float], bool]:
    sub = samples.filter((pl.col("tick") >= rd.start) & (pl.col("tick") < rd.end)).sort(["pid", "tick"])
    weapons: list[str] = []
    widx: dict[str, int] = {}

    def wi(w: Any) -> int:
        if w is None:
            return -1
        w = str(w)
        if w not in widx:
            widx[w] = len(weapons)
            weapons.append(w)
        return widx[w]

    expected = max(1, (rd.end - rd.start) // every)
    cols = set(sub.columns)
    tracks = []
    coverage: dict[str, float] = {}
    inventory: list[dict] = []
    carrier_by_tick: dict[int, str] = {}
    defusing_ticks: dict[str, list[int]] = defaultdict(list)

    for pid, g in sub.group_by("pid", maintain_order=True):
        pid = pid[0] if isinstance(pid, tuple) else pid
        rows = g.to_dicts()
        coverage[pid] = round(min(1.0, len(rows) / expected), 3)
        t, xs, ys, zs, yaws, alive, hp, ar, money, wpn, flags, floor, disc, clip, reserve = ([] for _ in range(15))
        prev = None
        prev_inv: tuple | None = None
        for r in rows:
            health = r.get("health")
            is_alive = 1 if (health is None or health > 0) else 0
            fl, _unc = m.floor_of(float(r["z"] or 0.0))
            d = 0
            if prev is None:
                d = 1
            else:
                dt = r["tick"] - prev["tick"]
                dist = math.hypot((r["x"] or 0) - (prev["x"] or 0), (r["y"] or 0) - (prev["y"] or 0))
                limit = max(cfg.teleport_min_units, cfg.teleport_speed_ups * dt / tick_rate)
                if dt > every * cfg.max_gap_samples or dist > limit or is_alive != alive[-1] or fl != floor[-1]:
                    d = 1
            f = 0
            if r.get("has_bomb"):
                f |= 1
                carrier_by_tick[r["tick"]] = pid
            if r.get("has_defuser"):
                f |= 2
            if r.get("has_helmet"):
                f |= 4
            if r.get("is_defusing"):
                f |= 8
                defusing_ticks[pid].append(r["tick"])
            if r.get("is_scoped"):
                f |= 32
            if r.get("is_blinded"):
                f |= 64
            t.append(int(r["tick"]))
            xs.append(_r1(r["x"]))
            ys.append(_r1(r["y"]))
            zs.append(_r1(r["z"]))
            yaws.append(_r1(r.get("yaw")))
            alive.append(is_alive)
            hp.append(int(health) if health is not None else 0)
            ar.append(int(r.get("armor") or 0))
            money.append(int(r.get("money") or 0))
            wpn.append(wi(r.get("active_weapon")))
            # -1 = not applicable (melee, grenades, bomb) or unknown.
            gun = has_ammo(r.get("active_weapon")) and is_alive
            clip.append(int(r["clip"]) if gun and r.get("clip") is not None and r["clip"] >= 0 else -1)
            reserve.append(int(r["reserve"]) if gun and r.get("reserve") is not None and r["reserve"] >= 0 else -1)

            flags.append(f)
            floor.append(fl)
            disc.append(d)
            inv = r.get("inventory")
            if inv is not None:
                key = tuple(sorted(str(x) for x in inv))
                if key != prev_inv:
                    inventory.append({"tick": int(r["tick"]), "playerId": pid, "items": list(key)})
                    prev_inv = key
            prev = r
        tracks.append(
            {
                "playerId": pid,
                "t": t,
                "x": xs,
                "y": ys,
                "z": zs,
                "yaw": yaws,
                "alive": alive,
                "hp": hp if "health" in cols else None,
                "armor": ar if "armor" in cols else None,
                "money": money if "money" in cols else None,
                "weapon": wpn if "active_weapon" in cols else None,
                "clip": clip if "clip" in cols else None,
                "reserve": reserve if "reserve" in cols else None,
                "flags": flags,
                "floor": floor,
                "disc": disc,
            }
        )

    events: list[dict] = []

    def ev(tick: int, typ: str, **kw: Any) -> dict:
        e = {"tick": int(tick), "type": typ, "provenance": kw.pop("provenance", "recorded"), **kw}
        events.append(e)
        return e

    in_round = lambda tick: tick is not None and rd.start <= tick < rd.end  # noqa: E731

    if rd.freeze_end is not None and in_round(rd.freeze_end):
        ev(rd.freeze_end, "freeze_end")
    if rd.decided is not None and in_round(rd.decided):
        ev(rd.decided, "round_end", reason=rd.reason)

    for k in _rows(raw.kills):
        if not in_round(k["tick"]):
            continue
        ev(
            k["tick"],
            "kill",
            actor=player_id(k.get("attacker_steamid"), k.get("attacker_name")) if k.get("attacker_name") or k.get("attacker_steamid") else None,
            target=player_id(k.get("victim_steamid"), k.get("victim_name")),
            assister=player_id(k.get("assister_steamid"), k.get("assister_name")) if k.get("assister_steamid") not in (None, "", "0") else None,
            weapon=k.get("weapon"),
            headshot=bool(k.get("headshot")),
            wallbang=bool(k.get("penetrated")),
            throughSmoke=bool(k.get("thrusmoke")),
            noscope=bool(k.get("noscope")),
            attackerBlind=bool(k.get("attackerblind")),
            position=_vec(k.get("victim_x"), k.get("victim_y"), k.get("victim_z")),
            actorPosition=_vec(k.get("attacker_x"), k.get("attacker_y"), k.get("attacker_z")),
        )

    for c in _rows(raw.connections):
        if in_round(c["tick"]):
            ev(c["tick"], "disconnect" if c["event"] == "disconnect" else "reconnect", actor=player_id(c.get("steamid"), c.get("name")))

    # --- grenades: segment projectile rows into throws
    grenades: list[dict] = []
    gsub = raw.grenades.filter((pl.col("tick") >= rd.start) & (pl.col("tick") < rd.end)) if raw.grenades.height else raw.grenades
    if gsub.height:
        keys = ["entity_id"] + (["throw_index"] if "throw_index" in gsub.columns else [])
        for _, g in gsub.sort(keys + ["tick"]).group_by(keys, maintain_order=True):
            rows = g.to_dicts()
            seg: list[dict] = []
            for r in rows + [None]:
                if r is None or (seg and r["tick"] - seg[-1]["tick"] > cfg.grenade_segment_gap_ticks):
                    if seg:
                        gt = norm_grenade(seg[0].get("grenade_type"))
                        if gt:
                            first, last = seg[0], seg[-1]
                            grenades.append(
                                {
                                    "id": f"g{first['tick']}-{first['entity_id']}",
                                    "type": gt,
                                    "throwerId": player_id(first.get("thrower_steamid"), first.get("thrower_name"))
                                    if (first.get("thrower_steamid") or first.get("thrower_name"))
                                    else None,
                                    "throwTick": int(first["tick"]),
                                    "detonateTick": int(last["tick"]),
                                    "path": [[int(p["tick"]), _r1(p["x"]), _r1(p["y"]), _r1(p["z"])] for p in seg],
                                    "detonation": _vec(last["x"], last["y"], last["z"]),
                                    "_entity": first["entity_id"],
                                }
                            )
                    seg = []
                if r is not None:
                    seg.append(r)

    def link(kind_types: tuple[str, ...], ent: Any, thrower: str | None, pos: dict, tick: int) -> dict | None:
        window = cfg.link_window_s * tick_rate
        cands = [
            g for g in grenades
            if g["type"] in kind_types and g["detonateTick"] is not None and abs(g["detonateTick"] - tick) <= window
        ]
        if ent is not None:
            for g in cands:
                if g["_entity"] == ent:
                    return g
        best = None
        for g in cands:
            if thrower and g["throwerId"] and g["throwerId"] != thrower:
                continue
            if g["detonation"] is None or _dist2(g["detonation"], pos) > cfg.link_distance:
                continue
            if g.get("_linked"):
                continue  # never merge two concurrent grenades into one projectile
            if best is None or abs(g["detonateTick"] - tick) < abs(best["detonateTick"] - tick):
                best = g
        return best

    effects: list[dict] = []

    def add_effect(kind: str, types: tuple[str, ...], r: dict, start: int, end: int | None, radius: float) -> dict:
        pos = _vec(r["x"], r["y"], r["z"])
        thrower = player_id(r.get("thrower_steamid"), r.get("thrower_name")) if (r.get("thrower_steamid") or r.get("thrower_name")) else None
        g = link(types, r.get("entity_id"), thrower, pos, start)
        if g is None and kind in ("smoke", "fire", "he", "flash", "decoy"):
            # Only the detonation was observed: record the point, never an invented flight path.
            gtype = {"fire": "molotov"}.get(kind, kind)
            g = {
                "id": f"g{start}-d{len(grenades)}",
                "type": gtype,
                "throwerId": thrower,
                "throwTick": start,
                "detonateTick": start,
                "path": [],
                "detonation": pos,
                "_entity": r.get("entity_id"),
            }
            grenades.append(g)
        g["_linked"] = True
        e = {
            "id": f"e{start}-{kind}-{len(effects)}",
            "kind": kind,
            "grenadeId": g["id"] if g else None,
            "throwerId": thrower or (g["throwerId"] if g else None),
            "startTick": int(start),
            "endTick": None if end is None else int(end),
            "position": pos,
            "radius": radius,
            "radiusSource": "configured-estimate",
            "disruptions": [],
        }
        effects.append(e)
        return e

    for r in _rows(raw.smokes):
        if in_round(r["start_tick"]):
            add_effect("smoke", ("smoke",), r, r["start_tick"], r.get("end_tick"), cfg.smoke_radius)
    for r in _rows(raw.fires):
        if in_round(r["start_tick"]):
            add_effect("fire", ("molotov", "incendiary"), r, r["start_tick"], r.get("end_tick"), cfg.fire_radius)
    inst = int(round(cfg.instant_effect_seconds * tick_rate))
    he_dets = []
    for r in _rows(raw.detonations):
        if not in_round(r["tick"]):
            continue
        kind = norm_grenade(r.get("grenade_type"))
        if kind not in ("he", "flash", "decoy"):
            continue
        e = add_effect(kind, (kind,), r, r["tick"], r["tick"] + inst, 0.0)
        if kind == "he":
            he_dets.append(e)

    # Smoke disruption (inferred): an HE detonation inside or near an active smoke clears part of it.
    dur = int(round(cfg.he_disrupt_seconds * tick_rate))
    for he in he_dets:
        t0 = he["startTick"]
        for s in effects:
            if s["kind"] != "smoke":
                continue
            s_end = s["endTick"] if s["endTick"] is not None else rd.end
            if not (s["startTick"] <= t0 < s_end):
                continue
            if _dist2(s["position"], he["position"]) > s["radius"] + cfg.he_disrupt_radius:
                continue
            if abs(s["position"]["z"] - he["position"]["z"]) > cfg.he_disrupt_max_dz:
                continue
            s["disruptions"].append(
                {"startTick": t0, "endTick": min(t0 + dur, s_end), "position": he["position"], "radius": cfg.he_disrupt_radius, "provenance": "inferred"}
            )
            ev(t0, "smoke_disrupted", grenadeId=he["grenadeId"], actor=he["throwerId"], position=he["position"], provenance="inferred")

    for g in grenades:
        if g["path"]:
            ev(g["throwTick"], "grenade_throw", actor=g["throwerId"], grenadeId=g["id"], weapon=g["type"],
               position={"x": g["path"][0][1], "y": g["path"][0][2], "z": g["path"][0][3]})
        if g["detonateTick"] is not None and g["detonation"] is not None:
            ev(g["detonateTick"], "grenade_detonate", actor=g["throwerId"], grenadeId=g["id"], weapon=g["type"], position=g["detonation"])

    bomb, planted = _bomb_track(raw, rd, carrier_by_tick, defusing_ticks, tick_rate, ev)

    events.sort(key=lambda e: (e["tick"], _EVENT_RANK.get(e["type"], 99)))
    per_tick = Counter()
    for e in events:
        n = per_tick[e["tick"]]
        per_tick[e["tick"]] += 1
        e["order"] = n
        e["id"] = f"{rid}:{e['tick']}:{n}:{e['type']}"

    for g in grenades:
        g.pop("_entity", None)
        g.pop("_linked", None)
    grenades.sort(key=lambda g: (g["throwTick"], g["id"]))
    effects.sort(key=lambda e: (e["startTick"], e["id"]))
    inventory.sort(key=lambda c: (c["tick"], c["playerId"]))

    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "roundId": rid,
        "startTick": rd.start,
        "endTick": rd.end,
        "sampleEveryTicks": every,
        "weapons": weapons,
        "tracks": tracks,
        "events": events,
        "bomb": bomb,
        "grenades": grenades,
        "effects": effects,
        "inventory": inventory,
    }
    return payload, coverage, planted


def _bomb_track(raw: RawDemo, rd: _Round, carrier_by_tick: dict[int, str], defusing_ticks: dict[str, list[int]], tick_rate: float, ev) -> tuple[list[dict], bool]:
    """Bomb state transitions, driven by recorded bomb events and carrier samples."""
    mapping = {
        "plant_begin": "planting", "plant": "planted", "defuse_begin": "defusing", "defuse": "defused",
        "explode": "exploded", "drop": "dropped", "pickup": "carried",
        "plant_abort": "carried", "defuse_abort": "planted",
    }
    ev_type = {
        "plant_begin": "bomb_plant_begin", "plant": "bomb_plant", "defuse_begin": "bomb_defuse_begin",
        "defuse": "bomb_defuse", "explode": "bomb_explode", "drop": "bomb_drop", "pickup": "bomb_pickup",
    }
    recorded = []
    for b in _rows(raw.bomb):
        if not (rd.start <= b["tick"] < rd.end):
            continue
        kind = str(b["event"]).lower()
        if kind not in mapping:
            continue
        actor = player_id(b.get("steamid"), b.get("name")) if (b.get("steamid") or b.get("name")) else None
        pos = _vec(b.get("x"), b.get("y"), b.get("z"))
        site = b.get("site")
        recorded.append({"tick": int(b["tick"]), "kind": kind, "actor": actor, "pos": pos, "site": site, "prov": "recorded"})
        if kind in ev_type:
            ev(b["tick"], ev_type[kind], actor=actor, position=pos, site=site)
    recorded.sort(key=lambda r: r["tick"])
    # Explosion without an explicit event: the round-end reason records it.
    if not any(r["kind"] == "explode" for r in recorded) and rd.decided is not None and rd.reason and (
        "explod" in rd.reason.lower() or "target_bombed" in rd.reason.lower()
    ) and any(r["kind"] == "plant" for r in recorded):
        recorded.append({"tick": rd.decided, "kind": "explode", "actor": None, "pos": None, "site": None, "prov": "inferred"})
        ev(rd.decided, "bomb_explode", provenance="inferred")

    planted_tick = next((r["tick"] for r in recorded if r["kind"] == "plant"), None)
    out: list[dict] = []

    def push(tick: int, state: str, carrier: str | None, pos: dict | None, site: str | None, prov: str) -> None:
        if out and out[-1]["state"] == state and out[-1]["carrier"] == carrier and out[-1]["position"] == pos:
            return
        out.append({"tick": int(tick), "state": state, "carrier": carrier, "position": pos, "site": site, "provenance": prov})

    timeline: list[tuple[int, int, dict]] = []
    prev_carrier = None
    for t in sorted(carrier_by_tick):
        if planted_tick is not None and t >= planted_tick:
            break
        c = carrier_by_tick[t]
        if c != prev_carrier:
            timeline.append((t, 1, {"kind": "carrier", "actor": c}))
            prev_carrier = c
    for r in recorded:
        timeline.append((r["tick"], 0, r))
    # Aborted defuses: the defuser stops defusing without a defuse event -> back to planted.
    defuse_begins = [r for r in recorded if r["kind"] == "defuse_begin"]
    for db in defuse_begins:
        ticks = [t for t in defusing_ticks.get(db["actor"] or "", []) if t >= db["tick"]]
        nxt = next((r for r in recorded if r["tick"] > db["tick"] and r["kind"] in ("defuse", "explode", "defuse_begin")), None)
        if any(r["kind"] == "defuse_abort" and r["tick"] > db["tick"] for r in recorded):
            continue  # recorded abort events take precedence
        if ticks and (nxt is None or nxt["kind"] != "defuse" or nxt["tick"] > ticks[-1] + 64):
            stop = ticks[-1] + 1
            if nxt is None or stop < nxt["tick"]:
                timeline.append((stop, 2, {"kind": "defuse_abort", "actor": db["actor"]}))
    # Aborted plants: no plant event within the plant duration -> back to carried at the next carrier sample.
    plant_s = 3.3
    for pb in (r for r in recorded if r["kind"] == "plant_begin"):
        deadline = pb["tick"] + int(plant_s * tick_rate)
        nxt = next((r for r in recorded if r["tick"] > pb["tick"] and r["kind"] in ("plant", "plant_begin", "drop")), None)
        if nxt is not None and nxt["kind"] == "plant" and nxt["tick"] <= deadline + 16:
            continue
        after = [t for t in sorted(carrier_by_tick) if t >= deadline and (nxt is None or t < nxt["tick"])]
        if after:
            timeline.append((after[0], 1, {"kind": "carrier_resume", "actor": carrier_by_tick[after[0]]}))
    timeline.sort(key=lambda x: (x[0], x[1]))

    site = None
    plant_pos = None
    state = "unknown"
    for tick, _, r in timeline:
        k = r["kind"]
        if k == "carrier":
            if state in ("planted", "defusing", "defused", "exploded"):
                continue
            push(tick, "carried", r["actor"], None, None, "inferred")
            state = "carried"
        elif k == "carrier_resume":
            if state == "planting":
                push(tick, "carried", r["actor"], None, None, "inferred")
                state = "carried"
        elif k == "defuse_abort":
            push(tick, "planted", None, plant_pos, site, "inferred")
            state = "planted"
        else:
            st = mapping[k]
            if k == "plant":
                site = r["site"]
                plant_pos = r["pos"]
            carrier = r["actor"] if st in ("carried", "planting", "defusing") else None
            pos = r["pos"] if st in ("dropped", "planted", "defused", "exploded") else None
            if st in ("defused", "exploded", "defusing", "planted") and pos is None and k != "plant":
                pos = plant_pos
            push(tick, st, carrier, pos, r["site"] or site, r.get("prov", "recorded"))
            state = st
    return out, planted_tick is not None
