#!/bin/sh
set -eu

install -d -o hermes -g hermes "$HERMES_HOME" /workspace
chown hermes:hermes "$HERMES_HOME" /workspace

if [ ! -f "$HERMES_HOME/config.yaml" ]; then
  umask 077
  printf '%s\n' \
    'model:' \
    '  default: local-model' \
    '  provider: custom' \
    '  base_url: http://experience-proxy:8080/v1' \
    '  api_key: lab-internal' \
    '  api_mode: chat_completions' \
    'security:' \
    '  allow_lazy_installs: false' > "$HERMES_HOME/config.yaml"
  chown hermes:hermes "$HERMES_HOME/config.yaml"
fi

export HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH="$(cat /run/secrets/hermes-password-hash)"
export HERMES_DASHBOARD_BASIC_AUTH_SECRET="$(cat /run/secrets/hermes-session-secret)"
exec gosu hermes hermes dashboard --host 0.0.0.0 --port 9119 --no-open --skip-build
