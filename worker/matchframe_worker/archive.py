"""Bounded extraction of compressed demo uploads.

Real-world demos usually arrive compressed: Valve matchmaking downloads are
`.dem.bz2`, and tournament and scrim demos are `.rar` or `.zip`. The worker
extracts exactly one `.dem` into a fixed output path:

- output size is capped (`max_bytes`), so decompression bombs stop early;
- archive member paths are never used as filesystem paths (no traversal);
- an archive with zero, or more than one, `.dem` member is refused with an
  actionable message.

RAR (v4/v5) goes through libarchive's `bsdtar`, installed in the worker image
(`libarchive-tools`). bzip2, gzip and zip use the Python standard library.
"""

from __future__ import annotations

import bz2
import gzip
import shutil
import subprocess
import zipfile
import zlib
from pathlib import Path

from .errors import DemoTooLarge, InvalidDemo, UnsupportedDemo

CHUNK = 1 << 20

MAGICS = {
    b"BZh": "bzip2",
    b"\x1f\x8b": "gzip",
    b"PK\x03\x04": "zip",
    b"Rar!\x1a\x07": "rar",
}


def archive_kind(head: bytes) -> str | None:
    for magic, kind in MAGICS.items():
        if head.startswith(magic):
            return kind
    return None


def _copy_capped(src, dst_path: Path, max_bytes: int) -> int:
    n = 0
    with open(dst_path, "wb") as out:
        while chunk := src.read(CHUNK):
            n += len(chunk)
            if n > max_bytes:
                raise DemoTooLarge(f"The extracted demo is larger than the {max_bytes // 2**20} MiB limit.")
            out.write(chunk)
    return n


def _single_dem(names: list[str]) -> str:
    dems = [n for n in names if n.lower().endswith(".dem") and not n.endswith("/")]
    if not dems:
        raise InvalidDemo("The archive does not contain a .dem file.", code="ARCHIVE_NO_DEMO")
    if len(dems) > 1:
        raise UnsupportedDemo(
            f"The archive contains {len(dems)} demos. Upload each map's demo separately.", code="ARCHIVE_MULTIPLE_DEMOS"
        )
    return dems[0]


def extract(kind: str, src: Path, dst: Path, max_bytes: int, timeout_s: int = 600) -> int:
    """Extract the single demo in `src` to `dst`. Returns the extracted size in bytes."""
    try:
        if kind == "bzip2":
            with bz2.open(src, "rb") as f:
                return _copy_capped(f, dst, max_bytes)
        if kind == "gzip":
            with gzip.open(src, "rb") as f:
                return _copy_capped(f, dst, max_bytes)
        if kind == "zip":
            with zipfile.ZipFile(src) as z:
                name = _single_dem(z.namelist())
                with z.open(name) as f:
                    return _copy_capped(f, dst, max_bytes)
        if kind == "rar":
            return _extract_libarchive(src, dst, max_bytes, timeout_s)
    except (DemoTooLarge, InvalidDemo, UnsupportedDemo):
        raise
    except (OSError, EOFError, zipfile.BadZipFile, ValueError, zlib.error) as e:
        raise InvalidDemo(f"The {kind} archive is damaged or incomplete ({type(e).__name__}).", code="ARCHIVE_CORRUPT") from e
    raise UnsupportedDemo(f"Unsupported archive type: {kind}.", code="UNSUPPORTED_FORMAT")


def _extract_libarchive(src: Path, dst: Path, max_bytes: int, timeout_s: int) -> int:
    bsdtar = shutil.which("bsdtar")
    if not bsdtar:
        raise UnsupportedDemo("RAR archives are not supported on this server. Extract the .dem and upload it.", code="UNSUPPORTED_FORMAT")
    listing = subprocess.run([bsdtar, "-tf", str(src)], capture_output=True, text=True, timeout=timeout_s)
    if listing.returncode != 0:
        raise InvalidDemo("The RAR archive is damaged or password-protected.", code="ARCHIVE_CORRUPT")
    name = _single_dem([n for n in listing.stdout.splitlines() if n])
    # Stream the one member to stdout; the member name is a pattern argument, never an output path.
    proc = subprocess.Popen([bsdtar, "-xOf", str(src), "--", name], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        n = _copy_capped(proc.stdout, dst, max_bytes)
    except DemoTooLarge:
        proc.kill()
        raise
    finally:
        try:
            proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            proc.kill()
    if proc.returncode != 0:
        raise InvalidDemo("The RAR archive could not be extracted (damaged or password-protected).", code="ARCHIVE_CORRUPT")
    return n
