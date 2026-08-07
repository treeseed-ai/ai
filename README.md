# TreeSeed AI

TreeSeed AI is the independently installable local AI appliance for TreeSeed. It provides a validated appliance manifest, hardware and virtual-machine diagnostics, SDK-reconciled Docker Compose lifecycle, an authenticated OpenAI-compatible inference gateway, and Debian/systemd packaging.

The inference gateway supports both `/v1/responses` and `/v1/chat/completions`, maps the stable `treeseed-qwen3.5-4b` alias to `Qwen/Qwen3.5-4B`, and keeps raw vLLM bound to loopback. The bundled agent provider catalog declares Codex, GitHub Copilot, and OpenCode subscription, key, and TreeSeed profiles.

The OpenCode TreeSeed profile is supplied as `config/opencode/opencode.json`. OpenCode remains an execution-provider tool service, not part of the model data plane; its server lifecycle and workspace mounts belong to the agent capacity-provider deployment.

Axolotl training remains planned. Experience curation, sleep-cycle scheduling, dataset packaging, LoRA competition, and governed adapter promotion are not claimed by this milestone.

TreeSeed API remains the governance and control-plane scheduler. This appliance does not create a second project scheduler or task queue. It does not mutate project Git repositories directly: content continues through assignment-scoped TreeDX operations, while provider work uses capacity assignments, leases, usage, and settlement.

## Commands

```bash
npm run build
npm test
npm run verify
npm run build:deb
treeseed-ai diagnose
treeseed-ai status --manifest ./treeseed.ai-appliance.yaml
treeseed-ai plan --manifest ./treeseed.ai-appliance.yaml
treeseed-ai apply --manifest ./treeseed.ai-appliance.yaml
treeseed-ai serve --manifest ./treeseed.ai-appliance.yaml
```

The default profile requires an NVIDIA GPU visible inside Docker. On a virtual machine, run `treeseed-ai diagnose` before applying the Compose resource; missing PCI passthrough or NVIDIA Container Toolkit support is reported as blocked hardware readiness.
