#!/bin/bash
# Install Docker Engine/Compose from an explicitly chosen signed repository.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
check_root
detect_os

if command -v docker >/dev/null 2>&1; then
    # Never replace/restart an existing engine or rewrite daemon configuration.
    docker info >/dev/null
    docker compose version
    __green "Existing Docker Engine and Compose are usable; left unchanged."
    exit 0
fi
[[ "$OS" == ubuntu ]] || { __red 'Docker installer currently supports Ubuntu only.'; exit 1; }
. /etc/os-release
case "${VERSION_CODENAME:-}" in
    jammy|noble|resolute|stonking) ;;
    *) __red "Unsupported Ubuntu codename: ${VERSION_CODENAME:-unknown}"; exit 1 ;;
esac
# Do not silently uninstall another container runtime, potentially disrupting workloads.
for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -qx 'install ok installed'; then
        __red "Conflicting package $package is installed; manual review required."
        exit 1
    fi
done
export DEBIAN_FRONTEND=noninteractive
# Explicit distro channel for hosts unable to reach Docker's repository.
# It still installs a host container engine; PostgreSQL/Redis remain containers.
case "${DOCKER_PACKAGE_SOURCE:-docker}" in
    ubuntu)
        pkg_update
        pkg_install docker.io docker-compose-v2 docker-buildx
        service_enable docker
        service_start docker
        docker info >/dev/null
        docker compose version
        __green 'Docker installed from signed Ubuntu repositories; daemon settings unchanged.'
        exit 0
        ;;
    docker) ;;
    *) __red 'DOCKER_PACKAGE_SOURCE must be docker or ubuntu.'; exit 1 ;;
esac
pkg_update
pkg_install ca-certificates curl gnupg
install -d -m 0755 /etc/apt/keyrings
key_file="$(mktemp)"
trap 'rm -f "$key_file"' EXIT
curl --fail --silent --show-error --location --retry 3 --retry-all-errors --connect-timeout 15 --max-time 120 \
    https://download.docker.com/linux/ubuntu/gpg -o "$key_file"
fingerprint="$(gpg --batch --show-keys --with-colons "$key_file" | awk -F: '$1=="fpr" {print $10; exit}')"
[[ "$fingerprint" == 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ]] || {
    __red 'Docker signing key fingerprint mismatch.'; exit 1;
}
install -m 0644 "$key_file" /etc/apt/keyrings/docker.asc
repository=/etc/apt/sources.list.d/isp-docker.sources
repository_candidate="$(mktemp)"
trap 'rm -f "$key_file" "$repository_candidate"' EXIT
cat > "$repository_candidate" <<REPO
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
REPO
if [[ -e "$repository" ]] && ! cmp -s "$repository_candidate" "$repository"; then
    __red "$repository differs; manual review required."; exit 1
fi
install -m 0644 "$repository_candidate" "$repository"
pkg_update
pkg_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
service_enable docker
service_start docker
docker info >/dev/null
docker compose version
__green 'Docker installed. No users added to docker group; daemon settings unchanged.'
