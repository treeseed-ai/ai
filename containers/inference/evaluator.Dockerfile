FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7
LABEL org.opencontainers.image.base.name="python:3.12.11-slim-bookworm" org.opencontainers.image.base.digest="sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7"
COPY workers/evaluator/requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.lock
WORKDIR /app
COPY workers/common ./common
COPY workers/evaluator ./evaluator
RUN useradd --system --uid 10001 worker && mkdir /state && chown worker /state
USER worker
CMD ["python","evaluator/worker.py"]
