#!/usr/bin/env bash
set -euo pipefail

PORT="${CHROME_REMOTE_DEBUGGING_PORT:-9332}"
INTERNAL_PORT="${CHROME_INTERNAL_DEBUGGING_PORT:-9222}"
PROFILE_DIR="${CHROME_PROFILE_DIR:-/home/chrome/profile}"
BOOTSTRAP_URL="${CHROME_BOOTSTRAP_URL:-about:blank}"
EXTERNAL_HOSTNAME="${CHROME_EXTERNAL_HOSTNAME:-localhost}"

if [ "${1:-}" != "--as-chrome" ] && [ "$(id -u)" = "0" ]; then
  mkdir -p "${PROFILE_DIR}"
  chown -R chrome:chrome "${PROFILE_DIR}"
  chmod 700 "${PROFILE_DIR}" || true
  exec su -s /bin/bash chrome -c 'exec /usr/local/bin/start-chrome --as-chrome'
fi

mkdir -p "${PROFILE_DIR}"
chmod 700 "${PROFILE_DIR}" || true

# Docker browser profiles are single-writer; stale Chromium locks can survive
# container replacement and block the next start.
rm -f "${PROFILE_DIR}"/Singleton* || true

if [ ! -f "${PROFILE_DIR}/.opencode-profile-info" ]; then
  {
    echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "remote_debugging_port=${PORT}"
    echo "internal_debugging_port=${INTERNAL_PORT}"
    echo "profile_dir=${PROFILE_DIR}"
  } > "${PROFILE_DIR}/.opencode-profile-info"
fi

cat > /tmp/nginx-chrome-devtools.conf <<EOF
pid /tmp/nginx-chrome-devtools.pid;
error_log /tmp/nginx-chrome-devtools-error.log warn;

events {
  worker_connections 64;
}

http {
  access_log off;
  client_body_temp_path /tmp/nginx-client-body;
  proxy_temp_path /tmp/nginx-proxy;
  fastcgi_temp_path /tmp/nginx-fastcgi;
  uwsgi_temp_path /tmp/nginx-uwsgi;
  scgi_temp_path /tmp/nginx-scgi;

  map \$http_upgrade \$connection_upgrade {
    default upgrade;
    '' close;
  }

  server {
    listen 0.0.0.0:${PORT};

    location / {
      proxy_pass http://127.0.0.1:${INTERNAL_PORT};
      proxy_http_version 1.1;
      proxy_set_header Host 127.0.0.1:${INTERNAL_PORT};
      proxy_set_header Origin http://${EXTERNAL_HOSTNAME}:${PORT};
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection \$connection_upgrade;
      proxy_set_header Accept-Encoding "";
      sub_filter 'ws://127.0.0.1:${INTERNAL_PORT}' 'ws://${EXTERNAL_HOSTNAME}:${PORT}';
      sub_filter_once off;
      sub_filter_types application/json;
    }
  }
}
EOF

/usr/sbin/nginx -c /tmp/nginx-chrome-devtools.conf -g 'daemon off;' &

exec chromium \
  --headless=new \
  --no-first-run \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="${INTERNAL_PORT}" \
  --remote-allow-origins="http://${EXTERNAL_HOSTNAME}:${PORT}" \
  --user-data-dir="${PROFILE_DIR}" \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --disable-background-networking \
  --disable-crash-reporter \
  --disable-crashpad \
  --disable-default-apps \
  --disable-extensions \
  --disable-sync \
  --password-store=basic \
  --use-mock-keychain \
  --window-size=1920,1080 \
  "${BOOTSTRAP_URL}"
