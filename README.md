# AI Inference and Training Platform

This repository builds two independent GPU products, an optional experience lab, a host bootstrap package, and a unified CLI for NVIDIA Linux amd64 hosts:

- **treeseed-ai-inference** — authenticated OpenAI-compatible vLLM serving, LoRA adapter import, offline evaluation, deterministic ranking, explicit promotion, and rollback.
- **treeseed-ai-training** — Marker PDF conversion, dataset preparation, Axolotl supervised QLoRA training, immutable artifact processing, signed export manifests, archival, and restore.
- **treeseed-ai-host-runtime** — an inert Debian package whose explicit CLI can plan, install, and verify Docker Engine, Compose, and NVIDIA Container Toolkit. It never installs the NVIDIA driver.
- **treeseed-ai-lab** — optional Hermes Agent and Open WebUI clients, an experience-capturing OpenAI proxy, and a bounded sequential adapter-cycle controller. It has no Docker socket, product database access, or job queue.
- **treeseed-ai-cli** — the required `treeai` command, with groups discovered from installed root-owned descriptors.
- **treeseed-ai-factory** — an inert meta-package that installs the complete product set.

Neither product is a project scheduler. Each manager executes only jobs submitted to its own control API. The products have separate PostgreSQL schemas, Compose projects, systemd units, state, and release versions. They exchange immutable `ai.artifact/v1` manifests signed with Ed25519 instead of sharing database tables.

## APIs

The Hono control APIs publish OpenAPI 3.1.1 at `/openapi.json` and interactive documentation at `/docs`. Long operations return `202` job resources and support status, event, and cancellation endpoints. API access uses scoped bearer credentials in `ak_<id>_<secret>` form; only salted scrypt hashes are configured or persisted.

Inference also exposes an authenticated OpenAI-compatible data plane on port 4771. Raw vLLM stays private on the Compose network.

| Product | Control API | Data plane |
| --- | --- | --- |
| Inference | `127.0.0.1:4770` | `0.0.0.0:4771` |
| Training | `127.0.0.1:4780` | None |

Factory mode replaces those direct publications with TLS-only LAN listeners on 4770, 4771, 4780, and the factory coordinator on 4790.

The optional lab adds TLS listeners for Open WebUI on 4791, the Hermes dashboard on 4792, and its authenticated OpenAPI control API on 4793. Both clients use the private experience proxy; neither can reach raw vLLM.

Generate a bootstrap credential after building:

```bash
node packages/common/dist/key-cli.js operator '*'
```

Put the returned `record` in the `AI_API_KEYS` JSON array. The plaintext credential is shown only once.

## Ubuntu 26.04 local factory

Release 0.5.0 supports Ubuntu 26.04 (Resolute) amd64. On a new host with a working NVIDIA driver:

```bash
sudo apt install treeseed-ai-factory
sudo treeai host plan
sudo treeai host apply
sudo treeai host verify
sudo TREEAI_DEPLOYMENT_MODE=published treeai factory configure
sudo treeai factory pull
sudo treeai factory start
treeai factory verify
```

`configure` stores one full-scope operator credential at `/etc/treeseed-ai/treeai/operator.key`, readable by root and members of `treeseed-ai-operators`. Private service credentials remain separate. The factory starts `awake`; `sleep` drains inference and admits GPU training, while `awake` drains training and warms vLLM.

Delegate local control explicitly with `sudo usermod -aG treeseed-ai-operators USER`, then start a new login session. Group membership grants full control of every public factory API.

For local source development use `TREEAI_DEPLOYMENT_MODE=development`, then `treeai factory build --source "$PWD"`. Build uses Bake, pinned bases, smoke checks, and an image-ID receipt. Use `sudo treeai auth rotate` to replace the operator credential.

### Optional Hermes experience lab

The lab obtains narrowly scoped internal service credentials from the configured core factory:

```bash
sudo treeai lab plan
sudo treeai lab configure
sudo treeai lab build --source "$PWD" # development mode only
sudo treeai lab start
```

`configure` prints only the one-time Hermes dashboard login. The same `treeai` operator credential controls the lab API. Automatic cycling is disabled until `treeai lab enable` is called.

Hermes 0.18.2 is built from its official wheel pinned by SHA-256 because that release has no official container image. Open WebUI 0.9.5 is pinned to its linux/amd64 OCI manifest. Experience artifacts are confined to the Hermes workspace, redacted, content-addressed, and uploaded to training storage before immutable batch preparation.

## Development

```bash
pnpm install --frozen-lockfile
pnpm verify

docker compose -f deploy/inference/compose.yml --profile state up --build
docker compose -f deploy/training/compose.yml --profile state up --build
```

Copy the corresponding `.env.example`, configure `AI_API_KEYS`, and provide a training Ed25519 private key before starting. Production deployments should configure external PostgreSQL and S3-compatible services and immutable image digest references.

## Build artifacts

```bash
pnpm build:deb
```

This creates six coordinated amd64 Debian packages in `.artifacts/`. Individual functional products remain independently installable; each requires the CLI package. Images are built per role from `containers/inference`, `containers/training`, and `containers/lab`.

The host package does nothing to Docker during package installation or removal. Bootstrap is always explicit:

```bash
sudo treeai host plan
sudo treeai host apply
sudo treeai host verify
```

Use `--json` for machine-readable output. Conflicts make `apply` refuse; `migration-plan` prints operator-reviewed commands without running them. `official-online` is the default source, while a signed `local-apt` repository can be configured under `/etc/treeseed-ai/host-runtime/`.

## V1 boundaries

- NVIDIA Container Toolkit and one or more NVIDIA GPUs are required for vLLM, Marker, and Axolotl workers.
- Training accepts a validated Axolotl subset for supervised QLoRA; arbitrary command or configuration passthrough is rejected.
- Marker accepts PDFs mounted beneath the configured input directory and emits checksummed structured bundles.
- The local filesystem workers implement the single-host execution path. The common S3 adapter and artifact manifest contract provide the production object-storage boundary.
- Evaluation runs real held-out inference. Promotion requires every critical check, no category regression, at least `0.02` aggregate improvement, warm-up, and compatibility validation.

See [operations.md](docs/operations.md) and [compatibility.md](docs/compatibility.md).
