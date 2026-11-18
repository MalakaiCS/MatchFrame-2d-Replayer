import polars as pl
import pytest

from matchframe_worker.errors import NoPlayableRounds, UnsupportedMap
from matchframe_worker.maps import get_map
from matchframe_worker.synthetic import generate
from matchframe_worker.transform import TransformConfig, build, classify_buy, player_id

from matchframe_worker.config import _default_registry

REGISTRY = _default_registry()


def test_round_count_score_and_restart(mirage):
    m = mirage.manifest
    assert len(m["rounds"]) == 29
    assert m["finalScore"] == {"A": 16, "B": 13}
    assert [e["reason"] for e in m["excludedRounds"]] == ["before match restart"]
    assert [r["displayNumber"] for r in m["rounds"]] == list(range(1, 30))
    assert len({r["id"] for r in m["rounds"]}) == 29


def test_boundaries_end_exclusive_and_contiguous(mirage):
    rs = mirage.manifest["rounds"]
    for a, b in zip(rs, rs[1:]):
        assert a["endTick"] == b["startTick"]
    for r in rs:
        assert r["startTick"] < r["freezeEndTick"] <= r["decidedTick"] < r["endTick"]
        p = mirage.payloads[r["id"]]
        for t in p["tracks"]:
            assert all(r["startTick"] <= x < r["endTick"] for x in t["t"])
        assert all(r["startTick"] <= e["tick"] < r["endTick"] for e in p["events"])


def test_score_progression(mirage):
    rs = mirage.manifest["rounds"]
    for a, b in zip(rs, rs[1:]):
        assert a["scoreAfter"] == b["scoreBefore"]
    for r in rs:
        diff = {k: r["scoreAfter"][k] - r["scoreBefore"][k] for k in "AB"}
        assert diff[r["winner"]] == 1 and sum(diff.values()) == 1


def test_stable_team_identity_through_side_swaps(mirage):
    m = mirage.manifest
    team = {p["id"]: p["team"] for p in m["players"]}
    assert team["s:76561198000000001"] == "A" and team["s:76561198000000011"] == "B"
    sides = [r["sides"]["A"] for r in m["rounds"]]
    assert sides[:12] == ["CT"] * 12 and sides[12:24] == ["T"] * 12
    assert sides[24:27] == ["CT"] * 3 and sides[27:] == ["T"] * 2
    assert m["teams"]["A"]["name"] == "Northwind" and m["teams"]["B"]["name"] == "Harbour Five"


def test_pistol_and_overtime_flags(mirage):
    rs = mirage.manifest["rounds"]
    assert [r["displayNumber"] for r in rs if r["isPistol"]] == [1, 13]
    assert [r["displayNumber"] for r in rs if r["isOvertime"]] == list(range(25, 30))
    assert [r["displayNumber"] for r in rs if r["isOvertimeHalfStart"]] == [25, 28]
    assert rs[0]["economy"]["A"]["buyType"] == "pistol"


def test_buy_thresholds():
    c = TransformConfig()
    assert classify_buy(None, False, c) is None
    assert classify_buy(None, True, c) == "pistol"
    assert classify_buy(4999, False, c) == "eco"
    assert classify_buy(5000, False, c) == "half_buy"
    assert classify_buy(19999, False, c) == "half_buy"
    assert classify_buy(20000, False, c) == "full_buy"


def test_unknown_economy_keeps_pistol(mirage_raw):
    raw = generate({"map": "de_mirage", "winners": "ABABABABABAB" + "AB"})
    raw.samples = raw.samples.drop("equipment_value")
    res = build(raw, get_map(REGISTRY, "de_mirage"), replay_id="x", revision=1, prefix="p", sample_every=4)
    r = res.manifest["rounds"]
    assert r[0]["economy"]["A"]["buyType"] == "pistol"
    assert r[1]["economy"]["A"]["buyType"] is None and r[1]["economy"]["A"]["equipmentValue"] is None
    assert res.manifest["capabilities"]["economy"] is False


def test_events_sorted_with_deterministic_order(mirage):
    for p in mirage.payloads.values():
        keys = [(e["tick"], e["order"]) for e in p["events"]]
        assert keys == sorted(keys)
        assert len({e["id"] for e in p["events"]}) == len(p["events"])


def test_inventory_changes_ordered_by_tick(mirage):
    for p in mirage.payloads.values():
        ticks = [c["tick"] for c in p["inventory"]]
        assert ticks == sorted(ticks)


def test_kills_have_actor_target_and_position(mirage):
    kills = [e for p in mirage.payloads.values() for e in p["events"] if e["type"] == "kill"]
    assert kills
    for k in kills:
        assert k["target"] and k["position"] is not None and k["provenance"] == "recorded"


def test_bot_and_reconnect_identity(mirage):
    ids = {p["id"] for p in mirage.manifest["players"]}
    assert "b:BOT Ivy" in ids
    assert player_id("0", "BOT Ivy") == "b:BOT Ivy"
    r5, r6 = mirage.payloads["r05"], mirage.payloads["r06"]
    assert any(e["type"] == "disconnect" and e["actor"] == "s:76561198000000003" for e in r5["events"])
    assert any(e["type"] == "reconnect" and e["actor"] == "s:76561198000000003" for e in r6["events"])
    assert "s:76561198000000003" in {t["playerId"] for t in r6["tracks"]}
    assert len(ids) == 10


def test_discontinuities_flag_first_sample_and_death(mirage):
    for t in mirage.payloads["r02"]["tracks"]:
        assert t["disc"][0] == 1
        for i in range(1, len(t["alive"])):
            if t["alive"][i] != t["alive"][i - 1]:
                assert t["disc"][i] == 1


def test_detonation_only_fire_has_no_invented_path(mirage):
    p = mirage.payloads["r03"]
    fire = next(e for e in p["effects"] if e["kind"] == "fire")
    g = next(g for g in p["grenades"] if g["id"] == fire["grenadeId"])
    assert g["path"] == [] and g["detonation"] is not None
    assert fire["radiusSource"] == "configured-estimate"


def test_smoke_disruption_inferred(mirage):
    p = mirage.payloads["r05"]
    smokes = [e for e in p["effects"] if e["kind"] == "smoke"]
    d = [x for s in smokes for x in s["disruptions"]]
    assert len(d) == 1 and d[0]["provenance"] == "inferred"
    assert any(e["type"] == "smoke_disrupted" and e["provenance"] == "inferred" for e in p["events"])
    assert mirage.manifest["capabilities"]["smokeDisruption"] == "inferred"
    # Even rounds have no HE into smoke.
    assert not any(x for s in mirage.payloads["r02"]["effects"] if s["kind"] == "smoke" for x in s["disruptions"])


def test_bomb_lifecycle(mirage):
    for r in mirage.manifest["rounds"]:
        b = mirage.payloads[r["id"]]["bomb"]
        states = [x["state"] for x in b]
        if r["bombPlanted"]:
            assert "planted" in states
            assert states[-1] in ("defused", "exploded")
            planted = next(x for x in b if x["state"] == "planted")
            assert planted["position"] is not None and planted["site"] in ("A", "B")
        ticks = [x["tick"] for x in b]
        assert ticks == sorted(ticks)
    r04 = mirage.payloads["r04"]["bomb"]
    drop = next(x for x in r04 if x["state"] == "dropped")
    assert drop["position"] is not None


def test_concurrent_grenades_same_thrower_not_merged():
    raw = generate({"map": "de_mirage", "winners": "AB"})
    rows = raw.grenades.filter(pl.col("entity_id") == 411)
    clone = rows.with_columns(pl.lit(9411, dtype=rows.schema["entity_id"]).alias("entity_id"), (pl.col("x") + 600).alias("x"))
    raw.grenades = pl.concat([raw.grenades, clone])
    res = build(raw, get_map(REGISTRY, "de_mirage"), replay_id="x", revision=1, prefix="p", sample_every=4)
    smokes = [g for g in res.payloads["r01"]["grenades"] if g["type"] == "smoke"]
    assert len(smokes) == 3
    assert len({g["id"] for g in smokes}) == 3


def test_pov_partial_coverage():
    raw = generate({"map": "de_mirage", "source": "pov", "winners": "ABAB"})
    res = build(raw, get_map(REGISTRY, "de_mirage"), replay_id="x", revision=1, prefix="p", sample_every=4)
    m = res.manifest
    assert m["sourceType"] == "pov" and m["capabilities"]["participants"] == "partial"
    assert m["povPlayerId"] == "s:76561198000000001"
    cov = m["rounds"][1]["coverage"]
    assert cov["s:76561198000000013"] == 0.0 and cov["s:76561198000000014"] == 0.0
    assert cov["s:76561198000000001"] > 0.9


def test_nuke_floors():
    raw = generate({"map": "de_nuke", "winners": "ABAB"})
    nuke = get_map(REGISTRY, "de_nuke")
    assert nuke.floor_of(-770) == (1, False)
    assert nuke.floor_of(-410) == (0, False)
    assert nuke.floor_of(-500)[1] is True  # inside the uncertainty band
    res = build(raw, nuke, replay_id="x", revision=1, prefix="p", sample_every=4)
    floors = {f for p in res.payloads.values() for t in p["tracks"] for f in t["floor"]}
    assert floors == {0, 1}
    assert res.manifest["capabilities"]["floors"] == "rule-based"


def test_unsupported_map():
    with pytest.raises(UnsupportedMap):
        get_map(REGISTRY, "de_cache_unknown")


def test_incomplete_rounds_and_none_playable():
    raw = generate({"map": "de_mirage", "winners": "AB"})
    raw.rounds = raw.rounds.with_columns(pl.lit(None, dtype=pl.Utf8).alias("winner_side"))
    with pytest.raises(NoPlayableRounds):
        build(raw, get_map(REGISTRY, "de_mirage"), replay_id="x", revision=1, prefix="p", sample_every=4)


def test_knife_round_excluded():
    raw = generate({"map": "de_mirage", "winners": "ABA"})
    first = raw.rounds.filter(pl.col("round_num") == 1).filter(pl.col("winner_side").is_not_null())
    lo, hi = first["start_tick"][0], first["official_end_tick"][0]
    raw.samples = raw.samples.with_columns(
        pl.when((pl.col("tick") >= lo) & (pl.col("tick") <= hi)).then(pl.lit(["weapon_knife"])).otherwise(pl.col("inventory")).alias("inventory")
    )
    res = build(raw, get_map(REGISTRY, "de_mirage"), replay_id="x", revision=1, prefix="p", sample_every=4)
    assert len(res.manifest["rounds"]) == 2
    assert any(e["reason"] == "knife round" for e in res.manifest["excludedRounds"])


def test_side_strings_from_awpy_are_normalised():
    from matchframe_worker.transform import _norm_side

    assert _norm_side("counter-terrorist") == "CT" and _norm_side("terrorist") == "T"
    assert _norm_side(3) == "CT" and _norm_side(2) == "T" and _norm_side(None) is None
