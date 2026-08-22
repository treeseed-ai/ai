#!/bin/sh
set -eu
state=/var/lib/treeseed-ai/bootstrap
seed="$state/seed/platform.json.incoming"
stable=/etc/apt/sources.list.d/treeseed-ai-stable.sources
development=/etc/apt/sources.list.d/treeseed-ai-development.sources
legacy="$state/legacy"
log(){ printf '%s\n' "$1" >>"$state/bootstrap.log"; }
installed(){ dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
restore_legacy(){
  log 'manager handoff failed; restoring legacy coordinator'
  systemctl disable --now treeseed-ai-manager-api.service >/dev/null 2>&1 || true
  if [ -f "$legacy/treeseed-ai-factory.service" ]; then
    install -m 0644 "$legacy/treeseed-ai-factory.service" /usr/lib/systemd/system/treeseed-ai-factory.service
    if [ -d "$legacy/factory-dist" ]; then mkdir -p /usr/lib/treeseed-ai/host-runtime/dist/factory; cp -a "$legacy/factory-dist/." /usr/lib/treeseed-ai/host-runtime/dist/factory/; fi
    if [ -d "$legacy/factory-compose" ]; then mkdir -p /usr/lib/treeseed-ai/factory; cp -a "$legacy/factory-compose/." /usr/lib/treeseed-ai/factory/; fi
    systemctl daemon-reload
    if [ -f "$legacy/was-active" ]; then systemctl start treeseed-ai-factory.service || true; fi
  fi
}
trap 'code=$?; if [ "$code" -ne 0 ]; then restore_legacy; fi' EXIT
install -d -m 0700 "$state" "$state/seed" "$legacy"
channel=stable
if [ -f "$seed" ] && grep -Eq '"channel"[[:space:]]*:[[:space:]]*"development"' "$seed"; then channel=development; fi
install -m 0644 "/usr/share/treeseed-ai/bootstrap/$channel.sources" "/etc/apt/sources.list.d/treeseed-ai-$channel.sources"
if [ "$channel" = stable ]; then rm -f "$development"; else rm -f "$stable"; fi

if systemctl cat treeseed-ai-factory.service >/dev/null 2>&1; then
  systemctl is-active --quiet treeseed-ai-factory.service && : >"$legacy/was-active" || true
  [ ! -f /usr/lib/systemd/system/treeseed-ai-factory.service ] || [ -f "$legacy/treeseed-ai-factory.service" ] || cp -a /usr/lib/systemd/system/treeseed-ai-factory.service "$legacy/treeseed-ai-factory.service"
  [ ! -d /usr/lib/treeseed-ai/host-runtime/dist/factory ] || [ -d "$legacy/factory-dist" ] || cp -a /usr/lib/treeseed-ai/host-runtime/dist/factory "$legacy/factory-dist"
  [ ! -d /usr/lib/treeseed-ai/factory ] || [ -d "$legacy/factory-compose" ] || cp -a /usr/lib/treeseed-ai/factory "$legacy/factory-compose"
fi

log 'waiting for package-manager transaction'
apt-get -o DPkg::Lock::Timeout=600 update
packages='treeseed-ai-archive-keyring treeseed-ai-development-archive-keyring treeseed-ai-host-js-runtime treeseed-ai-cli treeseed-ai-release-catalog treeseed-ai-manager treeseed-ai-factory'
for product in host-runtime inference training lab; do
  if installed "treeseed-ai-$product"; then packages="$packages treeseed-ai-$product"; fi
done
if ! installed treeseed-ai-host-runtime && [ -f "$seed" ] && grep -Eq '"management"[[:space:]]*:[[:space:]]*"managed"' "$seed"; then packages="$packages treeseed-ai-host-runtime"; fi
apt-get -o DPkg::Lock::Timeout=600 --no-remove --no-install-recommends install -y $packages
sed -i 's#/etc/apt/keyrings/treeseed-ai-bootstrap-#/usr/share/keyrings/treeseed-ai-#' "/etc/apt/sources.list.d/treeseed-ai-$channel.sources"
systemctl enable --now treeseed-ai-manager-supervisor.service
if ! systemctl start treeseed-ai-manager-reconcile.service; then
  if [ -f "$legacy/treeseed-ai-factory.service" ]; then exit 1; fi
  log 'initial product activation is degraded; manager API will expose recovery guidance'
fi
systemctl stop treeseed-ai-factory.service >/dev/null 2>&1 || true
systemctl disable treeseed-ai-factory.service >/dev/null 2>&1 || true
if ! systemctl enable --now treeseed-ai-manager-api.service || ! curl --silent --show-error --fail --retry 20 --retry-delay 1 --cacert /etc/treeseed-ai/manager/tls/ca.crt https://localhost:4790/healthz >/dev/null; then exit 1; fi
if [ "$channel" = development ]; then
  systemctl disable --now treeseed-ai-manager-stable.timer >/dev/null 2>&1 || true
  systemctl enable --now treeseed-ai-manager-development.timer
else
  systemctl disable --now treeseed-ai-manager-development.timer >/dev/null 2>&1 || true
  systemctl enable --now treeseed-ai-manager-stable.timer
fi
touch "$state/handoff.complete"
chmod 0600 "$state/handoff.complete"
systemctl disable treeseed-ai-bootstrap.service >/dev/null 2>&1 || true
trap - EXIT
log 'manager handoff complete'
