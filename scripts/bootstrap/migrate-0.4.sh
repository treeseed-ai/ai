#!/bin/sh
set -eu

root=${TREEAI_MIGRATION_ROOT:-}
systemctl_command=${TREEAI_MIGRATION_SYSTEMCTL:-systemctl}
dpkg_query_command=${TREEAI_MIGRATION_DPKG_QUERY:-dpkg-query}
state="$root/var/lib/treeseed-ai/bootstrap"
approved="$state/legacy-0.4.approved"

path() { printf '%s%s' "$root" "$1"; }
installed_version() { "$dpkg_query_command" -W -f='${Version}' treeseed-ai-host-runtime 2>/dev/null || true; }
legacy() {
	version=$(installed_version)
	case "$version" in 0.4.*) ;; *) return 1 ;; esac
	[ -f "$(path /usr/lib/systemd/system/treeseed-ai-factory.service)" ] || "$systemctl_command" cat treeseed-ai-factory.service >/dev/null 2>&1
	[ ! -f "$(path /etc/treeseed-ai/platform.json)" ]
}
busy_file() {
	file=$1
	[ -f "$file" ] || return 1
	grep -Eq '"(active|activeGpuJobs)"[[:space:]]*:[[:space:]]*[1-9][0-9]*' "$file"
}
mode() {
	file=$(path /var/lib/treeseed-ai/host-runtime/factory/mode.json)
	value=$(sed -n 's/.*"mode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" 2>/dev/null | head -1)
	case "$value" in awake|sleep) printf '%s' "$value" ;; *) printf 'unknown' ;; esac
}
inspect() {
	missing=''
	for name in inference training; do
		file=$(path "/etc/treeseed-ai/$name/environment")
		[ -s "$file" ] || missing="$missing $file"
		if [ -s "$file" ]; then
			for variable in POSTGRES_PASSWORD S3_SECRET_KEY MINIO_ROOT_PASSWORD; do
				grep -q "^$variable=" "$file" || missing="$missing $file:$variable"
			done
		fi
	done
	for file in \
		/etc/treeseed-ai/host-runtime/factory/tls/ca.key \
		/etc/treeseed-ai/host-runtime/factory/tls/ca.crt \
		/etc/treeseed-ai/host-runtime/factory/tls/server.key \
		/etc/treeseed-ai/host-runtime/factory/tls/server.crt \
		/etc/treeseed-ai/host-runtime/factory/artifact-signing-key.pem \
		/etc/treeseed-ai/host-runtime/factory/artifact-signing-public.pem
	do
		[ -s "$(path "$file")" ] || missing="$missing $(path "$file")"
	done
	busy=false
	busy_file "$(path /run/treeseed-ai/inference/status.json)" && busy=true
	busy_file "$(path /run/treeseed-ai/training/status.json)" && busy=true
	current_mode=$(mode)
	status=ready
	[ -z "$missing" ] || status=blocked
	[ "$busy" = false ] || status=blocked
	[ "$current_mode" != unknown ] || status=blocked
}
print_plan() {
	inspect
	version=$(installed_version)
	if [ "${json:-false}" = true ]; then
		printf '{"schemaVersion":"treeai.legacy-migration-plan/v1","status":"%s","installedVersion":"%s","mode":"%s","activeWork":%s,"missing":"%s","preserves":["product-environments","postgres-volumes","minio-volumes","factory-tls","artifact-signing-material","gpu-mode","compose-projects"]}\n' "$status" "$version" "$current_mode" "$busy" "$(printf '%s' "$missing" | sed 's/^ *//')"
	else
		printf '%-11s legacy-package: treeseed-ai-host-runtime %s\n' ready "$version"
		printf '%-11s gpu-mode: %s\n' "$([ "$current_mode" = unknown ] && printf blocked || printf ready)" "$current_mode"
		printf '%-11s active-work: %s\n' "$([ "$busy" = true ] && printf blocked || printf ready)" "$busy"
		if [ -n "$missing" ]; then printf 'BLOCKED     required-state:%s\n' "$missing"; else printf 'READY       required-state: product environments contain required persistent-service credentials\n'; fi
		printf '%s\n' 'PRESERVE    PostgreSQL/MinIO volumes, product environments, TLS, signing material, GPU mode, and Compose project names'
	fi
	[ "$status" = ready ]
}

command=${1:-plan}
shift || true
json=false
confirm=false
for argument in "$@"; do
	case "$argument" in --json) json=true ;; --confirm) confirm=true ;; *) printf 'Unknown option: %s\n' "$argument" >&2; exit 64 ;; esac
done
case "$command" in
	detect) legacy ;;
	plan)
		legacy || { printf 'No migratable TreeAI 0.4 factory was detected.\n' >&2; exit 2; }
		print_plan
		;;
	apply)
		[ "$confirm" = true ] || { printf 'apply requires --confirm\n' >&2; exit 64; }
		if [ "${TREEAI_MIGRATION_TEST:-false}" != true ] && [ "$(id -u)" -ne 0 ]; then printf 'apply requires local root authority\n' >&2; exit 77; fi
		legacy || { printf 'No migratable TreeAI 0.4 factory was detected.\n' >&2; exit 2; }
		print_plan >/dev/null
		install -d -m 0700 "$state"
		temporary="$approved.new"
		printf '{"schemaVersion":"treeai.legacy-migration-approval/v1","approvedAt":"%s","installedVersion":"%s","mode":"%s"}\n' "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" "$(installed_version)" "$(mode)" >"$temporary"
		chmod 0600 "$temporary"
		mv "$temporary" "$approved"
		"$systemctl_command" start --no-block treeseed-ai-bootstrap.service
		printf 'TreeAI 0.4 migration approved; follow with: journalctl -fu treeseed-ai-bootstrap.service\n'
		;;
	*) printf 'Usage: %s plan [--json] | apply --confirm [--json]\n' "$0" >&2; exit 64 ;;
esac
