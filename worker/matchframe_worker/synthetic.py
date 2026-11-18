"""Deterministic SYNTHETIC match generator.

This is NOT a demo parser and NOT evidence of parity. It produces a RawDemo
with the same canonical columns a real adapter yields, so the pipeline, the
viewer and the tests can exercise rounds, overtime, side swaps, a reconnect,
a bot, bomb plant/defuse/explode, smokes, an HE disrupting a smoke, fires
and multi-floor positions without a real CS2 demo.

A synthetic upload is a small file: b"MFSYNTH1" followed by a JSON object of
parameters (see `encode`). Workers only accept it when MF_ALLOW_SYNTHETIC=1.
"""

from __future__ import annotations

import bisect
import json
import math
import random
from dataclasses import dataclass, field

import polars as pl

from .demo_header import SYNTHETIC_MAGIC
from .raw import RawDemo

TICK_RATE = 64.0

# World anchor points per map (Hammer units). Synthetic only; not calibration evidence.
_MAP_POINTS = {
    "de_mirage": {"ct": (-1700, -2000, -170), "t": (1250, 0, -160), "A": (-300, -2100, -170), "B": (-2050, 400, -160), "mid": (-400, -700, -160)},
    "de_dust2": {"ct": (300, 2300, -120), "t": (-600, -800, 100), "A": (1150, 2500, 100), "B": (-1450, 2600, 40), "mid": (-450, 1000, 0)},
    "de_nuke": {"ct": (2500, -350, -350), "t": (-1850, -1100, -410), "A": (650, -800, -415), "B": (600, -900, -770), "mid": (1100, -1400, -410)},
}

_TEAM_A = ["Kestrel", "Juno", "Vale", "Sora", "Pike"]
_TEAM_B = ["Orrin", "Talon", "Mako", "Ridge"]


def encode(params: dict) -> bytes:
    return SYNTHETIC_MAGIC + json.dumps(params).encode()


def decode(data: bytes) -> dict:
    return json.loads(data[len(SYNTHETIC_MAGIC):].decode() or "{}")


@dataclass
class _Acc:
    rounds: list = field(default_factory=list)
    samples: list = field(default_factory=list)
    kills: list = field(default_factory=list)
    bomb: list = field(default_factory=list)
    grenades: list = field(default_factory=list)
    smokes: list = field(default_factory=list)
    fires: list = field(default_factory=list)
    dets: list = field(default_factory=list)
    conns: list = field(default_factory=list)
    econ: list = field(default_factory=list)
    pos: dict = field(default_factory=dict)  # (steamid, name) -> ([ticks], [(x, y, z)])


def generate(params: dict) -> RawDemo:
    map_name = params.get("map", "de_mirage")
    seed = int(params.get("seed", 7))
    every = int(params.get("every", 4))
    source = params.get("source", "gotv")
    # Winners from team A's perspective, in order. Default: 12-12 regulation, 4-1 overtime -> 16-13.
    winners = params.get(
        "winners",
        "ABABAABBABAB" "BABAABBAABAB" "AABAA",
    )
    pts = _MAP_POINTS[map_name]
    rng = random.Random(seed)
    acc = _Acc()

    players = [(f"7656119800000000{i + 1}", n, "A") for i, n in enumerate(_TEAM_A)]
    players += [(f"7656119800000001{i + 1}", n, "B") for i, n in enumerate(_TEAM_B)]
    players += [("0", "BOT Ivy", "B")]  # a bot on team B
    clans = {sid: ("Northwind" if t == "A" else "Harbour Five") for sid, _, t in players if sid != "0"}
    pov_missing = set(params.get("pov_missing", ["7656119800000001" + "3", "7656119800000001" + "4"])) if source == "pov" else set()

    tick = 1000
    # A reset round before the real match start (exercises restart exclusion).
    acc.rounds.append(dict(round_num=1, start_tick=tick, freeze_end_tick=tick + 960, end_tick=None, official_end_tick=None, winner_side=None, reason=None))
    tick += 2000

    a_side = "CT"
    for i, w in enumerate(winners):
        display = i + 1
        if display == 13:
            a_side = "T"
        if display == 25:
            a_side = "CT"
        if display > 24 and (display - 25) % 3 == 0 and display != 25:
            a_side = "T" if a_side == "CT" else "CT"
        start = tick
        freeze_end = start + int(15 * TICK_RATE)
        live = int(rng.uniform(45, 95) * TICK_RATE)
        winner_team = w
        winner_side = a_side if winner_team == "A" else ("T" if a_side == "CT" else "CT")
        pistol = display in (1, 13)
        t_team = "A" if a_side == "T" else "B"
        bomb_round = winner_side == "T" and rng.random() < 0.5 or (display % 5 == 0)
        site = "A" if rng.random() < 0.5 else "B"
        plant_tick = freeze_end + int(live * 0.55) if bomb_round else None
        if plant_tick:
            decided = plant_tick + int(40 * TICK_RATE) if winner_side == "T" else plant_tick + int(22 * TICK_RATE)
            reason = "bomb_exploded" if winner_side == "T" else "bomb_defused"
        else:
            decided = freeze_end + live
            reason = "t_killed" if winner_side == "CT" else "ct_killed"
        end = decided + int(7 * TICK_RATE)
        acc.rounds.append(dict(round_num=display, start_tick=start, freeze_end_tick=freeze_end, end_tick=decided, official_end_tick=end - 1, winner_side=winner_side, reason=reason))

        # Economy profile.
        def ev_for(team: str) -> int:
            if pistol:
                return rng.choice([700, 800, 850, 1000])
            r = (display * 7 + (0 if team == "A" else 3)) % 5
            return [900, 2400, 3600, 4800, 5600][r]

        # Who dies: the losing side all die unless bomb decides it.
        losers = [p for p in players if p[2] != winner_team]
        winners_p = [p for p in players if p[2] == winner_team]
        death_ticks: dict[str, int] = {}
        kill_window_end = plant_tick if plant_tick else decided
        n_loser_deaths = len(losers) if not plant_tick else rng.randint(1, 3)
        n_winner_deaths = rng.randint(0, 3)
        victims = rng.sample(losers, n_loser_deaths) + rng.sample(winners_p, n_winner_deaths)
        kt = freeze_end + int(8 * TICK_RATE)
        span = max(64, (kill_window_end - kt) // max(1, len(victims)))
        order = []
        for v in victims:
            kt += rng.randint(span // 2, span)
            kt = min(kt, decided - 1)
            order.append((kt, v))
        if order and not plant_tick:
            order[-1] = (decided, order[-1][1])  # last kill decides the round
        for kt_i, v in order:
            killers = [p for p in players if p[2] != v[2] and p[0] + p[1] not in death_ticks]
            if not killers:
                continue
            k = rng.choice(killers)
            death_ticks[v[0] + v[1]] = kt_i

        # Reconnect: team A player 3 disconnects in round 5 and reconnects at the start of round 6.
        gone: tuple[int, int] | None = None
        if display == 5:
            gone = (freeze_end + int(20 * TICK_RATE), end)
            acc.conns.append(dict(tick=gone[0], steamid=players[2][0], name=players[2][1], event="disconnect"))
        if display == 6:
            acc.conns.append(dict(tick=start + 32, steamid=players[2][0], name=players[2][1], event="connect"))

        carrier = next((p for p in players if p[2] == t_team and p[0] + p[1] not in death_ticks), next(p for p in players if p[2] == t_team))
        positions: dict[str, tuple[float, float, float]] = {}
        for sid, name, team in players:
            key = sid + name
            if sid in pov_missing and display % 2 == 0:
                continue  # POV fixture: these players are out of the recorder's view every other round
            side = a_side if team == "A" else ("T" if a_side == "CT" else "CT")
            spawn = pts["ct" if side == "CT" else "t"]
            goal = pts[site] if side == "T" else pts["A" if (hash(name) + display) % 2 else "B"]
            if name in ("Pike", "Ridge"):
                goal = pts["mid"]
            jitter = (rng.uniform(-80, 80), rng.uniform(-80, 80))
            ev_val = ev_for(team)
            acc.econ.append(dict(round_num=display, side=side, equipment_value=None, buy_type=None))
            inv = ["weapon_knife", "weapon_usp_silencer" if side == "CT" else "weapon_glock"]
            if ev_val >= 3600:
                inv.append("weapon_m4a1" if side == "CT" else "weapon_ak47")
                inv.append("weapon_smokegrenade")
            if key == carrier[0] + carrier[1]:
                inv.append("weapon_c4")
            death = death_ticks.get(key)
            prev_xyz = None
            for t in range(start, end, every):
                if gone and key == players[2][0] + players[2][1] and gone[0] <= t < gone[1]:
                    continue
                if t < freeze_end:
                    frac = 0.0
                else:
                    frac = min(1.0, (t - freeze_end) / max(1, (kill_window_end - freeze_end)))
                ease = 0.5 - 0.5 * math.cos(math.pi * frac)
                x = spawn[0] + (goal[0] - spawn[0]) * ease + jitter[0] + 30 * math.sin(t / 97.0 + len(name))
                y = spawn[1] + (goal[1] - spawn[1]) * ease + jitter[1] + 30 * math.cos(t / 89.0 + len(name))
                z = spawn[2] + (goal[2] - spawn[2]) * ease
                dead = death is not None and t >= death
                if dead and prev_xyz:
                    x, y, z = prev_xyz
                yaw = math.degrees(math.atan2(goal[1] - spawn[1], goal[0] - spawn[0])) + 25 * math.sin(t / 50.0)
                has_bomb = key == carrier[0] + carrier[1] and (plant_tick is None or t < plant_tick) and not dead
                acc.samples.append(
                    dict(
                        tick=t, steamid=sid, name=name, side=side, x=x, y=y, z=z, yaw=((yaw + 180) % 360) - 180,
                        health=0 if dead else 100, armor=0 if dead or pistol else 100,
                        money=max(0, 4000 - ev_val), equipment_value=ev_val,
                        active_weapon=None if dead else inv[2] if len(inv) > 2 else inv[1],
                        has_bomb=has_bomb, has_defuser=side == "CT" and ev_val >= 4800, has_helmet=ev_val >= 4800,
                        is_defusing=False, is_scoped=False, is_blinded=False,
                        clip=None if dead else max(0, 30 - ((t - start) // 256) % 31),
                        inventory=[] if dead else [x_ for x_ in inv if x_ != "weapon_c4" or has_bomb],
                    )
                )
                pt = acc.pos.setdefault((sid, name), ([], []))
                pt[0].append(t)
                pt[1].append((x, y, z))
                if not dead:
                    prev_xyz = (x, y, z)
                positions[key] = prev_xyz or (x, y, z)
            if death is not None:
                pass

        # Kill rows with positions at the death tick.
        for kt_i, v in order:
            vk = v[0] + v[1]
            if death_ticks.get(vk) != kt_i:
                continue
            killers = [p for p in players if p[2] != v[2]]
            k = killers[(kt_i // 7) % len(killers)]
            vx, vy, vz = _pos_at(acc.pos, v, kt_i)
            ax, ay, az = _pos_at(acc.pos, k, kt_i)
            acc.kills.append(
                dict(tick=kt_i, attacker_steamid=k[0], attacker_name=k[1], attacker_x=ax, attacker_y=ay, attacker_z=az,
                     victim_steamid=v[0], victim_name=v[1], victim_x=vx, victim_y=vy, victim_z=vz,
                     assister_steamid=None, weapon="ak47" if k[2] == t_team else "m4a1", headshot=(kt_i % 3 == 0),
                     penetrated=False, thrusmoke=(kt_i % 11 == 0), noscope=False, attackerblind=False)
            )

        # Bomb.
        if plant_tick:
            px, py, pz = pts[site]
            acc.bomb.append(dict(tick=plant_tick - int(3.2 * TICK_RATE), event="plant_begin", steamid=carrier[0], name=carrier[1], x=None, y=None, z=None, site=site))
            acc.bomb.append(dict(tick=plant_tick, event="plant", steamid=carrier[0], name=carrier[1], x=px, y=py, z=pz, site=site))
            if winner_side == "T":
                acc.bomb.append(dict(tick=decided, event="explode", steamid=None, name=None, x=px, y=py, z=pz, site=site))
            else:
                ct = next(p for p in players if p[2] != t_team)
                acc.bomb.append(dict(tick=decided - int(5 * TICK_RATE), event="defuse_begin", steamid=ct[0], name=ct[1], x=None, y=None, z=None, site=site))
                acc.bomb.append(dict(tick=decided, event="defuse", steamid=ct[0], name=ct[1], x=px, y=py, z=pz, site=site))
        elif display % 4 == 0:
            # Dropped and picked up mid-round.
            dt = freeze_end + int(10 * TICK_RATE)
            cx, cy, cz = _pos_at(acc.pos, carrier, dt)
            acc.bomb.append(dict(tick=dt, event="drop", steamid=carrier[0], name=carrier[1], x=cx, y=cy, z=cz, site=None))
            acc.bomb.append(dict(tick=dt + 128, event="pickup", steamid=carrier[0], name=carrier[1], x=None, y=None, z=None, site=None))

        # Utility: a smoke from each side, an HE into the CT smoke on odd rounds, a molotov.
        for team, target in (("A", "mid"), ("B", site)):
            thrower = next(p for p in players if p[2] == team)
            t0 = freeze_end + int(6 * TICK_RATE) + (0 if team == "A" else 64)
            sx, sy, sz = _pos_at(acc.pos, thrower, t0)
            gx, gy, gz = pts[target]
            ent = 400 + display * 10 + (0 if team == "A" else 1)
            flight = int(1.6 * TICK_RATE)
            for k_ in range(0, flight + 1, 4):
                f = k_ / flight
                acc.grenades.append(dict(entity_id=ent, grenade_type="smoke", thrower_steamid=thrower[0], thrower_name=thrower[1],
                                         tick=t0 + k_, x=sx + (gx - sx) * f, y=sy + (gy - sy) * f, z=sz + (gz - sz) * f + 200 * math.sin(math.pi * f)))
            acc.smokes.append(dict(entity_id=ent, thrower_steamid=thrower[0], thrower_name=thrower[1], start_tick=t0 + flight, end_tick=t0 + flight + int(18 * TICK_RATE), x=gx, y=gy, z=gz))
            if team == "B" and display % 2 == 1:
                he_thrower = next(p for p in players if p[2] == "A")
                h0 = t0 + flight + int(4 * TICK_RATE)
                hx, hy, hz = _pos_at(acc.pos, he_thrower, h0)
                hent = 900 + display
                hflight = int(1.2 * TICK_RATE)
                for k_ in range(0, hflight + 1, 4):
                    f = k_ / hflight
                    acc.grenades.append(dict(entity_id=hent, grenade_type="he", thrower_steamid=he_thrower[0], thrower_name=he_thrower[1],
                                             tick=h0 + k_, x=hx + (gx + 40 - hx) * f, y=hy + (gy - hy) * f, z=hz + (gz - hz) * f + 120 * math.sin(math.pi * f)))
                acc.dets.append(dict(tick=h0 + hflight, grenade_type="he", entity_id=hent, thrower_steamid=he_thrower[0], thrower_name=he_thrower[1], x=gx + 40, y=gy, z=gz))
        if display % 3 == 0:
            thrower = next(p for p in players if p[2] == t_team)
            f0 = freeze_end + int(25 * TICK_RATE)
            mx, my, mz = pts["mid"]
            # Detonation-only molotov (no projectile rows): the viewer must not invent a flight path.
            acc.fires.append(dict(entity_id=1200 + display, thrower_steamid=thrower[0], thrower_name=thrower[1], start_tick=f0, end_tick=f0 + int(7 * TICK_RATE), x=mx, y=my, z=mz))
        tick = end

    last_tick = tick
    s = pl.DataFrame(acc.samples) if acc.samples else pl.DataFrame()
    return RawDemo(
        map_name=params.get("header_map", map_name),
        tick_rate=TICK_RATE,
        source_type=source,
        header={"map_name": map_name, "client_name": "SYNTHETIC" if source == "gotv" else "Kestrel", "server_name": "synthetic"},
        convars={"mp_roundtime_defuse": "1.92", "mp_freezetime": "15", "mp_c4timer": "40", "mp_maxrounds": "24", "mp_overtime_maxrounds": "6"},
        rounds=pl.DataFrame(acc.rounds, schema_overrides={"end_tick": pl.Int64, "official_end_tick": pl.Int64, "winner_side": pl.Utf8, "reason": pl.Utf8}),
        samples=s,
        kills=pl.DataFrame(acc.kills, infer_schema_length=None),
        bomb=pl.DataFrame(acc.bomb, infer_schema_length=None, schema_overrides={"x": pl.Float64, "y": pl.Float64, "z": pl.Float64, "steamid": pl.Utf8, "name": pl.Utf8, "site": pl.Utf8}) if acc.bomb else pl.DataFrame(schema={"tick": pl.Int64, "event": pl.Utf8}),
        grenades=pl.DataFrame(acc.grenades),
        smokes=pl.DataFrame(acc.smokes),
        fires=pl.DataFrame(acc.fires) if acc.fires else pl.DataFrame(schema={"entity_id": pl.Int64, "start_tick": pl.Int64, "end_tick": pl.Int64, "x": pl.Float64, "y": pl.Float64, "z": pl.Float64}),
        detonations=pl.DataFrame(acc.dets) if acc.dets else pl.DataFrame(schema={"tick": pl.Int64, "grenade_type": pl.Utf8, "x": pl.Float64, "y": pl.Float64, "z": pl.Float64}),
        connections=pl.DataFrame(acc.conns) if acc.conns else pl.DataFrame(schema={"tick": pl.Int64, "steamid": pl.Utf8, "name": pl.Utf8, "event": pl.Utf8}),
        economy=None,
        last_tick=last_tick,
        parser_name="matchframe-synthetic",
        parser_version="1",
        synthetic=True,
        pov_steamid=players[0][0] if source == "pov" else None,
        clan_names=clans,
        warnings=["SYNTHETIC FIXTURE: generated data, not a real CS2 demo."],
    )


def _pos_at(pos: dict, player: tuple, tick: int) -> tuple[float, float, float]:
    ticks, xyz = pos.get((player[0], player[1]), ([], []))
    i = bisect.bisect_right(ticks, tick) - 1
    if i < 0:
        return (0.0, 0.0, 0.0)
    return xyz[i]
