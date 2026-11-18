"""Durable job queue on PostgreSQL: claim with lease, heartbeat, retry with backoff, guarded publish."""

from __future__ import annotations

import json
import logging
import threading
from datetime import timedelta

import psycopg
from psycopg.rows import dict_row

log = logging.getLogger(__name__)

CLAIM_SQL = """
update jobs j set
  status = 'running',
  attempts = j.attempts + 1,
  lease_owner = %(owner)s,
  lease_expires_at = now() + make_interval(secs => %(lease)s),
  updated_at = now()
where j.id = (
  select id from jobs
  where kind = any(%(kinds)s::job_kind[])
    and ((status = 'queued' and next_run_at <= now())
      or (status = 'running' and lease_expires_at < now()))
  order by next_run_at, id
  for update skip locked
  limit 1
)
returning j.*
"""


def connect(url: str) -> psycopg.Connection:
    return psycopg.connect(url, autocommit=True, row_factory=dict_row)


def claim(conn: psycopg.Connection, owner: str, lease_s: int, kinds=("parse", "cleanup")) -> dict | None:
    row = conn.execute(CLAIM_SQL, {"owner": owner, "lease": lease_s, "kinds": list(kinds)}).fetchone()
    if row and row["attempts"] > row["max_attempts"]:
        # A job that keeps losing its lease (e.g. the worker is OOM-killed) stops here.
        fail(conn, row, owner, "WORKER_CRASH", "Processing stopped repeatedly. Upload the demo again or contact support.")
        return None
    return row


def heartbeat(conn: psycopg.Connection, job_id: int, owner: str, lease_s: int) -> bool:
    cur = conn.execute(
        "update jobs set lease_expires_at = now() + make_interval(secs => %s), updated_at = now() "
        "where id = %s and lease_owner = %s and status = 'running' and lease_expires_at > now()",
        (lease_s, job_id, owner),
    )
    return cur.rowcount == 1


class Heartbeat:
    """Background lease renewal. `lost` is set when renewal fails; the job must then stop."""

    def __init__(self, url: str, job_id: int, owner: str, lease_s: int, every_s: int):
        self.lost = threading.Event()
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, args=(url, job_id, owner, lease_s, every_s), daemon=True)

    def _run(self, url, job_id, owner, lease_s, every_s):
        try:
            with connect(url) as c:
                while not self._stop.wait(every_s):
                    if not heartbeat(c, job_id, owner, lease_s):
                        log.warning("lease lost for job %s", job_id)
                        self.lost.set()
                        return
        except Exception:  # noqa: BLE001
            log.exception("heartbeat failed for job %s", job_id)
            self.lost.set()

    def __enter__(self):
        self._t.start()
        return self

    def __exit__(self, *a):
        self._stop.set()
        self._t.join(timeout=5)


def retry_later(conn, job: dict, owner: str, code: str, msg: str, base_s: int, max_s: int) -> None:
    delay = min(max_s, base_s * (2 ** max(0, job["attempts"] - 1)))
    if job["attempts"] >= job["max_attempts"]:
        fail(conn, job, owner, code, msg)
        return
    conn.execute(
        "update jobs set status = 'queued', lease_owner = null, lease_expires_at = null, "
        "next_run_at = now() + make_interval(secs => %s), last_error = %s, updated_at = now() "
        "where id = %s and lease_owner = %s",
        (delay, f"{code}: {msg}", job["id"], owner),
    )
    conn.execute("update replays set status = 'queued', updated_at = now() where id = %s and revision = %s and status = 'processing'",
                 (job["replay_id"], job["revision"]))


def fail(conn, job: dict, owner: str, code: str, msg: str) -> None:
    with conn.transaction():
        cur = conn.execute(
            "update jobs set status = 'failed', lease_owner = null, lease_expires_at = null, last_error = %s, "
            "result = %s, finished_at = now(), updated_at = now() where id = %s and (lease_owner = %s or lease_owner is null)",
            (f"{code}: {msg}", json.dumps({"code": code, "message": msg}), job["id"], owner),
        )
        if cur.rowcount and job["kind"] == "parse":
            conn.execute(
                "update replays set status = 'failed', failure_code = %s, failure_detail = %s, updated_at = now(), "
                "source_expires_at = least(coalesce(source_expires_at, 'infinity'), now() + interval '1 day') "
                "where id = %s and revision = %s and status <> 'deleted' and (published_revision is null)",
                (code, msg, job["replay_id"], job["revision"]),
            )


PUBLISH_SQL = """
with lease as (
  select id from jobs
  where id = %(job)s and lease_owner = %(owner)s and status = 'running' and lease_expires_at > now()
  for update
)
update replays set
  status = 'ready', published_revision = %(rev)s, published_prefix = %(prefix)s,
  failure_code = null, failure_detail = null,
  map_id = %(map)s, team_a_name = %(ta)s, team_b_name = %(tb)s, score_a = %(sa)s, score_b = %(sb)s,
  round_count = %(rounds)s, source_type = %(src)s, parser_version = %(pv)s, schema_version = %(sv)s,
  asset_version = %(av)s, updated_at = now()
where id = %(replay)s and revision = %(rev)s and deleted_at is null
  and exists (select 1 from lease)
returning id
"""


def publish(conn, job: dict, owner: str, prefix: str, manifest: dict) -> bool:
    """Conditionally publish. Returns False when the lease is no longer ours or the replay moved on."""
    with conn.transaction():
        row = conn.execute(
            PUBLISH_SQL,
            {
                "job": job["id"], "owner": owner, "rev": job["revision"], "prefix": prefix, "replay": job["replay_id"],
                "map": manifest["map"]["id"], "ta": manifest["teams"]["A"]["name"], "tb": manifest["teams"]["B"]["name"],
                "sa": manifest["finalScore"]["A"], "sb": manifest["finalScore"]["B"], "rounds": len(manifest["rounds"]),
                "src": manifest["sourceType"], "pv": f"{manifest['parser']['name']} {manifest['parser']['version']}",
                "sv": manifest["schemaVersion"], "av": manifest["map"]["registryVersion"],
            },
        ).fetchone()
        if not row:
            return False
        conn.execute(
            "update jobs set status = 'succeeded', lease_owner = null, lease_expires_at = null, finished_at = now(), "
            "updated_at = now(), result = %s where id = %s",
            (json.dumps({"prefix": prefix, "rounds": len(manifest["rounds"])}), job["id"]),
        )
        return True


def complete(conn, job: dict, owner: str, result: dict) -> None:
    conn.execute(
        "update jobs set status = 'succeeded', lease_owner = null, lease_expires_at = null, finished_at = now(), "
        "updated_at = now(), result = %s where id = %s and lease_owner = %s",
        (json.dumps(result), job["id"], owner),
    )


def lease_timedelta(s: int) -> timedelta:
    return timedelta(seconds=s)
