# OpenCode Skills Service

把 OpenCode、DeepSeek Anthropic 兼容模型、本地 skills 和 Chrome DevTools MCP 封装成可通过 API 和前端调用的自动化任务平台。

```
┌─────────┐  4101   ┌───────────┐  4100   ┌───────────────┐  4096   ┌──────────────────┐
│ Frontend │ ─────→  │ skills-api │ ─────→  │ OpenCode Server │ ───→  │ DeepSeek API     │
│(静态控制台)│ ←─────  │ (job编排)   │ ←─────  │ (执行引擎)      │ ←───  │ (Anthropic兼容)  │
└─────────┘         └───────────┘         └───────┬───────┘        └──────────────────┘
                                                   │
                                          ┌────────┴────────┐
                                          │ /root/.agents/   │
                                          │ skills/{name}/   │
                                          │ chrome-devtools- │
                                          │ mcp              │
                                          └────────┬────────┘
                                                   │
                                          ┌────────┴────────┐
                                          │ Docker Chrome x3 │
                                          │ :9332/9333/9334  │
                                          └─────────────────┘
```

## 目录

```
opencode-skills-service/
├── backend/                 # skills-api: HTTP 路由、模板、prompt、job 管理
│   ├── server.js
│   └── server.test.js
├── frontend/                # 中文任务控制台（纯静态，无构建）
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── server.js
├── opencode-server/         # OpenCode 运行镜像 + 启动脚本
├── browser-service/         # Docker Chrome 镜像 + nginx 代理
├── config/                  # OpenCode 配置模板（.env 渲染）
│   └── opencode.template.json
├── scripts/                 # 本地辅助脚本
├── progress/                # 实现逻辑、问答、迁移方案
├── data/                    # 运行数据（仅 .gitkeep 入库）
│   └── work/jobs/{id}/{input,output,logs,job.json}
├── docker-compose.yml
└── .env.example
```

## 快速开始

```bash
cp .env.example .env            # 填入 OPENCODE_API_KEY
docker compose --profile docker-browser up -d --build
```

| 服务 | 地址 |
|------|------|
| 前端 | http://127.0.0.1:4101 |
| skills-api | http://127.0.0.1:4100/health |
| OpenCode Server | http://127.0.0.1:4096/global/health |
| CNVD Chrome | http://127.0.0.1:19332/json/version |

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 服务状态 + 模板列表 |
| POST | `/jobs` | 创建任务 |
| GET | `/jobs` | 任务列表 |
| POST | `/jobs/{id}/files` | 上传输入文件 |
| POST | `/jobs/{id}/run` | 执行（异步） |
| GET | `/jobs/{id}` | 任务状态 |
| GET | `/jobs/{id}/logs` | 运行日志 |
| GET | `/jobs/{id}/outputs` | 输出文件列表 |
| GET | `/jobs/{id}/outputs/{path}` | 下载输出文件 |

```bash
# 完整流程
curl -X POST http://127.0.0.1:4100/jobs \
  -H 'Content-Type: application/json' \
  -d '{"template":"md2wechat"}'
# → {"id":"job_xxx",...}

curl -X POST http://127.0.0.1:4100/jobs/job_xxx/files \
  -H 'Content-Type: application/json' \
  -d '{"filename":"article.md","content":"# 标题\n\n正文"}'

curl -X POST http://127.0.0.1:4100/jobs/job_xxx/run \
  -H 'Content-Type: application/json' \
  -d '{"template":"md2wechat"}'

# 轮询直到 status=succeeded
curl http://127.0.0.1:4100/jobs/job_xxx
curl http://127.0.0.1:4100/jobs/job_xxx/outputs
```

## 模板

| 模板 | skill | 浏览器 | 用途 |
|------|-------|--------|------|
| `custom` | — | 无 | 自定义 prompt |
| `md2wechat` | md2wechat | 无 | Markdown → 公众号 HTML + 封面 |
| `vulnerability-alert-processor` | vulnerability-alert-processor | 可选 | 漏洞预警材料生成 |
| `phase1-material-processor` | phase1-material-processor | 无 | 监管上报材料整理 |
| `msrc-vulnerability-report` | msrc-vulnerability-report | 无 | MSRC 报告生成 |
| `cnvd-weekly-db-update` | cnvd-weekly-db-update | 无 | CNVD 每周 DB 更新 |
| `phase2-cnvd-report` | phase2-cnvd-report | :9332 | CNVD 漏洞上报 |
| `phase2-cnnvd-report` | phase2-cnnvd-report | :9333 | CNNVD 漏洞上报 |
| `phase2-ncc-report` | phase2-ncc-report | :9334 | NCC 漏洞上报 |

## Docker Chrome

三个独立浏览器服务，同镜像不同 profile：

```
browser-cnvd  → :9332 → data/docker-chrome-profiles/cnvd-report/
browser-cnnvd → :9333 → data/docker-chrome-profiles/cnnvd-report/
browser-ncc   → :9334 → data/docker-chrome-profiles/ncc-report/
```

容器内 nginx 代理解决 WebSocket Host 头校验问题。宿主机 Chrome 作为 fallback：

```bash
./scripts/start-host-chrome.sh
```

## Skills 同步

Skills 不在本项目仓库内，通过 bind mount 注入容器：

```env
SKILLS_HOST_DIR=/Users/yao/.claude/skills  →  /root/.agents/skills:ro
```

| 变更 | 操作 |
|------|------|
| 改 skill 脚本/文档 | 无需重启，下次任务生效 |
| 新增 skill 目录 | 无需重启，需更新后端模板注册 |
| 改依赖 | rebuild opencode-server 镜像 |
| 改 OpenCode/MCP 配置 | 重启 opencode-server |

服务器迁移时将 `SKILLS_HOST_DIR` 改为服务器路径，服务项目与本项目 skills 独立 git pull：

```bash
# 服务项目
git clone https://github.com/yaoruiquan/opencode-skiills-service.git
# skills 仓库
git clone https://github.com/yaoruiquan/vulns_skills.git /opt/opencode-skills/skills
```

## 服务器部署

`10.50.10.29` 已完成试迁移。服务器使用 CentOS 7 + Docker Compose，额外叠加 `docker-compose.server.yml`：

```bash
cd /opt/opencode-skills-service
docker compose -f docker-compose.yml -f docker-compose.server.yml --profile docker-browser up -d --no-build
```

服务器 `.env` 放在 `/etc/opencode-skills/.env`，项目根目录 `.env` 是软链。当前服务器基础镜像使用：

```env
OPENCODE_IMAGE=node:22-bookworm-slim
SKILLS_HOST_DIR=/opt/opencode-skills/skills
```

这样可以在服务器本地构建 amd64 镜像，并绕过 `ghcr.io` blob 下载不稳定问题。服务地址：

| 服务 | 地址 |
|------|------|
| 前端 | http://10.50.10.29:4101 |
| skills-api | http://10.50.10.29:4100/health |
| OpenCode Server | 仅服务器本机 `127.0.0.1:4096` |
| Docker Chrome | 仅服务器本机 `127.0.0.1:19332/19333/19334` |

服务器已验证：

```bash
curl -sS http://127.0.0.1:4096/global/health
curl -sS http://127.0.0.1:4096/mcp
curl -sS http://127.0.0.1:4100/health
```

## 开发约束

- 不提交 `.env`、Chrome profile、job 输出、密钥
- 不传 macOS 绝对路径（`/Users/yao/...`）
- 前端不直接调 OpenCode Server
- 改模板/浏览器链路后跑 `node --test backend/server.test.js`
