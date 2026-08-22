# Release delivery

Publication is manual. Merge a reviewed `staging` branch into `main`, configure
the protected GitHub `production` environment, and dispatch **Publish coordinated
TreeSeed AI release** with version `0.6.1`. The workflow refuses any other
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

Required environment secrets are `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`,
`APT_GPG_PRIVATE_KEY`, and `APT_GPG_PASSPHRASE`. Before dispatch, commit the
matching public archive key and fingerprint as described in `release/apt`.
Jobs that consume Docker Hub or APT signing credentials run in `production`.
The final secret-free Pages deployment runs separately in `github-pages`.

Development generations use the manually dispatched **Publish protected TreeAI development generation** workflow from `staging`. Its APT signing material is held only in the protected `staging` environment and differs from the stable key. Versions follow `0.6.1~dev.YYYYMMDD.HHMMSS+g<commit>-1`; changed images receive immutable `dev-<commit>` tags while unchanged signed digests are reused. No floating development tag is published.

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
**Repair TreeSeed AI APT publication**. It reconstructs the complete repository
from immutable release assets without rebuilding images or packages.

If checksum publication alone is malformed, dispatch **Repair TreeSeed AI
release checksums**. It verifies the existing signature and payloads, then
replaces only the signed checksum pair through the protected environment.
