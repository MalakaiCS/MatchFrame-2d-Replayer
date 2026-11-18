"""Worker entry point: poll for jobs, process them, run maintenance periodically."""

from __future__ import annotations

import logging
import signal
import time

from . import jobs, maintenance
from .config import Config
from .errors import JobError, LeaseLost
from .pipeline import process_cleanup, process_parse
from .storage import make_storage

log = logging.getLogger("matchframe_worker")
_stop = False


def _sigterm(*_):
    global _stop
    _stop = True


def run_once(cfg: Config, conn, storage) -> bool:
    job = jobs.claim(conn, cfg.worker_id, cfg.lease_seconds)
    if not job:
        return False
    log.info("claimed job %s (%s, replay %s, attempt %s)", job["id"], job["kind"], job["replay_id"], job["attempts"])
    try:
        if job["kind"] == "cleanup":
            process_cleanup(cfg, conn, storage, job)
        else:
            process_parse(cfg, conn, storage, job)
    except LeaseLost as e:
        log.warning("job %s: %s", job["id"], e)
    except JobError as e:
        if e.permanent:
            log.info("job %s failed permanently: %s %s", job["id"], e.code, e)
            jobs.fail(conn, job, cfg.worker_id, e.code, str(e))
        else:
            log.warning("job %s transient failure: %s", job["id"], e)
            jobs.retry_later(conn, job, cfg.worker_id, e.code, str(e), cfg.backoff_base_s, cfg.backoff_max_s)
    except Exception as e:  # noqa: BLE001 - unknown errors are treated as transient
        log.exception("job %s crashed", job["id"])
        jobs.retry_later(conn, job, cfg.worker_id, "INTERNAL", f"{type(e).__name__}", cfg.backoff_base_s, cfg.backoff_max_s)
    return True


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    cfg = Config()
    storage = make_storage(cfg)
    signal.signal(signal.SIGTERM, _sigterm)
    signal.signal(signal.SIGINT, _sigterm)
    log.info("worker %s starting (storage=%s, synthetic=%s)", cfg.worker_id, cfg.storage_driver, cfg.allow_synthetic)
    last_maint = 0.0
    conn = None
    while not _stop:
        try:
            if conn is None or conn.closed:
                conn = jobs.connect(cfg.database_url)
            if time.monotonic() - last_maint > cfg.maintenance_every_s:
                maintenance.run(cfg, conn, storage)
                last_maint = time.monotonic()
            if not run_once(cfg, conn, storage):
                time.sleep(cfg.poll_seconds)
        except Exception:  # noqa: BLE001
            log.exception("worker loop error; reconnecting")
            try:
                conn and conn.close()
            except Exception:  # noqa: BLE001
                pass
            conn = None
            time.sleep(5)
    log.info("worker stopping")


if __name__ == "__main__":
    main()
