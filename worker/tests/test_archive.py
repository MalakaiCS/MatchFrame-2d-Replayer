import bz2
import gzip
import shutil
import zipfile

import pytest

from matchframe_worker.archive import archive_kind, extract
from matchframe_worker.errors import DemoTooLarge, InvalidDemo, UnsupportedDemo

DEMO = b"PBDEMS2\x00" + bytes(range(256)) * 400


def test_kinds():
    assert archive_kind(b"BZh91AY&SY") == "bzip2"
    assert archive_kind(b"\x1f\x8b\x08\x00") == "gzip"
    assert archive_kind(b"PK\x03\x04....") == "zip"
    assert archive_kind(b"Rar!\x1a\x07\x01\x00") == "rar"
    assert archive_kind(b"PBDEMS2\x00") is None


@pytest.mark.parametrize("kind,writer", [
    ("bzip2", lambda p: p.write_bytes(bz2.compress(DEMO))),
    ("gzip", lambda p: p.write_bytes(gzip.compress(DEMO))),
])
def test_stream_formats(tmp_path, kind, writer):
    src, dst = tmp_path / "in", tmp_path / "out.dem"
    writer(src)
    assert extract(kind, src, dst, 10 << 20) == len(DEMO)
    assert dst.read_bytes() == DEMO


def _zip(path, names):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n in names:
            z.writestr(n, DEMO if n.endswith(".dem") else b"readme")


def test_zip_single_demo_ignores_other_files_and_paths(tmp_path):
    src, dst = tmp_path / "a.zip", tmp_path / "out.dem"
    _zip(src, ["../../evil/../match.dem", "readme.txt"])
    assert extract("zip", src, dst, 10 << 20) == len(DEMO)
    assert dst.read_bytes() == DEMO
    assert not (tmp_path.parent / "evil").exists()


def test_zip_multiple_or_no_demo(tmp_path):
    _zip(tmp_path / "m.zip", ["m1.dem", "m2.dem"])
    with pytest.raises(UnsupportedDemo) as e:
        extract("zip", tmp_path / "m.zip", tmp_path / "o.dem", 10 << 20)
    assert e.value.code == "ARCHIVE_MULTIPLE_DEMOS"
    _zip(tmp_path / "n.zip", ["readme.txt"])
    with pytest.raises(InvalidDemo) as e:
        extract("zip", tmp_path / "n.zip", tmp_path / "o.dem", 10 << 20)
    assert e.value.code == "ARCHIVE_NO_DEMO"


def test_decompression_bomb_is_capped(tmp_path):
    src = tmp_path / "bomb.bz2"
    src.write_bytes(bz2.compress(b"\x00" * (8 << 20)))
    with pytest.raises(DemoTooLarge):
        extract("bzip2", src, tmp_path / "o.dem", 1 << 20)


def test_corrupt_archive(tmp_path):
    src = tmp_path / "c.bz2"
    src.write_bytes(b"BZh91AY&SY" + b"\x00" * 100)
    with pytest.raises(InvalidDemo) as e:
        extract("bzip2", src, tmp_path / "o.dem", 1 << 20)
    assert e.value.code == "ARCHIVE_CORRUPT"


@pytest.mark.skipif(not shutil.which("bsdtar"), reason="bsdtar (libarchive-tools) not installed")
def test_libarchive_path_single_member(tmp_path):
    from matchframe_worker.archive import _extract_libarchive

    # libarchive reads zip as well as rar; zip exercises the same listing + streamed-member path.
    _zip(tmp_path / "x.zip", ["sub/dir/match.dem", "notes.txt"])
    assert _extract_libarchive(tmp_path / "x.zip", tmp_path / "o.dem", 10 << 20, 60) == len(DEMO)
    assert (tmp_path / "o.dem").read_bytes() == DEMO
    with pytest.raises(DemoTooLarge):
        _extract_libarchive(tmp_path / "x.zip", tmp_path / "o2.dem", 1000, 60)
