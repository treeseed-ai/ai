#!/bin/bash
set -euo pipefail
args=("$@")
if [[ "${TREEAI_MULTIMODAL_LORA_ENABLED:-false}" == "true" ]]; then
  args+=(--enable-tower-connector-lora)
else
  args+=(--language-model-only)
fi
exec vllm serve "${args[@]}"
