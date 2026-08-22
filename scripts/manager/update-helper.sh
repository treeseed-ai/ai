#!/bin/sh
set -eu
systemctl daemon-reload
systemctl restart treeseed-ai-manager-supervisor.service
systemctl restart treeseed-ai-manager-api.service
/usr/lib/treeseed-ai/runtime/bin/node /usr/lib/treeseed-ai/manager/dist/cli.js platform doctor --json >/dev/null
