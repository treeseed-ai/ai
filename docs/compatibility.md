# Runtime compatibility

| Component | V1 pin | Role |
| --- | --- | --- |
| Node.js | 24.12.0 | Hono APIs and managers |
| PostgreSQL | 17.6 | Product-local metadata and jobs |
| MinIO | RELEASE.2025-07-23T15-54-02Z | Optional development object storage |
| vLLM | 0.25.0 | OpenAI-compatible inference |
| CUDA | 12.8.1 | Axolotl worker base |
| Axolotl | 0.12.2 | Supervised QLoRA |
| Accelerate | 1.10.0 | Training launch (required by Axolotl 0.12.2) |
| Marker | 1.8.3 | PDF conversion |

Local Dockerfiles and state-service Compose definitions pin the corresponding multi-platform image manifests by SHA-256. Build receipts additionally record the resolved amd64 image IDs and OCI base-image labels so mutable-tag drift is detected before activation.

The local factory pins Qwen/Qwen3.5-4B to Hugging Face revision `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a`. Training exports must declare the same immutable `baseModelRevision` before inference will import them.

Inference and training release independently. `ai.artifact/v1` is their only required product-to-product compatibility boundary.

## Host runtime bootstrap

`treeseed-ai-host-runtime` supports amd64 Debian 12/13 and Ubuntu 22.04/24.04/26.04. Its compatibility manifest pins Docker Engine/CLI 29.7.2, containerd.io 2.3.3, Buildx 0.36.1, Compose 5.5.0, NVIDIA Container Toolkit 1.20.0, exact signed-index filenames and checksums, repository fingerprints, and a digest-pinned CUDA 12.8 verification image. Existing operator-managed installations are retained when capability checks and validated ranges pass; the installer never downgrades or replaces them. NVIDIA driver 595.84 is accepted by capability checks rather than installed or replaced.

CUDA user-space libraries stay inside application images. GPU drivers, Secure Boot enrollment, kernel headers, kernel upgrades, and reboot orchestration remain operator responsibilities. `official-online` and configured signed `local-apt` sources use the same artifact-resolution contract; building or bundling an offline repository is not included in this release.
