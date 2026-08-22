# Operations

Install either Debian package, edit its environment file under `/etc/treeseed-ai/<product>/`, generate an API key with `treeseed-ai-inference-key` or `treeseed-ai-training-key`, and enable the corresponding systemd unit. Production configurations use external PostgreSQL and S3-compatible endpoints and registry images pinned by digest.

Use `docker compose ... config` as the non-mutating plan. Apply with `systemctl start` or `docker compose ... up -d --remove-orphans --wait`.

## Optional host preparation

Install `treeseed-ai-host-runtime` only when the host runtime is not managed elsewhere. Package installation is intentionally inert. Review `treeseed-ai-host-runtime plan`, run `apply` explicitly as root, then run `verify`. Applied plans, exact APT artifact metadata, configuration changes, and receipts are retained under `/var/lib/treeseed-ai/host-runtime/`.

`apply` refuses unsupported platforms, conflicting packages, manual Docker binaries, and malformed daemon JSON. `migration-plan` provides non-executing guidance. NVIDIA configuration preserves unrelated daemon keys, does not set NVIDIA as the default runtime, and is restored if validation or Docker restart fails. Removing any of the three packages never removes Docker, Toolkit, repositories, daemon configuration, images, containers, or volumes.

## Local factory lifecycle

After all three packages and the host runtime are ready, run `sudo ai-factory-dev plan --source /path/to/ai`, then `configure`, `build`, and `start` with the same `--source`. Save the one-time client keys in your shell or secret manager. Local clients use `/etc/ssl/certs/treeseed-ai-factory-development-ca.pem`; copy that public certificate to LAN clients over a trusted channel. Private keys remain under `/etc/treeseed-ai/host-runtime/factory/`.

Configuration is transactional and idempotent. It creates separate product database/object-store credentials, the `ai-shared` bridge, TLS material, an artifact-signing key, and redacted receipts without starting services or pulling images. Lost client credentials are replaced only with `configure --rotate-client-keys`; restart afterward so the coordinator and product containers load the new hashes.

The build uses `deploy/factory/docker-bake.hcl` to create all eleven `local/*:0.4.0` role images. It pulls digest-pinned Caddy, PostgreSQL, and MinIO runtime images, runs entrypoint/framework/health smoke checks, and records image IDs and source/base digests. Start refuses a local tag that no longer matches this receipt.

Use `status`, `mode`, `awake`, `sleep`, `watch`, and `logs inference|training` for live operation. Mode requests are authenticated and asynchronous. Inference drains for up to 120 seconds; GPU training drains for up to 300 seconds. A timeout preserves the prior safe mode, while a failure after lifecycle mutation enters `degraded`. Use `disable --handoff awake|sleep` before removing any factory-owned package.

The first awake start qualifies Qwen/Qwen3.5-4B from 65,536 tokens downward in 4,096-token steps using two tokenizer-aware concurrent requests. The largest successful profile (minimum 16,384) is persisted under `/var/lib/treeseed-ai/host-runtime/factory/` and reused only while the GPU, driver, vLLM image, model revision, and memory configuration fingerprint remains unchanged.

The factory binds authenticated HTTPS to all interfaces. An inactive firewall is a warning rather than an automatic mutation. Before using an untrusted LAN, restrict ports 4770, 4771, 4780, and 4790 to the selected client CIDR in the host firewall and review the Docker `DOCKER-USER` chain. Apply firewall changes through the host's normal administration process, especially when connected through SSH.

## Backup and restore

- Back up each product database independently with `pg_dump --format=custom`.
- Enable object versioning and lifecycle protection on artifact buckets.
- Back up the training Ed25519 private key separately. Compromise requires key revocation and rotation.
- Restore the database and object bucket to a consistent timestamp, run migrations, then start managers. Managers recover jobs with expired leases.

## Upgrade

Pull images by recorded digest, stop the product manager, back up PostgreSQL, run the migration image, update image references, and reload the systemd unit. Verify `/readyz` before resuming submission.

Worker crashes are recovered when leases expire. Failed jobs retry with bounded exponential backoff. Cancellation is immediate for queued jobs and cooperative for active jobs.
