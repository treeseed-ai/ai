#!/bin/sh
set -eu

install -d -o hermes -g hermes "$HERMES_HOME" /workspace
chown hermes:hermes "$HERMES_HOME" /workspace

managed="${HERMES_MANAGED_DIR:-/run/hermes-managed}"
install -d -o root -g hermes -m 0750 "$managed"
umask 027
config="$managed/config.yaml.new.$$"
printf '%s\n' \
  'model:' \
  '  default: local-model' \
  '  provider: custom' \
  '  base_url: http://experience-proxy:8080/v1' \
  '  api_key: lab-hermes' \
  '  api_mode: chat_completions' \
  'terminal:' \
  '  backend: local' \
  '  cwd: /workspace' \
  'approvals:' \
  '  mode: "off"' \
  'security:' \
  '  allow_lazy_installs: false' \
  'web:' \
  '  search_backend: treeai' \
  '  extract_backend: treeai' \
  'platform_toolsets:' \
  '  api_server:' \
  '    - file' \
  '    - terminal' \
  '    - web' \
  '    - todo' \
  '    - clarify' \
  '    - memory' \
  '    - session_search' \
  'gateway:' \
  '  api_server:' \
  '    max_concurrent_runs: 2' > "$config"
chown root:hermes "$config"
chmod 0640 "$config"
mv "$config" "$managed/config.yaml"
export HERMES_MANAGED_DIR="$managed"

case "${HERMES_SERVICE_MODE:-dashboard}" in
  dashboard)
    export HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH="$(cat /run/secrets/hermes-password-hash)"
    export HERMES_DASHBOARD_BASIC_AUTH_SECRET="$(cat /run/secrets/hermes-session-secret)"
    exec gosu hermes hermes dashboard --host 0.0.0.0 --port 9119 --no-open --skip-build
    ;;
  gateway)
	 managed_env="$managed/.env.new.$$"
	 {
	   printf '%s\n' \
	     'API_SERVER_ENABLED=true' \
	     'API_SERVER_HOST=0.0.0.0' \
	     'API_SERVER_PORT=8642' \
	     'API_SERVER_MODEL_NAME=hermes-agent' \
	     'OPENAI_BASE_URL=http://experience-proxy:8080/v1' \
	     'OPENAI_API_KEY=lab-hermes'
	   printf 'API_SERVER_KEY=%s\n' "$(cat /run/secrets/hermes-api-key)"
	 } > "$managed_env"
	 chown root:hermes "$managed_env"
	 chmod 0640 "$managed_env"
	 mv "$managed_env" "$managed/.env"
    exec gosu hermes hermes gateway run --force --no-supervise
    ;;
  *)
    echo "Unsupported HERMES_SERVICE_MODE" >&2
    exit 64
    ;;
esac
