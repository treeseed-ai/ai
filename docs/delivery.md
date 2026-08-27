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

Both protected GitHub environments need Docker Hub publication credentials:
`staging` for release candidates and `production` for stable releases. Store
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` in each environment; never move an
RC job into `production` or loosen the environment's branch policy to reuse a
secret. Deployment owns APT signing and host-package publication.

Release candidates use the manually dispatched **Publish protected TreeAI
component release candidate** workflow from `staging`. Tags omit a `v` prefix
and follow `0.10.0-rc1`; component Debian versions use `0.10.0~rc1-1` so the
final `0.10.0-1` sorts newer. The workflow publishes exact RC image tags,
reusing unchanged signed digests, and emits an immutable component bundle for
Deployment to ingest.

The Deployment project verifies the component manifest and Compose checksum,
then compiles the selected bundle into its signed development catalog. Hosts
never build downloaded repository source. Unchanged roles retain their prior
signed image digest and do not restart merely because a component release was
published.

TreeAI does not publish host APT suites. Deployment consumes the immutable
component bundle and publishes the exact component package and catalog through
its protected release workflow. Do not add a transitional TreeAI APT bridge or
use a component repository to reconstruct Deployment-owned package indexes.

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
