# TreeAI: managed inference, training, and lab

TreeAI publishes three independently selectable TreeSeed components:

- **ai-inference:** authenticated vLLM serving, artifact import, evaluation, promotion, and rollback.
- **ai-training:** Marker conversion, Axolotl training, signed immutable artifacts, and engine-local jobs.
- **ai-lab:** optional Hermes/Open WebUI, experience capture, and library-cycle orchestration.

TreeSeed Platform selects exact releases and portable configuration. TreeSeed Deployment owns the universal installer, host prerequisites, service lifecycle, updates, TLS, GPU mode, and recovery. This repository contains no standalone installer, host manager, APT suite, or host CLI.

## Credentials and storage

Control-plane callers use registered-node delegation. Internal service credentials and signing identities are generated and sealed by Deployment; applications receive only scoped runtime inputs. Do not generate wildcard operator keys or copy secrets into configuration.

External artifact storage resolves the node's explicit service-vault connection through the control plane. Workloads sign a fresh request with an Ed25519 identity and receive a short-lived R2 credential restricted to an action and team/project/node/store path. Parent provider credentials remain in managed vault custody. Static R2/AWS credentials and legacy S3 URI aliases are not supported.

Local filesystem artifacts remain supported. Selecting remote storage is not permission to discard local artifacts: an existing store requires a verified copy/switch migration. See [operations](docs/operations.md) for boundaries and acceptance.

## APIs

Inference, training, and lab publish OpenAPI 3.1.1 at `/openapi.json` and documentation at `/docs`. The TreeAI SDK includes these three contracts. Host mode and recovery operations belong to the TreeSeed SDK/CLI, not a fourth AI manager API.

Raw vLLM, workers, and product databases are private. Deployment supplies shared-edge HTTPS aliases; use the installed host's published endpoints rather than hardcoding machine addresses.

## Development and releases

Materialize this project through the Platform workset and activate the managed development session. Do not start a competing Compose stack or install a separate AI bootstrap.

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm check:activation-closure
```

[Release delivery](docs/delivery.md) describes exact component publication and image reuse. [Compatibility](docs/compatibility.md) identifies authoritative runtime pins. Training qualification is distinct from storage and lifecycle acceptance; a healthy endpoint does not prove a completed training loop.
