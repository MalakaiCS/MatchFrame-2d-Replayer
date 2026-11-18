import os
from pathlib import Path

import pytest

from matchframe_worker.config import _default_registry
from matchframe_worker.maps import get_map
from matchframe_worker.synthetic import generate
from matchframe_worker.transform import build

REGISTRY = _default_registry()


@pytest.fixture(scope="session")
def mirage_raw():
    return generate({"map": "de_mirage"})


@pytest.fixture(scope="session")
def mirage(mirage_raw):
    return build(mirage_raw, get_map(REGISTRY, "de_mirage"), replay_id="rp", revision=1, prefix="p", sample_every=4)


@pytest.fixture(scope="session")
def db_url():
    url = os.environ.get("TEST_DATABASE_URL", "postgresql://mf:mf@localhost/matchframe_test")
    try:
        import psycopg

        psycopg.connect(url).close()
    except Exception:  # noqa: BLE001
        pytest.skip("test database not available")
    return url
