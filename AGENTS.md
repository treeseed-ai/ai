# AI Platform Package Guide

- Do not introduce a project scheduler or cross-product task queue; managers process only engine-local jobs.
- Do not expose raw vLLM or worker management endpoints.
- Keep raw vLLM and workers on private Compose networks; public clients use authenticated APIs.
- Keep inference and training independently buildable, installable, configurable, and upgradeable.
- Do not share product database schemas; exchange immutable signed artifact manifests.
- Keep raw datasets, checkpoints, models, and archives outside Git.
- Keep handwritten source and tests below 500 lines and direct executable directories below ten files.
- Do not add a push-triggered hosted deployment workflow.
- Use plan for non-mutating Compose previews and apply for live reconciliation; never add dry-run behavior.
