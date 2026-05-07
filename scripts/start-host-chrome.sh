#!/usr/bin/env bash
set -euo pipefail

CHROME_APP="${CHROME_APP:-Google Chrome}"
PROFILE_ROOT="${PROFILE_ROOT:-${PWD}/data/chrome-profiles}"

start_chrome() {
  local name="$1"
  local port="$2"
  local profile_dir="${PROFILE_ROOT}/${name}"

  mkdir -p "${profile_dir}"

  open -na "${CHROME_APP}" --args \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="${port}" \
    --user-data-dir="${profile_dir}" \
    --no-first-run \
    --no-default-browser-check \
    --window-size=1920,1080 \
    about:blank

  echo "${name}: http://127.0.0.1:${port}/json/version"
}

start_chrome cnvd-report 9332
start_chrome cnnvd-report 9333
start_chrome ncc-report 9334
