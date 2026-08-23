# Operations

Install the downloaded `treeseed-ai_*.deb` once. Its maintainer script only creates protected seed state and launches `treeseed-ai-bootstrap.service` asynchronously. The service waits for APT/dpkg locks, installs the private runtime, CLI, catalog, and manager from the signed repository, then hands desired state to the manager.

### Explicit 0.4 takeover

An installed 0.4 local factory has no unified TreeAI configuration, and its package removal guard owns the legacy coordinator. The central installer detects this layout and deliberately does not begin handoff automatically. It also does not stop containers, rewrite product environments, or touch volumes during package installation.

Review and approve the fixed migration after installing the central package:

```bash
sudo /usr/lib/treeseed-ai/bootstrap/migrate-0.4.sh plan
sudo /usr/lib/treeseed-ai/bootstrap/migrate-0.4.sh apply --confirm
sudo journalctl -fu treeseed-ai-bootstrap.service
```

The plan blocks when inference or GPU training counters are nonzero, the persisted mode is unsafe, or required bundled PostgreSQL/MinIO credentials are absent. Apply records approval and starts the asynchronous bootstrap. At the dpkg boundary it backs up and hashes the legacy environments and coordinator assets, disables the old coordinator, upgrades the repository-managed packages, and converges with registry images. Existing Compose project names and Docker volumes are retained. PostgreSQL, S3, and MinIO credentials are read from the old product environments; TLS, artifact-signing material, and `awake`/`sleep` mode move to manager ownership. A failure before package installation restores the old coordinator. Once dpkg starts, recovery remains manager-owned because restarting old code against partially upgraded files is unsafe.

Use `treeai platform status`, `treeai platform doctor`, `treeai platform events`, and `treeai update watch` for live operation. Read-only monitoring and mode changes use the authenticated manager API. Applying releases, changing channels, adopting a different configuration ID, component ownership, and recovery require local root over `/run/treeseed-ai/manager/control.sock`.

## Desired state

The active configuration is `/etc/treeseed-ai/platform.json` and conforms to `treeai.platform/v1`. Repository upgrades never overwrite it. A seed with the same configuration ID and a higher generation is staged automatically; a different ID requires `sudo treeai config adopt --confirm`. External credentials are local secret-provider references only.

Configured installers may include temporary TreeAI-owned credentials. Initial convergence replaces them, records seed consumption, and warns the operator to delete the downloaded package. Final private material remains under `/etc/treeseed-ai`.

## Updates

Stable hosts check daily, stage compatible releases, and apply them Sunday at 03:00 local time with jitter. Development hosts use a separately signed suite and a persistent 60-second timer. An unchanged catalog generation causes no package download, image pull, migration, or restart. Network failures use bounded exponential backoff.

Every update is catalog-driven. The manager rejects removals, implicit downgrades, foreign origins, and uncataloged packages; downloads before installation; pulls only changed locally built and upstream runtime image digests; validates prerequisites; drains affected work; records receipts and last-known-good state; migrates in declared order; and reconciles only affected services. Compose reuses unchanged containers, so an unchanged vLLM digest is neither pulled nor restarted. Drain expiry postpones work without killing it. Cancellation ends when dpkg installation begins.

Use `sudo treeai update channel stable|development` to switch suites. Returning from a development version never performs an implicit Debian downgrade. Major, breaking, destructive, reboot, driver, and downgrade changes require explicit local approval.

## GPU modes

`treeai mode awake` drains training, starts and warms vLLM, and then admits inference. `treeai mode sleep` drains inference, stops vLLM, and then admits Marker/Axolotl GPU work. The manager never starts both GPU workloads and never owns product job queues.

Product systemd units remain available for independently installed products, but manager-owned deployments do not enable them. The root supervisor uses fixed Compose files and service allowlists, persists mode under `/var/lib/treeseed-ai/platform/`, and exposes only the TLS gateways. Raw vLLM, PostgreSQL, MinIO, migrations, and workers remain private.

## Backup and recovery

Product PostgreSQL databases and object stores remain independent. Back them up separately, preserve the training Ed25519 key, and retain catalog generations referenced by known-good receipts. Use `treeai recovery status|retry|restore`; restoration is refused unless the target catalog declares rollback compatibility. Unsafe recovery enters `degraded` rather than guessing.
