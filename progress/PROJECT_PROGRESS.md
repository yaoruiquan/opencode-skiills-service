# OpenCode Skills Service 项目进展

更新时间：2026-05-07

## 项目目标

把本地已有的 agent skills 封装成一个可服务化运行的 OpenCode 环境，先在本地 Docker 跑通，再为后续迁移到服务器、接前端或 API 调用做准备。

当前 PoC 的核心链路是：

```text
Web UI / API
  -> OpenCode Server Docker
  -> DeepSeek v4 flash
  -> 本地 skills
  -> Chrome DevTools MCP
  -> 宿主机 Chrome 调试实例
```

## 已完成内容

### 1. 本地 Docker 项目骨架

项目目录：

```text
/Users/yao/LLM/opencode-skills-service
```

已建立的主要文件：

- `docker-compose.yml`：编排 OpenCode Server、可选 Docker Chrome 浏览器服务、数据卷和端口映射。
- `opencode-server/Dockerfile`：基于官方 OpenCode 镜像构建自定义运行时。
- `opencode-server/start-opencode.sh`：容器启动时根据 `.env` 渲染 OpenCode 配置。
- `config/opencode.template.json`：OpenCode 配置模板。
- `.env.example`：环境变量模板。
- `README.md`：启动、配置和验证说明。

### 2. OpenCode Server 容器

当前 OpenCode Server 使用自定义镜像：

```text
opencode-skills-service-opencode:local
```

基于：

```text
ghcr.io/anomalyco/opencode:latest
```

额外补充了运行时依赖：

- `node`
- `npm`
- `curl`
- `python3`
- `python-dotenv`
- `chrome-devtools-mcp@0.25.0`

这样可以避免官方镜像中没有 `node/npx` 导致本地 MCP 无法启动的问题。

### 3. DeepSeek 模型配置

已将模型配置改成 `.env` 驱动，避免把 API key 写死到项目配置文件里。

当前默认模型：

```text
deepseek-v4-flash
```

当前默认接口：

```text
https://api.deepseek.com/anthropic
```

容器启动时会读取 `.env`，生成运行时配置：

```text
/root/.config/opencode/opencode.json
```

生成后的配置放在 Docker volume `opencode-config`，不会写回项目目录。

### 4. Skills 挂载

当前将本机 skills 只读挂载到容器内：

```text
/Users/yao/.claude/skills -> /root/.agents/skills
```

已确认 `md2wechat` skill 在容器内可见：

```text
/root/.agents/skills/md2wechat/SKILL.md
```

OpenCode 启动后识别到的 skills 数量：

```text
43
```

当前配置允许的重点 skills：

- `md2wechat`
- `vulnerability-alert-processor`
- `phase1-material-processor`
- `phase2-cnvd-report`
- `phase2-cnnvd-report`
- `phase2-ncc-report`

### 5. Chrome DevTools MCP

已预装：

```text
chrome-devtools-mcp@0.25.0
```

MCP 配置了三个浏览器通道：

- `chrome-devtools-cnvd`
- `chrome-devtools-cnnvd`
- `chrome-devtools-ncc`

宿主机 Chrome 调试端口：

- `9332`
- `9333`
- `9334`

本地 macOS Docker Desktop 中，容器访问宿主机 Chrome 使用网关 IP：

```text
192.168.65.254
```

已经解决的问题：

- `host.docker.internal` 访问 Chrome DevTools 返回 500。
- 改用 `192.168.65.254` 后 `/json/version` 正常。
- OpenCode 启动 MCP 时找不到 `chrome-devtools-mcp`。
- 改成绝对路径 `/usr/local/bin/chrome-devtools-mcp` 后，MCP 状态变为 connected。

当前 MCP 状态：

```json
{
  "chrome-devtools-cnvd": {"status": "connected"},
  "chrome-devtools-cnnvd": {"status": "connected"},
  "chrome-devtools-ncc": {"status": "connected"}
}
```

### 6. OpenCode API / Web UI

服务地址：

```text
http://127.0.0.1:4096
```

Web UI：

```text
http://127.0.0.1:4096/app?directory=/data/work
```

已验证接口：

- `/global/health`
- `/session`
- `/provider`
- `/mcp`

健康检查结果：

```json
{"healthy": true, "version": "1.14.40"}
```

### 7. 真实模型调用验证

已在容器中完成真实模型调用：

```bash
docker compose exec -T opencode-server sh -lc \
  'cd /data/work && opencode run --model deepseek-anthropic/deepseek-v4-flash "只回复 OK"'
```

返回结果：

```text
OK
```

这说明以下链路已经打通：

```text
Docker OpenCode -> .env API key -> DeepSeek Anthropic API -> deepseek-v4-flash -> OpenCode run
```

## 当前项目状态

已经完成本地 PoC 的主链路：

- Docker 服务能启动。
- OpenCode Server 可访问。
- DeepSeek v4 flash 模型调用成功。
- 本地 skills 可被容器读取。
- Chrome DevTools MCP 三路连接成功。
- Web UI 可访问。
- API 可创建和读取 session。

当前还不是生产部署形态，但已经具备后续服务化开发的基础。

## 尚未完成内容

### 1. 真实 skill 工作流验证

还需要跑一次真实业务任务，例如：

- `md2wechat` 最小 Markdown 转 HTML。
- `vulnerability-alert-processor` 生成一次预警材料。
- `phase2-cnvd-report` 通过 Chrome MCP 操作一次测试页面或平台流程。

### 2. 前端/API 封装

当前直接使用 OpenCode Web UI 和 OpenCode API。

后续如果要做自己的前端，建议增加一个轻量后端层：

```text
前端 -> 自定义 Backend API -> OpenCode Server API
```

这个后端负责：

- 创建 session。
- 发送任务。
- 读取事件流。
- 管理输出文件。
- 隐藏 OpenCode 内部 API 细节。

### 3. 服务器迁移

本地 PoC 依赖 macOS 宿主机 Chrome 和 Docker Desktop 网关 IP `192.168.65.254`。

迁移服务器时需要调整：

- Chrome 运行方式。
- DevTools 地址。
- 文件挂载路径。
- skills 来源。
- API key 注入方式。
- 是否使用 Docker 内 Chrome。

### 4. Docker 内 Chrome

项目中保留了 `docker-browser` profile，但因为浏览器镜像构建依赖较多，之前受网络下载影响，当前默认仍使用宿主机 Chrome。

后续服务器化时可以继续推进：

```bash
docker compose --profile docker-browser up -d --build
```

### 5. 安全和多用户

当前按本地 PoC 处理，暂时没有做：

- 用户登录。
- 权限隔离。
- session 隔离。
- API 鉴权。
- 审计日志。
- 输出目录隔离。

后续如果对外提供服务，需要补齐这些能力。

## 下一步建议

1. 用 Web UI 跑一次 `md2wechat` 最小任务，确认 skill 调用链路。
2. 固化一个“任务输入目录 -> 任务执行 -> 输出目录”的 API 协议。
3. 写一个简单 backend wrapper，对接 OpenCode session API。
4. 再考虑迁移服务器和 Docker 内 Chrome。
