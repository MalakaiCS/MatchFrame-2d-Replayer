"""Durable job semantics against a real PostgreSQL database."""

import dataclasses
import uuid

import pytest

from matchframe_worker import jobs, maintenance
from matchframe_worker.config import Config
from matchframe_worker.main import run_once
from matchframe_worker.storage import FsStorage
from matchframe_worker.synthetic import encode


@pytest.fixture
def env(db_url, tmp_path):
    cfg = Config(database_url=db_url, storage_fs_root=str(tmp_path / "obj"), work_dir=str(tmp_path / "work"),
                 allow_synthetic=True, worker_id="w-test", heartbeat_seconds=1)
    conn = jobs.connect(db_url)
    conn.execute("truncate jobs, replays, uploads cascade")
    uid = "u-" + uuid.uuid4().hex[:8]
    conn.execute('insert into "auth_user"(id, name, email, "emailVerified") values (%s, %s, %s, false)', (uid, "t", f"{uid}@x.test"))
    storage = FsStorage(cfg.storage_fs_root)
    yield cfg, conn, storage, uid
    conn.close()


def make_replay(conn, storage, uid, data: bytes, rev=1):
    rid = uuid.uuid4().hex
    key = f"uploads/{uid}/{rid}.dem"
    storage.put_bytes(key, data, "application/octet-stream")
    conn.execute(
        "insert into replays(id, owner_id, status, source_key, source_size, revision) values (%s,%s,'queued',%s,%s,%s)",
        (rid, uid, key, len(data), rev),
    )
    conn.execute("insert into jobs(replay_id, revision, kind) values (%s, %s, 'parse') on conflict do nothing", (rid, rev))
    return rid, key


def replay(conn, rid):
    return conn.execute("select * from replays where id = %s", (rid,)).fetchone()


def job(conn, rid):
    return conn.execute("select * from jobs where replay_id = %s order by id", (rid,)).fetchone()


def test_full_pipeline_publishes_and_removes_source(env):
    cfg, conn, storage, uid = env
    rid, key = make_replay(conn, storage, uid, encode({"map": "de_mirage", "winners": "ABAB"}))
    assert run_once(cfg, conn, storage)
    r = replay(conn, rid)
    assert r["status"] == "ready" and r["published_revision"] == 1
    assert r["map_id"] == "de_mirage" and r["round_count"] == 4 and (r["score_a"], r["score_b"]) == (2, 2)
    assert r["published_prefix"] == f"replays/{rid}/r1/a1"
    assert storage.exists(f"{r['published_prefix']}/manifest.json.gz")
    assert storage.exists(f"{r['published_prefix']}/rounds/r01.json.gz")
    assert r["source_key"] is None and not storage.exists(key)
    j = job(conn, rid)
    assert j["status"] == "succeeded" and j["result"]["rounds"] == 4 and "parseSeconds" in j["result"]


@pytest.mark.parametrize("compress", ["bz2", "zip"])
def test_compressed_upload_is_extracted_and_parsed(env, compress):
    import bz2, io, zipfile
    cfg, conn, storage, uid = env
    demo = encode({"map": "de_dust2", "winners": "ABA"})
    if compress == "bz2":
        data = bz2.compress(demo)
    else:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("match.dem", demo)
        data = buf.getvalue()
    rid, _ = make_replay(conn, storage, uid, data)
    assert run_once(cfg, conn, storage)
    r = replay(conn, rid)
    assert r["status"] == "ready" and r["map_id"] == "de_dust2" and r["round_count"] == 3


def test_multi_map_archive_becomes_a_series(env):
    import io, zipfile
    cfg, conn, storage, uid = env
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("teams-m2-dust2.dem", encode({"map": "de_dust2", "winners": "AB"}))
        z.writestr("teams-m1-mirage.dem", encode({"map": "de_mirage", "winners": "ABA"}))
    rid, _ = make_replay(conn, storage, uid, buf.getvalue())
    conn.execute("update replays set title = 'Grand final' where id = %s", (rid,))
    assert run_once(cfg, conn, storage)          # map 1 + fan-out
    child = conn.execute("select * from replays where id = %s", (rid + "M2",)).fetchone()
    assert child and child["series_id"] == rid and child["series_map_index"] == 2 and child["title"] == "Grand final · map 2"
    assert run_once(cfg, conn, storage)          # map 2
    parent = replay(conn, rid)
    assert parent["status"] == "ready" and parent["map_id"] == "de_mirage" and parent["series_map_index"] == 1
    assert replay(conn, rid + "M2")["map_id"] == "de_dust2" and replay(conn, rid + "M2")["status"] == "ready"
    # A retried fan-out does not duplicate maps.
    assert conn.execute("select count(*) as n from replays where series_id = %s", (rid,)).fetchone()["n"] == 2


def test_duplicate_enqueue_is_idempotent(env):
    cfg, conn, storage, uid = env
    rid, _ = make_replay(conn, storage, uid, encode({"winners": "AB"}))
    conn.execute("insert into jobs(replay_id, revision, kind) values (%s, 1, 'parse') on conflict do nothing", (rid,))
    assert conn.execute("select count(*) as n from jobs where replay_id = %s", (rid,)).fetchone()["n"] == 1


@pytest.mark.parametrize("data,code", [
    (b"definitely not a demo", "INVALID_DEMO"),
    (b"HL2DEMO\x00" + b"\x00" * 64, "LEGACY_DEMO"),
    (b"\x1f\x8b\x08\x00" + b"\x00" * 64, "ARCHIVE_CORRUPT"),
    (encode({"winners": "AB", "header_map": "de_unknownmap"}), "UNSUPPORTED_MAP"),
])
def test_permanent_failures_do_not_retry(env, data, code):
    cfg, conn, storage, uid = env
    rid, _ = make_replay(conn, storage, uid, data)
    run_once(cfg, conn, storage)
    r, j = replay(conn, rid), job(conn, rid)
    assert r["status"] == "failed" and r["failure_code"] == code
    assert j["status"] == "failed" and j["attempts"] == 1
    assert run_once(cfg, conn, storage) is False  # nothing left to claim


def test_synthetic_rejected_when_disabled(env):
    cfg, conn, storage, uid = env
    cfg = dataclasses.replace(cfg, allow_synthetic=False)
    rid, _ = make_replay(conn, storage, uid, encode({"winners": "AB"}))
    run_once(cfg, conn, storage)
    assert replay(conn, rid)["failure_code"] == "UNSUPPORTED_FORMAT"


def test_missing_source_asks_for_reupload(env):
    cfg, conn, storage, uid = env
    rid, key = make_replay(conn, storage, uid, encode({"winners": "AB"}))
    storage.delete(key)
    run_once(cfg, conn, storage)
    assert replay(conn, rid)["failure_code"] == "SOURCE_MISSING"


def test_expired_lease_is_reclaimed_and_stale_worker_cannot_publish(env):
    cfg, conn, storage, uid = env
    rid, _ = make_replay(conn, storage, uid, encode({"winners": "AB"}))
    a = jobs.claim(conn, "worker-a", 60)
    assert a and a["attempts"] == 1
    # worker-a stalls; its lease expires.
    conn.execute("update jobs set lease_expires_at = now() - interval '1 second' where id = %s", (a["id"],))
    assert jobs.heartbeat(conn, a["id"], "worker-a", 60) is False
    b = jobs.claim(conn, "worker-b", 60)
    assert b["id"] == a["id"] and b["attempts"] == 2 and b["lease_owner"] == "worker-b"
    manifest = {"map": {"id": "de_mirage", "registryVersion": "x"}, "teams": {"A": {"name": "A"}, "B": {"name": "B"}},
                "finalScore": {"A": 1, "B": 0}, "rounds": [{}], "sourceType": "gotv",
                "parser": {"name": "t", "version": "1"}, "schemaVersion": 1}
    assert jobs.publish(conn, b, "worker-b", "replays/x/r1/a2", manifest) is True
    # The stale worker finishes later and must not overwrite the successful replacement.
    assert jobs.publish(conn, a, "worker-a", "replays/x/r1/a1", manifest) is False
    assert replay(conn, rid)["published_prefix"] == "replays/x/r1/a2"


def test_superseded_revision_cannot_publish(env):
    cfg, conn, storage, uid = env
    rid, _ = make_replay(conn, storage, uid, encode({"winners": "AB"}))
    a = jobs.claim(conn, "worker-a", 60)
    conn.execute("update replays set revision = 2 where id = %s", (rid,))
    manifest = {"map": {"id": "m", "registryVersion": "x"}, "teams": {"A": {"name": "A"}, "B": {"name": "B"}},
                "finalScore": {"A": 0, "B": 0}, "rounds": [], "sourceType": "gotv", "parser": {"name": "t", "version": "1"}, "schemaVersion": 1}
    assert jobs.publish(conn, a, "worker-a", "p", manifest) is False


def test_transient_failure_backs_off(env):
    cfg, conn, storage, uid = env
    rid, _ = make_replay(conn, storage, uid, encode({"winners": "AB"}))
    j = jobs.claim(conn, "w", 60)
    jobs.retry_later(conn, j, "w", "TRANSIENT", "storage down", 30, 900)
    row = job(conn, rid)
    assert row["status"] == "queued" and row["lease_owner"] is None
    assert conn.execute("select next_run_at > now() + interval '25 seconds' as later from jobs where id = %s", (j["id"],)).fetchone()["later"]
    assert jobs.claim(conn, "w", 60) is None  # not due yet


def test_repeated_crashes_stop_after_max_attempts(env):
    cfg, conn, storage, uid = env
    rid, _ = make_replay(conn, storage, uid, encode({"winners": "AB"}))
    conn.execute("update jobs set attempts = max_attempts, status = 'running', lease_owner = 'dead', lease_expires_at = now() - interval '1 s'")
    assert jobs.claim(conn, "w", 60) is None
    assert replay(conn, rid)["failure_code"] == "WORKER_CRASH"


def test_worker_restart_resumes(env):
    """A worker that dies mid-job leaves a running job; after lease expiry another worker completes it."""
    cfg, conn, storage, uid = env
    rid, _ = make_replay(conn, storage, uid, encode({"winners": "ABA"}))
    jobs.claim(conn, "crashed-worker", 60)
    conn.execute("update jobs set lease_expires_at = now() - interval '1 second'")
    assert run_once(cfg, conn, storage)
    assert replay(conn, rid)["status"] == "ready"
    assert job(conn, rid)["attempts"] == 2


def test_cleanup_job_removes_objects(env):
    cfg, conn, storage, uid = env
    rid, _ = make_replay(conn, storage, uid, encode({"winners": "AB"}))
    run_once(cfg, conn, storage)
    prefix = replay(conn, rid)["published_prefix"]
    storage.put_bytes(f"audio/{rid}/t1.mp3", b"ID3", "audio/mpeg")
    conn.execute("update replays set status = 'deleted', deleted_at = now() where id = %s", (rid,))
    conn.execute("insert into jobs(replay_id, revision, kind) values (%s, 1, 'cleanup')", (rid,))
    run_once(cfg, conn, storage)
    assert not storage.exists(f"{prefix}/manifest.json.gz")
    assert not storage.exists(f"audio/{rid}/t1.mp3")


def test_maintenance_expires_uploads_and_abandoned_prefixes(env):
    cfg, conn, storage, uid = env
    storage.put_bytes("uploads/u/stale.dem", b"x", "application/octet-stream")
    conn.execute(
        "insert into uploads(id, owner_id, object_key, filename, declared_size, max_bytes, expires_at) "
        "values ('up1', %s, 'uploads/u/stale.dem', 'a.dem', 1, 10, now() - interval '1 hour')", (uid,))
    rid, _ = make_replay(conn, storage, uid, encode({"winners": "AB"}))
    run_once(cfg, conn, storage)
    storage.put_bytes(f"replays/{rid}/r1/a9/manifest.json.gz", b"orphan", "application/json")
    conn.execute("update jobs set finished_at = now() - interval '2 hours'")
    stats = maintenance.run(dataclasses.replace(cfg, abandoned_revision_age_s=60), conn, storage)
    assert stats["expiredUploads"] == 1 and stats["abandonedPrefixes"] == 1
    assert not storage.exists("uploads/u/stale.dem")
    assert not storage.exists(f"replays/{rid}/r1/a9/manifest.json.gz")
    assert storage.exists(f"{replay(conn, rid)['published_prefix']}/manifest.json.gz")


def test_priority_jobs_are_claimed_first(env):
    cfg, conn, storage, uid = env
    normal, _ = make_replay(conn, storage, uid, encode({"map": "de_mirage", "winners": "AB"}))
    paid, _ = make_replay(conn, storage, uid, encode({"map": "de_mirage", "winners": "BA"}))
    conn.execute("update jobs set priority = 1 where replay_id = %s", (paid,))
    first = jobs.claim(conn, "w-a", 60)
    assert first["replay_id"] == paid
    second = jobs.claim(conn, "w-b", 60)
    assert second["replay_id"] == normal
