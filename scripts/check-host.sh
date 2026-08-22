#!/bin/sh
set -eu
product=${1:?product is required}
if command -v treeai >/dev/null; then
  treeai host verify --json
  exit $?
fi
command -v docker >/dev/null || { echo 'Docker Engine is required.' >&2; exit 1; }
docker compose version >/dev/null || { echo 'Docker Compose v2 is required.' >&2; exit 1; }
command -v nvidia-smi >/dev/null || { echo 'An NVIDIA driver and visible GPU are required.' >&2; exit 1; }
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader >/dev/null
docker info --format '{{json .Runtimes}}' | grep -q nvidia || { echo 'NVIDIA Container Toolkit runtime is required.' >&2; exit 1; }
available_kb=$(df -Pk "/var/lib/treeseed-ai/$product" | awk 'NR==2 {print $4}')
[ "$available_kb" -ge 31457280 ] || { echo 'At least 30 GiB free disk is required.' >&2; exit 1; }
available_mem=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
[ "$available_mem" -ge 16777216 ] || echo 'Warning: less than 16 GiB system memory is available.' >&2
