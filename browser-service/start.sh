#!/usr/bin/env bash
set -euo pipefail

PORT="${CHROME_REMOTE_DEBUGGING_PORT:-9332}"
PROFILE_DIR="${CHROME_PROFILE_DIR:-/home/chrome/profile}"

mkdir -p "${PROFILE_DIR}"

exec chromium \
  --headless=new \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port="${PORT}" \
  --user-data-dir="${PROFILE_DIR}" \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --disable-default-apps \
  --disable-extensions \
  --disable-sync \
  --window-size=1920,1080 \
  about:blank
