FROM debian:bookworm-slim

RUN set -eux; \
    sed -i \
      -e 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' \
      -e 's|http://deb.debian.org/debian-security|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g' \
      /etc/apt/sources.list.d/debian.sources; \
    apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=120 update; \
    apt-get install -y --no-install-recommends \
    chromium \
    curl \
    ca-certificates \
    fonts-wqy-microhei \
    fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 chrome

COPY start.sh /usr/local/bin/start-chrome
RUN chmod +x /usr/local/bin/start-chrome

USER chrome
WORKDIR /home/chrome

CMD ["/usr/local/bin/start-chrome"]
