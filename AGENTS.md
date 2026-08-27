# AI Platform Package Guide

## Work and review records

- Start planned repository work from a GitHub issue that defines the outcome, bounded scope, acceptance criteria, and rollback expectations. If authorized work has no issue, create or obtain one before making further implementation commits.
- Keep changes scoped to the issue and develop them on a non-protected branch. Never push implementation or release commits directly to `main`.
- Deliver every change through a pull request. Link the work item with `Closes #N` when the PR completes it, and preserve the issue and PR numbers in progress updates and handoffs.
- Treat the pull-request body as the durable record for human and agent work: record work authority, exact base and head commits, plan and revisions, commits, verification evidence, risks, rollback, and completion status.
- Do not merge with unresolved review findings or failing required checks. Verify the exact reviewed head commit before merge and the resulting `main` commit before release.
- Release publication requires a merged, reviewed PR and an explicit manual dispatch from the protected `production` environment. Never publish from an unreviewed branch or replace that gate with a push-triggered workflow.
- Keep GitHub credentials, signing keys, API keys, and other secret material outside repository files, issue bodies, pull-request text, command arguments, logs, and agent workspaces.

## Architecture

- Do not introduce a project scheduler or cross-product task queue; managers process only engine-local jobs.
- Do not expose raw vLLM or worker management endpoints.
- Keep raw vLLM and workers on private Compose networks; public clients use authenticated APIs.
- Keep inference and training independently buildable, installable, configurable, and upgradeable.
- Do not share product database schemas; exchange immutable signed artifact manifests.
- Keep raw datasets, checkpoints, models, and archives outside Git.
- Keep handwritten source and tests below 500 lines and direct executable directories below ten files.
- Do not add a push-triggered hosted deployment workflow.
- Use plan for non-mutating Compose previews and apply for live reconciliation; never add dry-run behavior.

## Qualification evidence and GPU cost

- Treat successful full-corpus GPU qualifications as reusable evidence. Preserve their immutable datasets, signed artifacts, machine profiles, image digests, configuration digests, results, and receipts so routine fixes can replay downstream import, evaluation, promotion, rollback, and agent canaries without retraining.
- Do not rerun proven EDGAR, NASA, or equivalent long-running training solely to validate an unrelated API, packaging, updater, orchestration, evaluation, or presentation change. Run the smallest affected smoke test or canary instead.
- Invalidate prior training evidence when a training-critical fingerprint changes, including the base-model revision, training dataset or split, Axolotl/Marker/CUDA image digest, objective, adapter topology or rank, tokenizer, sequence or image limits, optimizer profile, or relevant hardware/runtime identity.
- Require one final end-to-end integration qualification before a release that claims the training loop. It may reuse previously proven immutable intermediate artifacts until the final training gate, but the final gate must exercise the real release candidate from ingestion through training, signing, import, evaluation, serving, and rollback.
- Record why evidence was reused or invalidated in the issue and pull request. Never trade away signature verification, checksum verification, compatibility checks, health gates, or rollback validation to save GPU time.

## Project library

Use `trsd library show ai` and `status` before querying `treeseed-ai/ai-library`. Read root-level paths at an exact commit. Author only through governed library workspaces and reviews. Never recreate `src/content` or edit `.treeseed/data` directly.
