# OpenCode Skills Service 本地 Docker PoC

本项目用于在本地 Docker 中验证 OpenCode + skills + Chrome DevTools MCP 的服务化链路。

## 目录映射

- `../vulns` -> `/data/input`，只读漏洞材料目录
- `./data/work` -> `/data/work`，任务中间文件
- `./data/output` -> `/data/output`，最终输出文件
- `/Users/yao/.claude/skills` -> `/root/.agents/skills`，只读 skills 目录
- `./config/opencode.template.json` -> `/opt/opencode/templates/opencode.template.json`，OpenCode 配置模板
- `opencode-config` -> `/root/.config/opencode`，OpenCode 运行配置卷。容器启动时会根据 `.env` 生成 `opencode.json`。
- `./data/chrome-profiles/*`，宿主机或容器内 Chrome 登录态

## 首次配置

项目已提供 `.env`，默认使用 DeepSeek Anthropic 兼容接口和 `deepseek-v4-flash`：

```env
OPENCODE_API_BASE_URL=https://api.deepseek.com/anthropic
OPENCODE_PROVIDER_ID=deepseek-anthropic
OPENCODE_MODEL=deepseek-v4-flash
OPENCODE_MODEL_REASONING=false
```

只需要编辑 `.env`，把 `OPENCODE_API_KEY` 改成你的 DeepSeek API key：

```env
OPENCODE_API_KEY=replace-with-your-deepseek-api-key
```

Chrome DevTools 在容器内访问 `host.docker.internal` 时会触发 Host 头限制，本地 macOS Docker Desktop PoC 里使用宿主机网关 IP：

```text
http://192.168.65.254:9332
http://192.168.65.254:9333
http://192.168.65.254:9334
```

## 启动

先启动宿主机 Chrome 调试口：

```bash
./scripts/start-host-chrome.sh
```

再启动 OpenCode Server 容器：

```bash
docker compose up -d --build opencode-server
```

## 基础验证

```bash
curl http://127.0.0.1:4096/global/health
curl http://127.0.0.1:9332/json/version
curl http://127.0.0.1:9333/json/version
curl http://127.0.0.1:9334/json/version
curl -X POST 'http://127.0.0.1:4096/session?directory=/data/work' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

真实模型调用验证：

```bash
docker compose exec -T opencode-server sh -lc \
  'cd /data/work && opencode run --model deepseek-anthropic/deepseek-v4-flash "只回复 OK"'
```

Web UI:

```text
http://127.0.0.1:4096/app?directory=/data/work
```

## 任务 API

启动任务 API：

```bash
docker compose up -d --build opencode-server skills-api
```

API 地址：

```text
http://127.0.0.1:4100
```

健康检查：

```bash
curl http://127.0.0.1:4100/health
```

创建任务：

```bash
curl -sS -X POST http://127.0.0.1:4100/jobs \
  -H 'Content-Type: application/json' \
  -d '{"type":"md2wechat","title":"测试任务"}'
```

写入输入文件：

```bash
curl -sS -X POST http://127.0.0.1:4100/jobs/{job_id}/files \
  -H 'Content-Type: application/json' \
  -d '{"filename":"article.md","content":"# 测试标题\n\n测试正文"}'
```

启动任务：

```bash
curl -sS -X POST http://127.0.0.1:4100/jobs/{job_id}/run \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"读取 /data/work/jobs/{job_id}/input/article.md，生成一个简短摘要并写入 /data/work/jobs/{job_id}/output/summary.txt"}'
```

查看任务、日志和输出：

```bash
curl http://127.0.0.1:4100/jobs/{job_id}
curl http://127.0.0.1:4100/jobs/{job_id}/logs
curl http://127.0.0.1:4100/jobs/{job_id}/outputs
```

任务 API 会把所有输入和输出限制在：

```text
/data/work/jobs/{job_id}
```

如果 DeepSeek 返回 `Selected model is at capacity`，API 会自动重试一次，并按配置尝试备用模型：

```env
OPENCODE_FALLBACK_MODELS=deepseek-anthropic/deepseek-v4-pro
OPENCODE_CAPACITY_RETRIES=1
OPENCODE_CAPACITY_RETRY_DELAY_MS=5000
```

默认 PoC 使用宿主机 Chrome 调试口，并让容器通过 Docker Desktop 宿主机网关 IP 访问。

当前 OpenCode Server 镜像基于官方 `ghcr.io/anomalyco/opencode:latest`，额外安装 `node/npm/curl/python`，并预装 `chrome-devtools-mcp@0.25.0`，避免运行时每次通过 `npx @latest` 拉包。

Docker 内 Chrome 容器已经保留在 `docker-browser` profile 中，后续网络稳定后再启用：

```bash
docker compose --profile docker-browser up -d --build
```

## 下一步验证顺序

1. 先确认 OpenCode Server 健康检查可用。
2. 再确认三个 Chrome DevTools 端口都可用。
3. 再用 OpenCode API 创建 session，跑一个不依赖浏览器的 skill。
4. 最后验证 `phase2-cnvd-report` 这类浏览器上报 skill。
