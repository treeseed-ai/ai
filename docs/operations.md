# AI operations

## One host authority

Use the TreeSeed manager and `trsd` for installation, updates, health, GPU mode, and recovery. Platform supplies the composition; AI supplies immutable component contracts. There is no independent AI installer, APT repository, host supervisor, or host configuration.

Runtime identities are generated on the installed host. Source repositories must not contain hostnames, personal paths, credentials, or runtime receipts. An update must preserve existing provider and artifact-signing identities without purge or bootstrap replacement.

## Service-vault storage

An authorized team service manager binds a registered AI node to a configured Cloudflare object-storage connection and an explicitly selected private bucket. Bucket verification adopts an existing private bucket or creates the selected bucket; it refuses public access without silently changing policy.

The API resolves current team/node/project authority and vault custody for every request. AI signs a fresh, short-lived proof with its Deployment-provisioned Ed25519 workload identity. The API rejects replay and enforces a per-node issuance limit before retrieving the parent token in a bounded vault session.

Deployment mints a 60-second R2 credential scoped beneath:

`teams/<teamId>/projects/<projectId>/ai/v1/nodes/<nodeId>/<storeId>/`

A grant permits one action against an exact object (or an explicitly requested listing prefix). Inference may read the registered training store but may not write it. Workloads never receive the parent provider credential. TLS verification is mandatory and no ambient AWS credential fallback exists.

Revocation denies new operations immediately at the API boundary; already-issued provider credentials expire within 60 seconds. Issuance limits are not storage quotas or hard spending ceilings. Credentials, signed proofs, and lease values must not enter receipts, logs, configuration, or evidence.

## Artifact continuity

Filesystem and managed R2 stores use canonical `artifact://<storeId>/<key>` references and immutable SHA-256 metadata. Static credential registries and legacy bucket aliases are rejected.

Do not change an existing artifact backend merely by toggling configuration. Inventory and quiesce affected jobs, verify destination access, copy and verify immutable records, then switch all consumers together. Preserve the source until acceptance. Existing external-storage bindings cannot be silently redirected to another connection or bucket.

Single-object uploads are bounded to 5 GB in this implementation. Longer-running operations renew scoped access rather than requesting permanent tokens. Training execution requires its own end-to-end qualification.

## GPU mode and recovery

The manager's awake transition drains training and warms inference; sleep drains inference and admits the selected training services. AI reads the manager-owned admission/activity files and never invokes Docker to change modes.

Before restore, verify that an encrypted archive covers every required state volume in the active component manifests at the configured runtime data root. A valid receipt or encryption check alone is insufficient. Preserve independent databases, artifact-signing identity, managed vault state, and referenced artifacts together; do not start an old writer against incompatible migrated state.

Acceptance status and immutable evidence belong in GitHub Issues and Actions. Storage read/write/isolation, mode cycling, backup coverage, restore, and training are separate gates.
