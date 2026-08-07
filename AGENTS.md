# AI Package Guide

- Follow the Market workspace capacity and reconciliation architecture.
- Do not introduce a second project scheduler or task queue.
- Do not expose vLLM management endpoints.
- Keep raw vLLM on loopback or a private Compose network; public clients use the authenticated gateway.
- The appliance supervisor reconciles machine services but never schedules assignments or training jobs.
- Do not write directly to project repositories; use assignment-scoped TreeDX operations.
- Route provider work through assignments, leases, usage, and settlement.
- Keep raw experience outside Git; Git receives curated manifests and content only.
- Keep handwritten source and tests below 500 lines and direct executable directories below ten files.
- Preserve independent package build and test operation.
- Do not add a push-triggered hosted deployment workflow.
- Use plan for non-mutating previews and live execution for work; never add dry-run behavior.
