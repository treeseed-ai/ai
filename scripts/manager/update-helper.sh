#!/bin/sh
set -eu
systemctl daemon-reload
systemctl restart treeseed-ai-manager-supervisor.service
systemctl restart treeseed-ai-manager-api.service
attempt=0
until /usr/lib/treeseed-ai/runtime/bin/node /usr/lib/treeseed-ai/manager/dist/cli.js platform doctor --json >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || exit 1
  sleep 1
done
