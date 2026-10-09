#!/usr/bin/env bash
# Deploys this working tree to the Minecraft PC over SSH.
#
#   windows/deploy-to-mc-pc.sh            # sync, npm ci, build client, restart
#   windows/deploy-to-mc-pc.sh --no-build # sync and restart only
#
# Remote .env, node_modules, server/, backups/ and manager-data/ are never touched.
set -euo pipefail

SSH_HOST="${MC_PC_HOST:-mc-pc}"
REMOTE_ROOT="${MC_PC_ROOT:-E:/MC PC - Sandbox}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD=1
SKIP_CLIENT_INSTALL=""

for arg in "$@"; do
    case "$arg" in
        --no-build) BUILD=0 ;;
        --skip-client-install) SKIP_CLIENT_INSTALL="-SkipClientInstall" ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

remote_ps() {
    ssh -o BatchMode=yes "$SSH_HOST" \
        "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"$REMOTE_ROOT/tray/remote-deploy.ps1\" $*" \
        2> >(grep -v -E 'post-quantum|store now, decrypt later|openssh.com/pq.html' >&2)
}

sync_files() {
    local source_dir="$1" target_dir="$2"
    shift 2
    (cd "$source_dir" && tar -cf - "$@") |
        ssh -o BatchMode=yes "$SSH_HOST" "tar -xf - -C \"$target_dir\"" \
        2> >(grep -v -E 'post-quantum|store now, decrypt later|openssh.com/pq.html' >&2)
}

cd "$REPO_ROOT"

echo "==> Syncing tray controller"
mapfile -t tray_files < <(cd windows/tray && git ls-files -co --exclude-standard)
sync_files windows/tray "$REMOTE_ROOT/tray" "${tray_files[@]}"
sync_files windows "$REMOTE_ROOT" WINDOWS_SETUP.md

echo "==> Stopping manager and tray"
remote_ps -Action Stop

echo "==> Syncing manager"
mapfile -t app_files < <(git ls-files -co --exclude-standard | grep -v -E '^(windows/|\.env$)')
sync_files . "$REMOTE_ROOT/mc-manager" "${app_files[@]}"

if [[ "$BUILD" == 1 ]]; then
    echo "==> Installing dependencies and building client"
    remote_ps -Action Build $SKIP_CLIENT_INSTALL
fi

echo "==> Starting tray and manager"
remote_ps -Action Start
