# Runtime compatibility

Exact runtime versions and digests are authoritative in:

- `containers/**/Dockerfile` for engine and application bases.
- `workers/*/requirements.lock` for Python dependencies.
- `pnpm-lock.yaml` for Node dependencies.
- `release/runtime-images.json` for upstream state-service images.
- `scripts/release/create-component-release.ts` for model revision defaults and component contracts.

The coordinated release emits a complete digest-bound image manifest. Never infer compatibility from a mutable tag or a stale version table.

Inference and training exchange immutable signed `ai.artifact/v1` manifests rather than sharing database schemas. Model revision, tokenizer, adapter topology, evaluation, and runtime compatibility gates still apply when an artifact is stored in R2.

Host OS, Docker/container runtime, GPU prerequisites, and Debian packaging belong exclusively to Deployment. CUDA user-space dependencies remain in engine images. GPU drivers and changes requiring reboot must follow the manager's supported host process.

Storage custody uses the TreeSeed SDK proof contract and Deployment's R2 implementation. The API must support that exact contract before an AI component requiring managed storage is activated. New storage selection must preserve existing local artifacts and identities.
