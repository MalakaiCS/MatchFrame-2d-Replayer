"""Process one claimed job."""

from __future__ import annotations

import json
import logging
import resource
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import jobs
from .config import Config
from .demo_header import classify_header
from .errors import DemoTooLarge, JobError, LeaseLost, ParseResourceLimit, SourceMissing, TransientError
from .storage import Storage

log = logging.getLogger(__name__)


def _limits(mem: int):
    def apply():
        resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    return apply


def run_parse_child(cfg: Config, params: dict, workdir: Path) -> tuple[dict | None, dict]:
    pfile = workdir / "params.json"
    pfile.write_text(json.dumps(params))
    t0 = time.monotonic()
    before = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "matchframe_worker.parse_child", str(pfile)],
            preexec_fn=_limits(cfg.parse_memory_bytes), timeout=cfg.parse_timeout_s,
            capture_output=True, text=True,
        )
    except subprocess.TimeoutExpired as e:
        raise ParseResourceLimit("Parsing took longer than the configured limit.") from e
    stats = {
        "parseSeconds": round(time.monotonic() - t0, 2),
        "peakChildRssKiB": max(before, resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss),
    }
    out = Path(params["out_dir"])
    if proc.returncode == 0:
        return json.loads((out / "manifest.json").read_text()), stats
    err_file = out / "error.json"
    if err_file.exists():
        err = json.loads(err_file.read_text())
        e = JobError(err["message"], code=err["code"])
        e.permanent = err["permanent"]
        raise e
    if proc.returncode < 0:
        raise ParseResourceLimit(f"The parser was stopped by signal {-proc.returncode} (resource limit).")
    log.error("parser crashed: %s", proc.stderr[-4000:])
    raise TransientError("parser process crashed")


def process_parse(cfg: Config, conn, storage: Storage, job: dict) -> None:
    owner = cfg.worker_id
    rep = conn.execute("select * from replays where id = %s", (job["replay_id"],)).fetchone()
    if rep is None or rep["deleted_at"] is not None:
        jobs.complete(conn, job, owner, {"skipped": "replay deleted"})
        return
    if rep["revision"] != job["revision"]:
        jobs.complete(conn, job, owner, {"skipped": "superseded revision"})
        return
    if not rep["source_key"]:
        raise SourceMissing("The uploaded demo has expired. Upload it again to process this replay.")
    size = rep["source_size"] or storage.size(rep["source_key"]) or 0
    if size > cfg.max_demo_bytes:
        raise DemoTooLarge("The demo is larger than the configured limit.")
    root = Path(cfg.work_dir)
    root.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(root).free
    if size * 2 + (64 << 20) > min(free, cfg.max_tmp_bytes):
        raise TransientError("Not enough temporary disk space for this demo; will retry.")

    conn.execute("update replays set status = 'processing', updated_at = now() where id = %s and revision = %s and status in ('queued','processing','failed')",
                 (rep["id"], rep["revision"]))
    workdir = root / f"job-{job['id']}-a{job['attempts']}"
    shutil.rmtree(workdir, ignore_errors=True)
    workdir.mkdir(parents=True)
    prefix = f"replays/{rep['id']}/r{rep['revision']}/a{job['attempts']}"
    try:
        with jobs.Heartbeat(cfg.database_url, job["id"], owner, cfg.lease_seconds, cfg.heartbeat_seconds) as hb:
            src = workdir / "source.dem"
            try:
                storage.download(rep["source_key"], str(src), cfg.max_demo_bytes)
            except ValueError as e:
                raise DemoTooLarge(str(e)) from e
            with open(src, "rb") as fh:
                classify_header(fh.read(16), allow_synthetic=cfg.allow_synthetic)
            if hb.lost.is_set():
                raise LeaseLost("lease lost during download")
            series = {"id": rep["series_id"], "mapIndex": rep["series_map_index"]} if rep["series_id"] else None
            manifest, stats = run_parse_child(cfg, {
                "source": str(src), "out_dir": str(workdir / "out"), "map_registry": cfg.map_registry_path,
                "replay_id": rep["id"], "revision": rep["revision"], "prefix": prefix,
                "sample_every": cfg.sample_every_ticks, "allow_synthetic": cfg.allow_synthetic, "series": series,
            }, workdir)
            if hb.lost.is_set():
                raise LeaseLost("lease lost during parsing")
            out = workdir / "out"
            for s in manifest["rounds"]:
                storage.put_bytes(s["payload"]["key"], (out / "rounds" / f"{s['id']}.json.gz").read_bytes(),
                                  "application/json", "gzip")
            import gzip as _gz
            storage.put_bytes(f"{prefix}/manifest.json.gz", _gz.compress(json.dumps(manifest, separators=(",", ":")).encode(), mtime=0),
                              "application/json", "gzip")
            # All round objects must exist before the revision is published.
            for s in manifest["rounds"]:
                if storage.size(s["payload"]["key"]) != s["payload"]["bytes"]:
                    raise TransientError(f"round object {s['id']} missing after upload")
            if hb.lost.is_set() or not jobs.publish(conn, job, owner, prefix, manifest):
                raise LeaseLost("lease lost before publish; another worker owns this job")
            log.info("published replay %s rev %s (%d rounds) %s", rep["id"], rep["revision"], len(manifest["rounds"]), stats)
            conn.execute("update jobs set result = result || %s::jsonb where id = %s", (json.dumps(stats), job["id"]))
    except LeaseLost:
        try:
            storage.delete_prefix(prefix)
        except Exception:  # noqa: BLE001
            log.warning("could not remove orphaned prefix %s; maintenance will retry", prefix)
        raise
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    # Source cleanup never blocks playback; on failure maintenance retries it.
    if not cfg.keep_source:
        try:
            storage.delete(rep["source_key"])
            conn.execute("update replays set source_key = null, source_expires_at = null where id = %s and source_key = %s",
                         (rep["id"], rep["source_key"]))
        except Exception:  # noqa: BLE001
            log.warning("source cleanup failed for %s; scheduling retry", rep["id"])
            conn.execute("update replays set source_expires_at = now() where id = %s", (rep["id"],))


def process_cleanup(cfg: Config, conn, storage: Storage, job: dict) -> None:
    rid = job["replay_id"]
    n = storage.delete_prefix(f"replays/{rid}")
    n += storage.delete_prefix(f"audio/{rid}")
    rep = conn.execute("select source_key from replays where id = %s", (rid,)).fetchone()
    if rep and rep["source_key"]:
        storage.delete(rep["source_key"])
        n += 1
    conn.execute("update replays set source_key = null, published_prefix = null where id = %s", (rid,))
    conn.execute("update audio_tracks set status = 'deleted' where replay_id = %s", (rid,))
    jobs.complete(conn, job, cfg.worker_id, {"deletedObjects": n})
