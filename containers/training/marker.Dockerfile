FROM nvidia/cuda:12.8.1-runtime-ubuntu24.04@sha256:ebef3c171eeef0298e4eb2e4be843105edf3b8b0ac45e0b43acee358e8046867
LABEL org.opencontainers.image.base.name="nvidia/cuda:12.8.1-runtime-ubuntu24.04" org.opencontainers.image.base.digest="sha256:ebef3c171eeef0298e4eb2e4be843105edf3b8b0ac45e0b43acee358e8046867"
COPY workers/marker/requirements.lock /tmp/requirements.lock
RUN DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/* && pip3 install --break-system-packages --no-cache-dir --require-hashes -r /tmp/requirements.lock
WORKDIR /app
COPY workers/common ./common
COPY workers/marker ./marker
RUN useradd --system --uid 10001 worker && mkdir -p /inputs /artifacts/documents /models/huggingface /models/cache /models/torch && chown -R worker /inputs /artifacts /models
USER worker
CMD ["python3","marker/worker.py"]
