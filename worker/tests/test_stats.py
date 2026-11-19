"""Per-round player stats: openings, trades, clutches, KAST, damage capping, flashes."""
import polars as pl

from matchframe_worker.stats import round_player_stats, summarize
from matchframe_worker.transform import player_id

TR = 64.0
SIDES = {"s:1": "CT", "s:2": "CT", "s:3": "CT", "s:4": "T", "s:5": "T"}


def kill(tick, att, vic, assister=None, hs=False, flash=False):
    return {"tick": tick, "attacker_steamid": att, "attacker_name": f"p{att}", "victim_steamid": vic, "victim_name": f"p{vic}",
            "assister_steamid": assister, "assister_name": None if assister is None else f"p{assister}",
            "headshot": hs, "assist_flash": flash, "weapon": "ak47"}


def hurt(tick, att, vic, dmg, weapon="ak47"):
    return {"tick": tick, "attacker_steamid": att, "attacker_name": f"p{att}", "victim_steamid": vic, "victim_name": f"p{vic}",
            "dmg_health": dmg, "health_pre": 100, "health_post": 0, "weapon": weapon}


def run(kills, damages=None, blinds=None, winner="T", decided=None):
    return round_player_stats(
        start=0, end=10_000, decided=decided, sides=dict(SIDES), winner_side=winner,
        kills=pl.DataFrame(kills), damages=pl.DataFrame(damages) if damages else None,
        blinds=pl.DataFrame(blinds) if blinds else None, pid_of=player_id, tick_rate=TR,
        equipment={"s:1": 4700},
    )


def test_opening_trade_clutch_and_kast():
    s = run([
        kill(100, "4", "1", hs=True),            # T opens on CT 1
        kill(200, "2", "4", assister="3"),       # CT 2 trades within 5 s; CT 3 assists
        kill(2000, "5", "2"),                     # T 5 kills CT 2 (not traded: nobody kills 5 in time)
        kill(2100, "5", "3"),
    ], winner="T")
    assert s["s:4"]["ok"] == 1 and s["s:1"]["od"] == 1
    assert s["s:4"]["hs"] == 1
    assert s["s:1"]["trd"] == 1 and s["s:2"]["trk"] == 1
    assert s["s:3"]["a"] == 1
    # After 2's death at 2000, CT 3 is alone vs T 5 -> 1v1 clutch, lost (T won).
    assert s["s:3"]["cl"] == 1 and s["s:3"]["cw"] == 0
    # T 4 dies at 200 leaving T 5 alone against two CTs -> 1v2 clutch, won.
    assert s["s:5"]["cl"] == 2 and s["s:5"]["cw"] == 1
    # KAST: 1 traded, 2 kill, 3 assist, 4 kill, 5 kill+survived.
    assert [s[p]["kast"] for p in ("s:1", "s:2", "s:3", "s:4", "s:5")] == [1, 1, 1, 1, 1]
    assert s["s:5"]["surv"] == 1 and s["s:1"]["surv"] == 0
    assert s["s:1"]["eq"] == 4700


def test_flash_assist_counts_as_assist_and_team_kill_is_separate():
    s = run([kill(100, "1", "4", assister="2", flash=True), kill(150, "1", "2")])
    assert s["s:2"]["a"] == 1 and s["s:2"]["fa"] == 1
    assert s["s:1"]["k"] == 1 and s["s:1"]["tk"] == 1


def test_damage_is_capped_by_tracked_health_and_stops_when_round_is_decided():
    s = run([], damages=[
        hurt(10, "1", "4", 78),
        hurt(20, "2", "4", 90),          # only 22 health left: counts 22
        hurt(30, "1", "5", 30, "hegrenade"),
        hurt(40, "1", "2", 50),          # team damage: ignored
        hurt(9000, "1", "5", 40),        # after the round was decided: ignored
    ], decided=5000)
    assert s["s:1"]["dmg"] == 78 + 30 and s["s:1"]["ud"] == 30
    assert s["s:2"]["dmg"] == 22


def test_enemies_flashed_ignores_teammates():
    blinds = [
        {"tick": 50, "attacker_steamid": "4", "attacker_name": "p4", "victim_steamid": "1", "victim_name": "p1", "duration": 2.5},
        {"tick": 51, "attacker_steamid": "4", "attacker_name": "p4", "victim_steamid": "5", "victim_name": "p5", "duration": 3.0},
    ]
    s = run([], blinds=blinds)
    assert s["s:4"]["ef"] == 1 and s["s:4"]["fd"] == 2.5


def test_summarize_counts_multikills_and_clutches():
    r1 = run([kill(100, "4", "1"), kill(200, "4", "2"), kill(300, "4", "3")])
    tot = summarize([r1, r1])
    assert tot["s:4"]["k"] == 6 and tot["s:4"]["3k"] == 2 and tot["s:4"]["rounds"] == 2
