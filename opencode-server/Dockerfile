ARG OPENCODE_IMAGE=ghcr.io/anomalyco/opencode:latest
FROM ${OPENCODE_IMAGE}
ARG OPENCODE_VERSION=1.14.40

USER root

RUN set -eux; \
  if command -v apt-get >/dev/null 2>&1; then \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i \
        -e 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' \
        -e 's|http://deb.debian.org/debian-security|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g' \
        /etc/apt/sources.list.d/debian.sources; \
    fi; \
    apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=120 update; \
    apt-get install -y --no-install-recommends \
      bash \
      curl \
      ca-certificates \
      nodejs \
      npm \
      python3 \
      python3-pip \
      python3-venv \
      zip \
      unzip; \
    rm -rf /var/lib/apt/lists/*; \
  elif command -v apk >/dev/null 2>&1; then \
    apk add --no-cache \
      bash \
      curl \
      ca-certificates \
      nodejs \
      npm \
      python3 \
      py3-pip \
      py3-pillow \
      zip \
      unzip; \
  else \
    echo "Unsupported base image: no apt-get or apk found" >&2; \
    exit 1; \
  fi

RUN python3 -m pip install --break-system-packages --no-cache-dir python-dotenv || \
    python3 -m pip install --no-cache-dir python-dotenv || \
    echo "Optional Python dependencies were not installed; install them later if skills need them."

RUN npm config set registry https://registry.npmmirror.com && \
    if ! command -v opencode >/dev/null 2>&1; then \
      npm install -g opencode-ai@${OPENCODE_VERSION} \
        --fetch-retries=5 \
        --fetch-retry-mintimeout=20000 \
        --fetch-retry-maxtimeout=120000; \
    fi && \
    npm install -g chrome-devtools-mcp@0.25.0 \
      --fetch-retries=5 \
      --fetch-retry-mintimeout=20000 \
      --fetch-retry-maxtimeout=120000

COPY start-opencode.sh /usr/local/bin/start-opencode.sh
RUN chmod +x /usr/local/bin/start-opencode.sh
