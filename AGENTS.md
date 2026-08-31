# AI Platform Package Guide

## Branch and deployment boundary

`main` is the only production branch and maps only to the `production` deployment environment. `staging` is the only development-integration branch and maps only to the `staging` deployment environment. Short-lived pull-request branches may validate without deploying, but they must never define another deployment environment. Do not create or use `development`, `preview`, `stable`, or any other GitHub deployment environment; preview deployments are prohibited. Release tags may promote an exact reviewed `staging` commit to `production` without creating another branch or environment. Artifact channel names must never become GitHub deployment environments.

## Work and review records

- Start planned repository work from a GitHub issue that defines the outcome, bounded scope, acceptance criteria, and rollback expectations. If authorized work has no issue, create or obtain one before making further implementation commits.
- Keep changes scoped to the issue and develop them on a non-protected branch. Never push implementation or release commits directly to `main`.
- Deliver every change through a pull request. Link the work item with `Closes #N` when the PR completes it, and preserve the issue and PR numbers in progress updates and handoffs.
- Treat the pull-request body as the durable record for human and agent work: record work authority, exact base and head commits, plan and revisions, commits, verification evidence, risks, rollback, and completion status.
- Do not merge with unresolved review findings or failing required checks. Verify the exact reviewed head commit before merge and the resulting `main` commit before release.
- Release publication requires a merged, reviewed PR and an explicit manual dispatch from the protected `production` environment. Never publish from an unreviewed branch or replace that gate with a push-triggered workflow.
- Keep GitHub credentials, signing keys, API keys, and other secret material outside repository files, issue bodies, pull-request text, command arguments, logs, and agent workspaces.
- Reconcile issue state whenever a pull request merges and at every release checkpoint. Close fully resolved issues with a concise comment linking the merged PR and verification evidence; do not rely on default-branch closing keywords when the repository merges through `staging` first.
- Keep partially resolved and umbrella issues open only with an updated comment that states the remaining acceptance work and current blocker. Do not close an issue merely because an attempted fix merged when live qualification still disproves the outcome.
- Audit open issues against merged pull requests regularly. Close stale duplicates and completed implementation issues with traceable evidence, while preserving distinct follow-up work in a new or clearly scoped existing issue.

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
- Do not create, retain, or dispatch legacy/transitional delivery paths after the replacement owner is available. TreeAI publishes immutable component releases; Deployment owns host APT repositories and lifecycle integration.
- Reuse prior successful GPU qualification evidence until a relevant fingerprint, implementation, dataset contract, or final release gate changes. Do not repeat long training merely for reassurance.
- For long external workflows, use infrequent bounded status snapshots. Do not stream repetitive watch output or spend active work cycles polling unchanged state.
- Before an expensive build, scan, publication, or GPU run, identify the exact unresolved acceptance criterion it proves and use the smallest affected package/image/test scope.
- Before publishing a replacement release candidate, batch every currently known activation defect and run `pnpm check:activation-closure`. The affected closure must validate generated Compose, persistent versus one-shot service ownership, state-volume permissions for each declared runtime identity, every lifecycle executable, and mode-gate read/write behavior. Cut another candidate only for a downstream defect that the passing closure could not observe, and record why it was previously hidden.

## Qualification evidence and GPU cost

- Treat successful full-corpus GPU qualifications as reusable evidence. Preserve their immutable datasets, signed artifacts, machine profiles, image digests, configuration digests, results, and receipts so routine fixes can replay downstream import, evaluation, promotion, rollback, and agent canaries without retraining.
- Do not rerun proven EDGAR, NASA, or equivalent long-running training solely to validate an unrelated API, packaging, updater, orchestration, evaluation, or presentation change. Run the smallest affected smoke test or canary instead.
- Invalidate prior training evidence when a training-critical fingerprint changes, including the base-model revision, training dataset or split, Axolotl/Marker/CUDA image digest, objective, adapter topology or rank, tokenizer, sequence or image limits, optimizer profile, or relevant hardware/runtime identity.
- Require one final end-to-end integration qualification before a release that claims the training loop. It may reuse previously proven immutable intermediate artifacts until the final training gate, but the final gate must exercise the real release candidate from ingestion through training, signing, import, evaluation, serving, and rollback.
- Record why evidence was reused or invalidated in the issue and pull request. Never trade away signature verification, checksum verification, compatibility checks, health gates, or rollback validation to save GPU time.

## Project library

Use `trsd library show ai` and `status` before querying `treeseed-ai/ai-library`. Read root-level paths at an exact commit. Author only through governed library workspaces and reviews. Never recreate `src/content` or edit `.treeseed/data` directly.
