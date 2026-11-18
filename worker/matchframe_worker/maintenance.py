"""Scheduled cleanup. Runs inside the worker under a Postgres advisory lock (one runner at a time)."""

from __future__ import annotations

import logging

from .config import Config
from .storage import Storage

log = logging.getLogger(__name__)
LOCK = 727275


def run(cfg: Config, conn, storage: Storage) -> dict:
    stats = {"expiredUploads": 0, "sources": 0, "abandonedPrefixes": 0}
    got = conn.execute("select pg_try_advisory_lock(%s) as ok", (LOCK,)).fetchone()["ok"]
    if not got:
        return stats
    try:
        # 1. Incomplete uploads past their slot expiry.
        for u in conn.execute(
            "select id, object_key from uploads where status = 'pending' and expires_at < now() - interval '10 minutes' limit 200"
        ).fetchall():
            storage.delete(u["object_key"])
            conn.execute("update uploads set status = 'expired' where id = %s and status = 'pending'", (u["id"],))
            stats["expiredUploads"] += 1

        # 2. Source demos past their expiry (failed/pending sources, or a retried post-publish cleanup).
        for r in conn.execute(
            "select id, source_key, status from replays where source_key is not null and source_expires_at < now() "
            "and status in ('ready', 'failed', 'deleted', 'queued') "
            "and not exists (select 1 from jobs j where j.replay_id = replays.id and j.status = 'running') limit 200"
        ).fetchall():
            storage.delete(r["source_key"])
            conn.execute("update replays set source_key = null where id = %s", (r["id"],))
            if r["status"] == "queued":
                conn.execute(
                    "update replays set status = 'failed', failure_code = 'SOURCE_MISSING', "
                    "failure_detail = 'The uploaded demo expired before processing. Upload it again.' where id = %s",
                    (r["id"],),
                )
                conn.execute("update jobs set status = 'failed', last_error = 'SOURCE_MISSING', finished_at = now() "
                             "where replay_id = %s and status = 'queued'", (r["id"],))
            stats["sources"] += 1

        # 3. Abandoned revision/attempt prefixes for recently finished jobs.
        for r in conn.execute(
            "select distinct r.id, r.published_prefix from replays r join jobs j on j.replay_id = r.id "
            "where j.finished_at > now() - interval '2 days' and j.finished_at < now() - make_interval(secs => %s) "
            "and r.status in ('ready', 'failed') "
            "and not exists (select 1 from jobs k where k.replay_id = r.id and k.status in ('queued', 'running'))",
            (cfg.abandoned_revision_age_s,),
        ).fetchall():
            for rev in storage.list_prefixes(f"replays/{r['id']}"):
                for att in storage.list_prefixes(rev):
                    if att != r["published_prefix"]:
                        storage.delete_prefix(att)
                        stats["abandonedPrefixes"] += 1
    finally:
        conn.execute("select pg_advisory_unlock(%s)", (LOCK,))
    if any(stats.values()):
        log.info("maintenance %s", stats)
    return stats
