FROM nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04@sha256:24c8e3581ea6330038b0d374920721983312627f8adbfcf390bdb4b399d280ed
LABEL org.opencontainers.image.base.name="nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04" org.opencontainers.image.base.digest="sha256:24c8e3581ea6330038b0d374920721983312627f8adbfcf390bdb4b399d280ed"
COPY workers/axolotl/requirements.lock /tmp/requirements.lock
RUN DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-dev python3-pip git && rm -rf /var/lib/apt/lists/* /opt/nvidia/nsight-compute && pip3 install --break-system-packages --no-cache-dir --require-hashes -r /tmp/requirements.lock
WORKDIR /app
COPY workers/common ./common
COPY workers/axolotl ./axolotl-worker
RUN useradd --system --uid 10001 worker && mkdir -p /artifacts/training /models/huggingface /models/cache /models/torch /models/triton && chown -R worker /artifacts /models
USER worker
WORKDIR /artifacts/training
CMD ["python3","/app/axolotl-worker/worker.py"]
