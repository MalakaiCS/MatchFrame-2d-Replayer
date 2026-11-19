"""Private object storage: local filesystem (development) or S3-compatible (production)."""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Protocol

from .errors import SourceMissing, TransientError


class Storage(Protocol):
    def download(self, key: str, dest: str, max_bytes: int) -> int: ...
    def put_bytes(self, key: str, data: bytes, content_type: str, content_encoding: str | None = None) -> None: ...
    def put_file(self, key: str, path: str, content_type: str) -> None: ...
    def exists(self, key: str) -> bool: ...
    def size(self, key: str) -> int | None: ...
    def delete(self, key: str) -> None: ...
    def delete_prefix(self, prefix: str) -> int: ...
    def list_prefixes(self, prefix: str) -> list[str]: ...
    def abort_multipart(self, key: str, upload_id: str) -> None: ...


def _safe(key: str) -> str:
    if key.startswith("/") or ".." in key.split("/"):
        raise ValueError(f"unsafe object key: {key!r}")
    return key


class FsStorage:
    def __init__(self, root: str):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _p(self, key: str) -> Path:
        return self.root / _safe(key)

    def download(self, key: str, dest: str, max_bytes: int) -> int:
        src = self._p(key)
        if not src.exists():
            raise SourceMissing("The uploaded demo is no longer available. Upload it again.")
        n = 0
        with open(src, "rb") as fi, open(dest, "wb") as fo:
            while chunk := fi.read(1 << 20):
                n += len(chunk)
                if n > max_bytes:
                    raise ValueError("source exceeds the size limit")
                fo.write(chunk)
        return n

    def put_file(self, key: str, path: str, content_type: str) -> None:
        p = self._p(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".part")
        shutil.copyfile(path, tmp)
        os.replace(tmp, p)

    def put_bytes(self, key: str, data: bytes, content_type: str, content_encoding: str | None = None) -> None:
        p = self._p(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".part")
        tmp.write_bytes(data)
        os.replace(tmp, p)

    def exists(self, key: str) -> bool:
        return self._p(key).is_file()

    def size(self, key: str) -> int | None:
        p = self._p(key)
        return p.stat().st_size if p.is_file() else None

    def delete(self, key: str) -> None:
        self._p(key).unlink(missing_ok=True)

    def delete_prefix(self, prefix: str) -> int:
        p = self._p(prefix.rstrip("/"))
        if not p.exists():
            return 0
        n = sum(1 for _ in p.rglob("*") if _.is_file())
        shutil.rmtree(p)
        return n

    def list_prefixes(self, prefix: str) -> list[str]:
        p = self._p(prefix.rstrip("/"))
        if not p.is_dir():
            return []
        return [f"{prefix.rstrip('/')}/{c.name}" for c in p.iterdir() if c.is_dir()]

    def abort_multipart(self, key: str, upload_id: str) -> None:
        """Remove part files of an unfinished resumable upload (web: key.parts/<id>/)."""
        self.delete_prefix(f"{key}.parts/{upload_id}/")


class S3Storage:
    def __init__(self, bucket: str, endpoint: str | None, region: str):
        import boto3
        from botocore.config import Config

        self.bucket = bucket
        self.s3 = boto3.client(
            "s3", endpoint_url=endpoint, region_name=region,
            config=Config(retries={"max_attempts": 5, "mode": "standard"}, s3={"addressing_style": "path"}),
        )

    def _wrap(self, e: Exception) -> Exception:
        code = getattr(e, "response", {}).get("Error", {}).get("Code") if hasattr(e, "response") else None
        if code in ("NoSuchKey", "404", "NotFound"):
            return SourceMissing("The uploaded demo is no longer available. Upload it again.")
        return TransientError(f"object storage error: {e}")

    def download(self, key: str, dest: str, max_bytes: int) -> int:
        try:
            obj = self.s3.get_object(Bucket=self.bucket, Key=_safe(key))
        except Exception as e:  # noqa: BLE001
            raise self._wrap(e) from e
        if obj["ContentLength"] > max_bytes:
            raise ValueError("source exceeds the size limit")
        n = 0
        with open(dest, "wb") as fo:
            for chunk in obj["Body"].iter_chunks(1 << 20):
                n += len(chunk)
                if n > max_bytes:
                    raise ValueError("source exceeds the size limit")
                fo.write(chunk)
        return n

    def put_bytes(self, key: str, data: bytes, content_type: str, content_encoding: str | None = None) -> None:
        extra = {"ContentEncoding": content_encoding} if content_encoding else {}
        try:
            self.s3.put_object(Bucket=self.bucket, Key=_safe(key), Body=data, ContentType=content_type, **extra)
        except Exception as e:  # noqa: BLE001
            raise TransientError(f"object storage error: {e}") from e

    def put_file(self, key: str, path: str, content_type: str) -> None:
        try:
            self.s3.upload_file(path, self.bucket, _safe(key), ExtraArgs={"ContentType": content_type})
        except Exception as e:  # noqa: BLE001
            raise TransientError(f"object storage error: {e}") from e

    def size(self, key: str) -> int | None:
        try:
            return int(self.s3.head_object(Bucket=self.bucket, Key=_safe(key))["ContentLength"])
        except Exception as e:  # noqa: BLE001
            if isinstance(self._wrap(e), SourceMissing):
                return None
            raise self._wrap(e) from e

    def exists(self, key: str) -> bool:
        return self.size(key) is not None

    def delete(self, key: str) -> None:
        self.s3.delete_object(Bucket=self.bucket, Key=_safe(key))

    def delete_prefix(self, prefix: str) -> int:
        n = 0
        paginator = self.s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=_safe(prefix.rstrip("/") + "/")):
            objs = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            for i in range(0, len(objs), 1000):
                self.s3.delete_objects(Bucket=self.bucket, Delete={"Objects": objs[i : i + 1000], "Quiet": True})
                n += len(objs[i : i + 1000])
        return n

    def list_prefixes(self, prefix: str) -> list[str]:
        out = []
        paginator = self.s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix.rstrip("/") + "/", Delimiter="/"):
            out += [p["Prefix"].rstrip("/") for p in page.get("CommonPrefixes", [])]
        return out


def make_storage(cfg) -> Storage:
    if cfg.storage_driver == "s3":
        return S3Storage(cfg.s3_bucket, cfg.s3_endpoint, cfg.s3_region)
    return FsStorage(cfg.storage_fs_root)

    def abort_multipart(self, key: str, upload_id: str) -> None:
        """Abort an unfinished multipart upload so its parts stop costing storage."""
        try:
            self.s3.abort_multipart_upload(Bucket=self.bucket, Key=_safe(key), UploadId=upload_id)
        except Exception:  # noqa: BLE001 - already completed or aborted
            pass
