FROM python:3.12.14-slim-bookworm@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134
LABEL org.opencontainers.image.base.name="python:3.12.14-slim-bookworm" org.opencontainers.image.base.digest="sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134"
COPY workers/evaluator/requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.lock
WORKDIR /app
COPY workers/common ./common
COPY workers/evaluator ./evaluator
RUN useradd --system --uid 10001 worker && mkdir /state && chown worker /state
USER worker
CMD ["python","evaluator/worker.py"]
