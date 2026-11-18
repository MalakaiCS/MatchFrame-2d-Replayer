"""Normalised parser output.

Adapters (awpy_source.py, synthetic.py) convert their parser's tables into
these canonical columns so that transform.py never depends on a specific
parser's naming. Every column listed is required unless marked optional;
optional columns may be absent or entirely null.

rounds:     round_num, start_tick, freeze_end_tick?, end_tick (round decided),
            official_end_tick?, winner_side ('CT'|'T'|None), reason?
samples:    tick, steamid (str; '0' or '' for bots), name, side ('CT'|'T'|None),
            x, y, z, yaw?, health?, armor?, money?, equipment_value?,
            active_weapon?, has_bomb?, has_defuser?, has_helmet?, is_defusing?,
            is_scoped?, is_blinded?, inventory? (list[str])
kills:      tick, attacker_steamid?, attacker_name?, attacker_x?, attacker_y?, attacker_z?,
            victim_steamid, victim_name, victim_x?, victim_y?, victim_z?,
            assister_steamid?, weapon?, headshot?, penetrated?, thrusmoke?, noscope?, attackerblind?
bomb:       tick, event ('plant_begin'|'plant'|'defuse_begin'|'defuse'|'explode'|'drop'|'pickup'),
            steamid?, name?, x?, y?, z?, site?
grenades:   entity_id, throw_index?, grenade_type, thrower_steamid?, thrower_name?, tick, x, y, z
            (one row per observed projectile position)
smokes/fires: entity_id, thrower_steamid?, thrower_name?, start_tick, end_tick?, x, y, z
detonations: tick, grenade_type ('he'|'flash'|'decoy'), entity_id?, thrower_steamid?, thrower_name?, x, y, z
connections: tick, steamid, name, event ('disconnect'|'connect')
economy:    round_num, side, equipment_value?, buy_type?   (parser's own classification)
"""

from __future__ import annotations

from dataclasses import dataclass, field

import polars as pl


@dataclass
class RawDemo:
    map_name: str
    tick_rate: float
    source_type: str  # 'gotv' | 'pov'
    header: dict
    convars: dict[str, str]
    rounds: pl.DataFrame
    samples: pl.DataFrame
    kills: pl.DataFrame
    bomb: pl.DataFrame
    grenades: pl.DataFrame
    smokes: pl.DataFrame
    fires: pl.DataFrame
    detonations: pl.DataFrame
    connections: pl.DataFrame
    economy: pl.DataFrame | None
    last_tick: int
    parser_name: str
    parser_version: str
    synthetic: bool = False
    pov_steamid: str | None = None
    clan_names: dict[str, str] = field(default_factory=dict)  # steamid -> clan name
    warnings: list[str] = field(default_factory=list)
    # Scoreboard rounds won per player (steamid) at a tick: tick, steamid, team_score. Optional.
    team_scores: pl.DataFrame | None = None


def empty(schema: dict[str, pl.DataType]) -> pl.DataFrame:
    return pl.DataFrame(schema=schema)
