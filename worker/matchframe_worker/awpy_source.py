"""Awpy 3.3.0 adapter -> RawDemo.

Column names follow the Awpy 3.3.0 dataset guide (crates/awpy-python/docs/datasets.md
in the awpy==3.3.0 sdist). Anything that is not documented there is read
defensively and recorded as a warning, never assumed.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

import polars as pl

from .errors import InvalidDemo
from .raw import RawDemo

log = logging.getLogger(__name__)

SNAPSHOT_COLUMNS = [
    "tick", "steamid", "name", "side", "x", "y", "z", "yaw", "health", "armor", "money",
    "equipment_value", "active_weapon", "has_bomb", "has_defuser", "has_helmet", "is_defusing",
    "is_scoped", "is_blinded", "inventory",
]

_BOMB_EVENTS = {
    "pickup": "pickup",
    "drop": "drop",
    "start_plant": "plant_begin",
    "interrupt_plant": "plant_abort",
    "finish_plant": "plant",
    "defuse": "defuse",
}


def _str_id(v: Any) -> str | None:
    if v is None:
        return None
    return str(int(v)) if isinstance(v, (int, float)) else str(v)


def _ids(df: pl.DataFrame, cols: list[str]) -> pl.DataFrame:
    present = [c for c in cols if c in df.columns]
    if not present:
        return df
    return df.with_columns([pl.col(c).cast(pl.Utf8) for c in present])


def _event(demo, name: str) -> pl.DataFrame | None:
    try:
        if name in demo.events:
            return demo.events[name]
    except Exception:  # noqa: BLE001
        return None
    return None


def _num(df: pl.DataFrame, cols: list[str]) -> pl.DataFrame:
    present = [c for c in cols if c in df.columns]
    return df.with_columns([pl.col(c).cast(pl.Float64, strict=False) for c in present]) if present else df


_TRUNCATED = re.compile(r"command at byte (\d+).*unexpected end of data")


def _open(path: str):
    from awpy import Demo

    demo = Demo(path)
    demo.load("rounds", "kills", "bomb", "grenades", "smokes", "fires", "players", "round_economy")
    return demo


def load(path: str, *, sample_every: int) -> RawDemo:
    import awpy  # imported lazily: the synthetic path and the tests do not need it

    warnings: list[str] = []
    try:
        demo = _open(path)
    except awpy.InvalidDemoError as e:  # type: ignore[attr-defined]
        # Recordings cut off mid-write end with a partial command. If that is the only problem
        # (the break is in the last 10% of the file), parse everything before it.
        m = _TRUNCATED.search(str(e))
        size = os.path.getsize(path)
        if not m or int(m.group(1)) < size * 0.9:
            raise InvalidDemo(f"The demo could not be decoded: {e}") from e
        cut = int(m.group(1))
        trimmed = f"{path}.trimmed"
        with open(path, "rb") as src, open(trimmed, "wb") as dst:
            remaining = cut
            while remaining:
                chunk = src.read(min(1 << 20, remaining))
                if not chunk:
                    break
                dst.write(chunk)
                remaining -= len(chunk)
        try:
            demo = _open(trimmed)
        except awpy.InvalidDemoError as e2:  # type: ignore[attr-defined]
            raise InvalidDemo(f"The demo could not be decoded: {e2}") from e2
        path = trimmed
        warnings.append(f"The recording ends abruptly; the final incomplete fragment ({size - cut} bytes) was ignored.")

    header = dict(demo.header)
    map_name = str(header.get("map_name") or "").strip().lower()
    client = str(header.get("client_name") or "")
    # GOTV/CSTV recordings identify the recorder as the TV client; anything else is a client (POV) recording.
    is_tv = any(s in client.lower() for s in ("gotv", "sourcetv", "cstv", "tv"))
    source_type = "gotv" if is_tv else "pov"

    rounds = demo.rounds.select(
        [c for c in ("round_num", "start_tick", "freeze_end_tick", "end_tick", "official_end_tick", "winner_side", "reason_name") if c in demo.rounds.columns]
    ).rename({"reason_name": "reason"} if "reason_name" in demo.rounds.columns else {})

    samples = demo.snapshots(every=sample_every)
    keep = [c for c in SNAPSHOT_COLUMNS if c in samples.columns]
    missing = sorted(set(SNAPSHOT_COLUMNS) - set(keep))
    if missing:
        warnings.append(f"Parser did not provide snapshot fields: {', '.join(missing)}")
    samples = _ids(samples.select(keep), ["steamid"])
    # Ammo (clip / reserve) comes from demoparser2 at the same sample ticks; optional.
    from .ammo import load_ammo

    ammo = load_ammo(path, sorted(samples["tick"].unique().to_list())) if samples.height else None
    if ammo is not None and ammo.height:
        samples = samples.join(ammo, on=["tick", "steamid"], how="left")
    else:
        warnings.append("Ammo counts are unavailable for this demo.")
    if "inventory" in samples.columns and samples.schema["inventory"] == pl.Utf8:
        samples = samples.with_columns(
            pl.when(pl.col("inventory").is_null() | (pl.col("inventory") == ""))
            .then(pl.lit([], dtype=pl.List(pl.Utf8)))
            .otherwise(pl.col("inventory").str.split(","))
            .alias("inventory")
        )

    kills = _ids(demo.kills, ["attacker_steamid", "victim_steamid", "assister_steamid"])

    bomb = demo.bomb
    if bomb.height:
        bomb = _ids(bomb, ["steamid"]).with_columns(
            pl.col("event").replace_strict(_BOMB_EVENTS, default=None).alias("event"),
            pl.col("bombsite").alias("site") if "bombsite" in bomb.columns else pl.lit(None, dtype=pl.Utf8).alias("site"),
        ).filter(pl.col("event").is_not_null())
    extra = []
    for ev_name, kind in (("bomb_begindefuse", "defuse_begin"), ("bomb_abortdefuse", "defuse_abort"), ("bomb_exploded", "explode")):
        df = _event(demo, ev_name)
        if df is not None and df.height:
            extra.append(pl.DataFrame({"tick": df["tick"].cast(pl.Int64), "event": [kind] * df.height}))
    if extra:
        warnings.append("Defuse-begin/abort and explode times come from raw game events (no player position).")
        bomb = pl.concat([bomb.select([c for c in ("tick", "event", "steamid", "name", "x", "y", "z", "site") if c in bomb.columns]).with_columns(pl.col("tick").cast(pl.Int64)), *extra], how="diagonal_relaxed")

    grenades = demo.grenades
    if grenades.height:
        grenades = _ids(grenades, ["thrower_steamid"]).rename({"type": "grenade_type"}).with_columns(
            (pl.col("entity_id").cast(pl.Utf8) + ":" + pl.col("entity_serial").cast(pl.Utf8)).alias("entity_id"),
            pl.col("start_tick").alias("throw_index"),
        )

    def effects(df: pl.DataFrame) -> pl.DataFrame:
        if df.height == 0:
            return df
        return _ids(df, ["thrower_steamid"]).with_columns(
            (pl.col("entity_id").cast(pl.Utf8) + ":" + pl.col("entity_serial").cast(pl.Utf8)).alias("entity_id")
        )

    smokes = effects(demo.smokes)
    fires = effects(demo.fires)
    # Smoke entity == its projectile entity in CS2; fire (inferno) entities differ from the molotov projectile,
    # so fires are linked by thrower + position + time in transform.py.

    dets = []
    for ev_name, gtype in (("hegrenade_detonate", "he"), ("flashbang_detonate", "flash"), ("decoy_detonate", "decoy")):
        df = _event(demo, ev_name)
        if df is None or df.height == 0:
            continue
        cols = {c.lower(): c for c in df.columns}
        try:
            d = pl.DataFrame(
                {
                    "tick": df["tick"].cast(pl.Int64),
                    "grenade_type": [gtype] * df.height,
                    "entity_id": df[cols["entityid"]].cast(pl.Utf8) if "entityid" in cols else [None] * df.height,
                    "x": df[cols["x"]].cast(pl.Float64, strict=False),
                    "y": df[cols["y"]].cast(pl.Float64, strict=False),
                    "z": df[cols["z"]].cast(pl.Float64, strict=False),
                }
            )
            dets.append(d)
        except KeyError:
            warnings.append(f"Event {ev_name} has no position fields; detonations omitted.")
    detonations = pl.concat(dets) if dets else pl.DataFrame(schema={"tick": pl.Int64, "grenade_type": pl.Utf8, "x": pl.Float64, "y": pl.Float64, "z": pl.Float64})
    # Raw detonate events carry the projectile slot only (no serial); match on the slot part of entity_id.
    if detonations.height and grenades.height:
        slot = grenades.select(pl.col("entity_id").str.split(":").list.first().alias("slot"), "entity_id", "end_tick", "thrower_steamid", "thrower_name").unique()
        detonations = detonations.join_asof(
            slot.rename({"end_tick": "tick", "entity_id": "full_id"}).with_columns(pl.col("tick").cast(pl.Int64)).sort("tick"),
            on="tick", by_left="entity_id", by_right="slot", strategy="nearest", tolerance=64,
        ).with_columns(pl.coalesce("full_id", "entity_id").alias("entity_id")).drop("full_id")

    conns = []
    df = _event(demo, "player_disconnect")
    if df is not None and df.height:
        cols = {c.lower(): c for c in df.columns}
        if "xuid" in cols:
            conns.append(pl.DataFrame({
                "tick": df["tick"].cast(pl.Int64),
                "steamid": df[cols["xuid"]].cast(pl.Utf8),
                "name": df[cols["name"]] if "name" in cols else [None] * df.height,
                "event": ["disconnect"] * df.height,
            }))
    connections = pl.concat(conns) if conns else pl.DataFrame(schema={"tick": pl.Int64, "steamid": pl.Utf8, "name": pl.Utf8, "event": pl.Utf8})

    economy = demo.round_economy if demo.round_economy.height else None
    team_scores = _team_scores(path, rounds)
    clan_names = {}
    for r in demo.players.to_dicts():
        sid = _str_id(r.get("steamid"))
        if sid and sid != "0" and r.get("team_clan_name"):
            clan_names[sid] = r["team_clan_name"]

    last_tick = int(header.get("playback_ticks") or 0)
    if samples.height:
        last_tick = max(last_tick, int(samples["tick"].max()))

    import importlib.metadata as md

    return RawDemo(
        map_name=map_name,
        tick_rate=float(demo.tick_rate),
        source_type=source_type,
        header={k: (v if isinstance(v, (str, int, float, bool)) or v is None else str(v)) for k, v in header.items()},
        convars=dict(demo.convars),
        rounds=rounds,
        samples=samples,
        kills=kills,
        bomb=bomb,
        grenades=grenades,
        smokes=smokes,
        fires=fires,
        detonations=detonations,
        connections=connections,
        economy=economy,
        last_tick=last_tick,
        parser_name="awpy",
        parser_version=md.version("awpy"),
        pov_steamid=None,
        clan_names=clan_names,
        warnings=warnings,
        team_scores=team_scores,
    )


def _team_scores(path: str, rounds: pl.DataFrame) -> pl.DataFrame | None:
    """Scoreboard (rounds won by each player's team) at every round's freeze end, via demoparser2."""
    col = "freeze_end_tick" if "freeze_end_tick" in rounds.columns else "start_tick"
    ticks = sorted({int(t) for t in rounds[col].drop_nulls().to_list()})
    if not ticks:
        return None
    try:
        from demoparser2 import DemoParser

        df = DemoParser(path).parse_ticks(["team_rounds_total"], ticks=ticks)
    except Exception:  # noqa: BLE001 - optional cross-check
        return None
    if df is None or len(df) == 0:
        return None
    return pl.from_pandas(df[["tick", "steamid", "team_rounds_total"]]).select(
        pl.col("tick").cast(pl.Int64),
        pl.col("steamid").cast(pl.UInt64, strict=False).cast(pl.Utf8),
        pl.col("team_rounds_total").cast(pl.Int64, strict=False).alias("team_score"),
    )
