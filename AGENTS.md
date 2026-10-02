# AI Platform Package Guide

## CRITICAL: complete automated test coverage

Every behavior, contract, state transition, failure path, and edge case must have automated unit, integration, and scene/guarantee-based acceptance coverage. This is mandatory for all projects, especially the capacity-provider and agent system. A behavior without all three layers is an unresolved delivery gap, not completed work.

- Unit tests must prove exact outputs, validation, invariants, and boundary conditions. Cover valid and invalid inputs, missing/empty/malformed values, authorization denial, stale or moved refs, and every named prohibited field.
- Integration tests must exercise the real owning components and their public boundaries: handlers, provider/kernel execution, APIs, persistence, tools, and downstream consumers. Mocks, string assertions, compilation, or call-order checks alone are not integration proof.
- Coded scenes and guarantees must prove production-shaped end-to-end outcomes: exact governed artifacts and read-back, independent verification, actual usage, exactly-once settlement, and durable teardown. Use the project's existing native acceptance harness and respect package ownership; do not put TreeSeed-specific policy into product-neutral packages.
- Cover duplicate and concurrent execution, idempotency, partial failure, interruption, retry, resume, cancellation, expiry, provider/tool/subprocess errors, unsafe commands, and cleanup without residue. Preserve failed observations; do not fabricate dispositions, usage, citations, receipts, or passing replays.
- For every defect, first add a focused regression that reproduces the failure, then add or strengthen the corresponding integration and scene/guarantee cases. Fix the earliest owning contract. Retain previously covered behavior and all historical failed evidence.
- Never weaken assertions, remove negative cases, narrow acceptance criteria, disable type checks, extend deadlines, increase allowances, or relabel failures as passes to get green results. An unexpected agent timeout is a fatal architecture defect: agents must check authoritative remaining time frequently, reserve verification/closeout time, and produce authorized continuation proposals for unfinished work before the original deadline.
- Delivery requires passing evidence at all three layers on the exact candidate. Missing environments, credentials, skipped tests, or blocked layers remain explicitly unproven. Component passes, suite totals, line coverage, and process completion never substitute for full semantic acceptance.
- Before EVERY acceptance run (scene or guarantee), run ALL automated unit and integration tests for every participating project on the exact candidate. Focused regressions are additional checks, not substitutes for the complete suites. Failed, skipped, missing, empty, or inconclusive prerequisite coverage blocks acceptance; never launch a live campaign first and discover prerequisite failures afterward. Run the complete suites once per participating project per acceptance invocation, before any scene begins; do not reuse a previous invocation's passing receipt or omit tests to save time. Preserve exact command, candidate, run, and result evidence in the existing Issue and Actions artifacts.
- Keep the behavior-to-unit/integration/scene mapping and exact command, commit, run, and artifact evidence in the existing Issue body and Actions artifacts. Reproduce failures with cheap focused tests before another expensive activation or full campaign; batch known fixes, inspect failed jobs, and reuse only unchanged immutable evidence. No duplicate campaigns or new coverage side channels.

## Agent configuration and handler ownership

When this project defines or consumes agents, agent identity, task instructions, prompts, capabilities, permissions, parameters, and activity profiles must be governed YAML configuration. Adding or renaming an agent using existing handlers must not require provider, guest, kernel, or scheduler code changes. Do not hardcode named-role configuration in shared runtime code; shared rules must apply to any configured agent.

Task-specific executable code belongs in the configured handler. Reuse existing class-based handlers and exact profile bindings; new coded functionality may require a pinned handler, but not a parallel dispatch path or duplicated policy. Test arbitrary YAML-defined agents, renamed identities, handler selection, changed prompts/parameters, denied permissions, and unknown/duplicate handlers through unit, real integration, and coded acceptance cases.

## Efficient delivery

GitHub Issues hold the current contract and status; Actions hold verification evidence.
Do not post routine issue or pull-request comments. Update issue bodies and use PR
descriptions for implementation context. Fetch protected heads before branching,
merging, or releasing. Reuse immutable evidence and unchanged image layers, batch
known defects, and optimize for completed verified outcomes, not repeated reporting.
Human approval is required only for PRs to `main`; agents may merge passing staging PRs.

## Branch and deployment boundary

`main` is the only production branch and maps only to the `production` deployment environment. `staging` is the only development-integration branch and maps only to the `staging` deployment environment. Short-lived pull-request branches may validate without deploying, but they must never define another deployment environment. Do not create or use `development`, `preview`, `stable`, or any other GitHub deployment environment; preview deployments are prohibited. Release tags may promote an exact reviewed `staging` commit to `production` without creating another branch or environment. Artifact channel names must never become GitHub deployment environments.

## Work and review records

- Start planned repository work from a GitHub issue that defines the outcome, bounded scope, acceptance criteria, and rollback expectations. If authorized work has no issue, create or obtain one before making further implementation commits.
- Keep changes scoped to the issue and develop them on a non-protected branch. Never push implementation or release commits directly to `main`.
- Deliver every change through a pull request. Link the work item with `Closes #N` when the PR completes it, and preserve the issue and PR numbers in progress updates and handoffs.
- Treat the pull-request body as the durable record for human and agent work: record work authority, exact base and head commits, plan and revisions, commits, verification evidence, risks, rollback, and completion status.
- Do not merge with unresolved review findings or failing required checks. Verify the exact reviewed head commit before merge and the resulting protected-branch commit before release.
- Release publication requires a merged PR and an explicit manual dispatch from the matching `staging` or `production` environment. Never publish from an unreviewed branch or replace that gate with a push-triggered workflow.
- Keep GitHub credentials, signing keys, API keys, and other secret material outside repository files, issue bodies, pull-request text, command arguments, logs, and agent workspaces.
- Reconcile issue state whenever a pull request merges and at every release checkpoint. Update the issue body with merged PR and Actions evidence; close it without a routine comment only when all acceptance passes.
- Keep partially resolved and umbrella issues open with their remaining acceptance recorded in the body. A merged attempt is not completed live acceptance.
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
- Use Deployment's SDK/CLI plan and apply operations for host reconciliation. AI publishes component contracts and processes engine-local jobs; it must not own Docker, APT, host configuration, or an independent supervisor.
- External artifact access uses the registered runtime's signed workload proof and the control plane's service-vault binding. Never accept static R2 keys or ambient AWS credentials. Host/workload bootstrap identities remain Deployment-owned and OS-sealed.
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
