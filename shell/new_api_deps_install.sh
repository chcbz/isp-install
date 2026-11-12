#!/bin/bash
# Dependencies only: no New API application, public ports or host database installs.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
check_root
APP_DIR=/home/isp/apps/new-api-deps
CONF_DIR=/home/isp/conf/new-api-deps
STATE_DIR=/home/isp/state/new-api-deps
TEMPLATE="$SCRIPT_DIR/../conf/new-api-deps/compose.yaml"
[[ -f "$TEMPLATE" ]] || { __red 'Missing Compose template.'; exit 1; }
docker info >/dev/null
docker compose version >/dev/null
command -v openssl >/dev/null || { __red 'openssl is required to generate secrets.'; exit 1; }
# Lock repeated installs, including initial secret generation and image locking.
exec 9>/run/lock/isp-new-api-deps.lock
flock -n 9 || { __red 'Another dependency installation is running.'; exit 1; }
for directory in "$APP_DIR" "$CONF_DIR" "$STATE_DIR"; do
    [[ ! -L "$directory" ]] || { __red "Refusing symlink: $directory"; exit 1; }
done
[[ ! -L "$CONF_DIR/.env" && ! -L "$APP_DIR/compose.yaml" ]] || {
    __red 'Refusing symlinked credentials or Compose file.'; exit 1;
}
if [[ -e "$APP_DIR/compose.yaml" ]] && ! cmp -s "$TEMPLATE" "$APP_DIR/compose.yaml"; then
    __red 'Installed Compose differs from template; review instead of overwriting.'; exit 1
fi
# Never regenerate a database password when data could already exist.
if [[ ! -f "$CONF_DIR/.env" ]] && [[ -d "$STATE_DIR" ]] && \
    [[ -n "$(find "$STATE_DIR" -mindepth 1 -maxdepth 2 -print -quit)" ]]; then
    __red 'Existing data without credentials; refusing to generate new credentials.'; exit 1
fi
install -d -m 0700 "$APP_DIR" "$CONF_DIR" "$STATE_DIR"
umask 077
if [[ ! -f "$CONF_DIR/.env" ]]; then
    cat > "$CONF_DIR/.env" <<ENV
POSTGRES_IMAGE=${POSTGRES_IMAGE:-postgres:15-bookworm}
REDIS_IMAGE=${REDIS_IMAGE:-redis:7.4-bookworm}
POSTGRES_PASSWORD=$(openssl rand -hex 32)
REDIS_PASSWORD=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)
ENV
fi
[[ ! -L "$CONF_DIR/.env" && "$(stat -c %u "$CONF_DIR/.env")" == 0 ]] || {
    __red 'Credentials must be a root-owned regular file, not a symlink.'; exit 1;
}
chmod 0600 "$CONF_DIR/.env"
# Compose gives exported variables precedence over --env-file. Bootstrap overrides
# apply ONLY to initial generation; private persisted values must win thereafter.
unset POSTGRES_IMAGE REDIS_IMAGE POSTGRES_PASSWORD REDIS_PASSWORD SESSION_SECRET
install -m 0600 "$TEMPLATE" "$APP_DIR/compose.yaml"
compose=(docker compose --env-file "$CONF_DIR/.env" -f "$APP_DIR/compose.yaml")
"${compose[@]}" config --quiet
# Resolve mutable major tags once. Subsequent installs reuse locked digests.
"${compose[@]}" pull --quiet
locked_env="$(mktemp "$CONF_DIR/.env.locked.XXXXXX")"
trap 'rm -f "$locked_env"' EXIT
cp "$CONF_DIR/.env" "$locked_env"
for component in POSTGRES REDIS; do
    key="${component}_IMAGE"
    image="$(sed -n "s/^${key}=//p" "$CONF_DIR/.env")"
    digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "$image")"
    [[ "$digest" =~ ^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$ ]] || {
        __red "Missing registry digest for $component"; exit 1;
    }
    sed -i "s|^${key}=.*|${key}=${digest}|" "$locked_env"
done
mv "$locked_env" "$CONF_DIR/.env"
"${compose[@]}" config --quiet
"${compose[@]}" up -d --wait --wait-timeout 180
"${compose[@]}" ps
__green 'Dependencies ready; credentials in /home/isp/conf/new-api-deps/.env (root only).'
