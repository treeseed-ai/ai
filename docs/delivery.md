# Release delivery

Publication is manual. Merge a reviewed `staging` branch into `main`, configure
the protected GitHub `production` environment, and dispatch **Publish coordinated
TreeSeed AI release** with the version declared in `release/manifest.json`. The workflow refuses any other
branch/version and does not create a tag until images, scans, signatures, and
packages succeed.

Image publication is role-selective. `release/image-builds.json` defines each
role's Dockerfile, platform, build arguments, and relevant context. The release
workflow hashes those inputs and compares the identity with the previous signed
release manifest. A matching digest is reused only after the prior release
checksums, Cosign signature, SBOM, and vulnerability report verify under the
current exception policy. Changed roles are built, scanned, signed, and assigned
a new semantic tag; reused roles retain their first-build tag and immutable
digest. Every coordinated release still emits a complete digest manifest for
all roles. The first release after adopting image-manifest v2 builds every role
once to establish trusted identities.

For a feature release, `release/manifest.json.changedImages` is the reviewed
declaration of roles whose image contents intentionally change. Every omitted
role must have a verified prior digest or publication fails. This prevents
coordinated Debian version changes from rebuilding large unchanged images such
as vLLM while keeping the exception explicit in the release record.

Required environment secrets are `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`,
`APT_GPG_PRIVATE_KEY`, and `APT_GPG_PASSPHRASE`. Before dispatch, commit the
matching public archive key and fingerprint as described in `release/apt`.
Jobs that consume Docker Hub or APT signing credentials run in `production`.
The final secret-free Pages deployment runs separately in `github-pages`.

Release candidates use the manually dispatched **Publish protected TreeAI release candidate** workflow from `staging`. Tags omit a `v` prefix and follow `0.9.0-rc1`; Debian versions use `0.9.0~rc1-1` so the final `0.9.0-1` sorts newer. APT signing material is held only in the protected `staging` environment and differs from the stable key. The workflow never builds or publishes development containers. It verifies the latest stable image manifest and signatures, reuses unchanged production digests, and records whether the candidate is `package-only` or `local-images-required`.

For `local-images-required`, the catalog names the exact roles, build identities, and source revision. The development host must explicitly build them from that checkout with `treeai local-build`; the manager verifies the atomic receipt and current Docker image IDs before it permits package installation. This keeps repository execution outside the automatic privileged update path. Unchanged roles continue to use their production digests.

After GitHub Pages publication, clients can install the archive with a
dedicated keyring and deb822 source:

```bash
curl -fsSLo /tmp/treeseed-ai-archive-keyring.asc \
  https://treeseed-ai.github.io/ai/apt/treeseed-ai-archive-keyring.asc
sudo install -m 0644 /tmp/treeseed-ai-archive-keyring.asc \
  /etc/apt/keyrings/treeseed-ai-archive-keyring.asc
sudo tee /etc/apt/sources.list.d/treeseed-ai.sources >/dev/null <<'SOURCES'
Types: deb
URIs: https://treeseed-ai.github.io/ai/apt
Suites: stable
Components: main
Architectures: amd64
Signed-By: /etc/apt/keyrings/treeseed-ai-archive-keyring.asc
SOURCES
sudo apt update
sudo apt install treeseed-ai
```

If only Pages publication fails after a GitHub Release exists, dispatch
**Repair TreeAI APT repository** with the existing stable version. It reconstructs
the stable suite from immutable GitHub Release packages, preserves the currently
signed development suite, and republishes both beneath `/apt` without rebuilding
images or packages.

If checksum publication alone is malformed, dispatch **Repair TreeSeed AI
release checksums**. It verifies the existing signature and payloads, then
replaces only the signed checksum pair through the protected environment.
