# Matchframe2D parser worker (private service; no public port).
# Build from the repository root:  docker build -f worker/Dockerfile .
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MAP_REGISTRY_PATH=/app/maps.json WORKER_TMP_DIR=/tmp/matchframe-worker
WORKDIR /app
COPY worker/pyproject.toml worker/
COPY worker/matchframe_worker worker/matchframe_worker
RUN pip install --no-cache-dir ./worker && useradd --system --uid 10001 worker && mkdir -p /tmp/matchframe-worker && chown worker /tmp/matchframe-worker
COPY web/src/shared/maps.json /app/maps.json
USER worker
CMD ["python", "-m", "matchframe_worker.main"]
