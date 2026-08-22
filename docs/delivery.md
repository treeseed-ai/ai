# Release delivery

Publication is manual. Merge a reviewed `staging` branch into `main`, configure
the protected GitHub `production` environment, and dispatch **Publish coordinated
TreeSeed AI release** with version `0.5.0`. The workflow refuses any other
branch/version and does not create a tag until images, scans, signatures, and
packages succeed.

Required environment secrets are `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`,
`APT_GPG_PRIVATE_KEY`, and `APT_GPG_PASSPHRASE`. Before dispatch, commit the
matching public archive key and fingerprint as described in `release/apt`.
Jobs that consume Docker Hub or APT signing credentials run in `production`.
The final secret-free Pages deployment runs separately in `github-pages`.

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
sudo apt install treeseed-ai-factory
```

If only Pages publication fails after a GitHub Release exists, dispatch
**Repair TreeSeed AI APT publication**. It reconstructs the complete repository
from immutable release assets without rebuilding images or packages.
