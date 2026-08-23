# AI Inference and Training Platform

This repository builds a manager-owned AI platform from one operator-facing Debian package, plus independently deployable inference, training, and experience products:

- **treeseed-ai** — the only package operators download manually. It installs a desired-state seed, signed repository bootstrap, and asynchronous handoff service.
- **treeseed-ai-manager** — the lifecycle, update, GPU-mode, and monitoring authority, split between an unprivileged HTTPS API and fixed-operation root supervisor.

- **treeseed-ai-inference** — authenticated OpenAI-compatible vLLM serving, LoRA adapter import, offline evaluation, deterministic ranking, explicit promotion, and rollback.
- **treeseed-ai-training** — Marker PDF conversion, dataset preparation, Axolotl supervised QLoRA training, immutable artifact processing, signed export manifests, archival, and restore.
- **treeseed-ai-host-runtime** — an inert Debian package whose explicit CLI can plan, install, and verify Docker Engine, Compose, and NVIDIA Container Toolkit. It never installs the NVIDIA driver.
- **treeseed-ai-lab** — optional Hermes Agent and Open WebUI clients, an experience-capturing OpenAI proxy, and a bounded sequential adapter-cycle controller. It has no Docker socket, product database access, or job queue.
- **treeseed-ai-cli** — the required `treeai` command, with groups discovered from installed root-owned descriptors.
- **treeseed-ai-factory** — a transitional manager dependency retained for upgrades from 0.5.

Neither product is a project scheduler. Each manager executes only jobs submitted to its own control API. The products have separate PostgreSQL schemas, Compose projects, systemd units, state, and release versions. They exchange immutable `ai.artifact/v1` manifests signed with Ed25519 instead of sharing database tables.

## APIs

The Hono control APIs publish OpenAPI 3.1.1 at `/openapi.json` and interactive documentation at `/docs`. Long operations return `202` job resources and support status, event, and cancellation endpoints. API access uses scoped bearer credentials in `ak_<id>_<secret>` form; only salted scrypt hashes are configured or persisted.

Inference also exposes an authenticated OpenAI-compatible data plane on port 4771. Raw vLLM stays private on the Compose network.

| Product | Control API | Data plane |
| --- | --- | --- |
| Inference | `127.0.0.1:4770` | `0.0.0.0:4771` |
| Training | `127.0.0.1:4780` | None |

Managed mode provides TLS-only LAN listeners on 4770, 4771, 4780, and the manager on 4790.

The optional lab exposes loopback browser interfaces at `https://chat.treeai.localhost` and `https://hermes.treeai.localhost`, plus its authenticated OpenAPI control API on 4793. Open WebUI discovers both direct inference and `hermes-agent` through the private experience proxy; neither client can reach raw vLLM.

Generate a bootstrap credential after building:

```bash
node packages/common/dist/key-cli.js operator '*'
```

Put the returned `record` in the `AI_API_KEYS` JSON array. The plaintext credential is shown only once.

## Ubuntu 26.04 managed factory

Release 0.9.0 supports Ubuntu 26.04 (Resolute) amd64. Download one generic or generated configuration package and install it locally:

```bash
sudo apt install ./treeseed-ai_0.9.0-1_amd64.deb
systemctl status treeseed-ai-bootstrap.service
treeai platform status
treeai platform doctor
treeai update status
```

The bootstrap waits for the originating dpkg transaction, configures the selected signed APT suite, installs the manager and private runtime, and converges the catalog. Final credentials and TLS material are generated on the host before the public API binds. The factory starts `awake`; `sleep` drains inference and admits GPU training, while `awake` drains training and warms vLLM.

Delegate local control explicitly with `sudo usermod -aG treeseed-ai-operators USER`, then start a new login session. Group membership grants full control of every public factory API.

Update channel and image source are independent. `updates.channel=development` polls the separately signed suite every 60 seconds; `imageSource=local-build` selects local images. Use `sudo treeai update channel development` to opt in and `sudo treeai auth rotate` to replace the operator credential.

### Optional Hermes experience lab

When `lab` is enabled in `platform.json`, the manager generates distinct service credentials and reconciles Hermes, Open WebUI, the safe web worker, experience proxy, library bridge, and controller. In 0.9.0, Open WebUI Knowledge Bases can become immutable continual-pretraining libraries. Smoke cycles qualify mechanics and remain inactive; standard cycles use held-out likelihood and strict behavior gates before updating only `library/<slug>`. Corrective SFT and KTO remain follow-up pipelines. The Hermes dashboard stores only a password hash, and root can rotate its password with a one-time response.

See [Library training](docs/library-training.md) for supported documents, collection-size guidance, and the smoke/standard qualification flow.

Hermes 0.18.2 is built from its official wheel pinned by SHA-256 because that release has no official container image. Open WebUI 0.11.0 is pinned by digest. In local single-user mode it is available only at `https://chat.treeai.localhost`, with the existing TreeAI CA and no login form. It connects through the private experience proxy rather than raw vLLM.

```bash
sudo treeai lab configure --local-single-user
sudo treeai lab reset-webui --confirm
treeai lab urls
treeai lab open webui
sudo treeai lab hermes rotate-password
treeai lab open hermes
treeai lab hermes verify
treeai lab verify --deep
```

The reset command archives the existing Open WebUI volume before creating the fresh database required by auth-disabled mode. The public CA is `/etc/ssl/certs/treeseed-ai-ca.pem`; sandboxed browsers may require manual CA import. Hermes is limited to its persistent `/workspace`, two concurrent runs, fixed local tools, and the credential-free safe web proxy. Versioned captures prepare separate evidence for continual pretraining, corrective SFT, and KTO without launching training.

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

This creates the central package and eleven repository-managed packages in `.artifacts/`. `dpkg-buildpackage -b -us -uc` is the production packaging path. A configured seed is generated with `node --import tsx scripts/package-deb.ts configured platform.json`; its `+cfg.<digest>` version is deterministic for the complete input payload.

The host package does nothing to Docker during package installation or removal. In a manager-owned configuration with `runtime.management=managed`, first convergence invokes its fixed apply operation. When installed independently, runtime changes remain explicit:

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
