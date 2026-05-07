# OpenCode Skills Service

本项目把本地 OpenCode、DeepSeek Anthropic 兼容模型、本地 skills、Chrome DevTools MCP 封装成一个可通过 API 和前端调用的自动化任务平台。

当前状态：本地 PoC 已跑通，`skills-api`、中文前端、复杂 skill 模板和 Docker Chrome 三路浏览器服务已接入。更完整的实现逻辑见 [progress/整个项目的实现逻辑.md](progress/整个项目的实现逻辑.md)，迁移前验收结果见 [progress/迁移前验收报告.md](progress/迁移前验收报告.md)，服务器迁移方案见 [progress/服务器迁移方案.md](progress/服务器迁移方案.md)。

## 架构

```text
Frontend 4101
  -> skills-api 4100
  -> OpenCode Server 4096
  -> DeepSeek Anthropic-compatible API
  -> /root/.agents/skills
  -> chrome-devtools-mcp
  -> Docker Chrome: browser-cnvd / browser-cnnvd / browser-ncc
```

前端只调用 `skills-api`，不直接调用 OpenCode 内部 API。`skills-api` 负责创建 job、写入输入文件、生成模板 prompt、调用 OpenCode、记录日志并暴露输出文件。

## 目录结构

```text
opencode-skills-service/
  README.md                         # 项目入口、启动和验证说明
  AGENTS.md                         # agent 协作规则和项目约束
  docker-compose.yml                # 本地服务编排
  .env.example                      # 环境变量模板，真实 .env 不提交

  backend/
    server.js                       # skills-api：job API、模板注册、OpenCode 调用
    server.test.js                  # 后端模板和 prompt 单元测试

  frontend/
    index.html                      # 中文任务控制台
    app.js                          # 前端状态、API 调用、轮询、文件上传
    styles.css                      # 前端样式
    server.js                       # 静态文件服务，容器端口 4101

  opencode-server/
    Dockerfile                      # OpenCode 运行镜像，预装 node/curl/python/MCP
    start-opencode.sh               # 根据 .env 渲染 OpenCode 配置并启动服务

  browser-service/
    Dockerfile                      # Docker Chrome 镜像
    start.sh                        # Chromium + nginx DevTools 代理启动脚本

  config/
    opencode.template.json          # OpenCode provider、model、MCP 配置模板

  scripts/
    start-host-chrome.sh            # 宿主机 Chrome fallback 脚本

  progress/
    PROJECT_DEVELOPMENT_PLAN.md     # 项目阶段计划
    PROJECT_PROGRESS.md             # 已完成进展记录
    BACKEND_DEVELOPMENT_PLAN.md     # 后端开发计划
    整个项目的实现逻辑.md             # 当前实现逻辑说明

  data/
    work/                           # job 根目录：输入、输出、日志、job.json
    output/                         # 预留最终输出目录
    input/                          # 预留输入目录
    docker-chrome-profiles/         # Docker Chrome 登录态和缓存，仅 .gitkeep 入库
    chrome-profiles/                # 旧宿主机/兼容 profile，运行数据不提交
```

## 运行数据

不要提交这些内容：

- `.env`
- `data/work/*`
- `data/output/*`
- `data/chrome-profiles/*`
- `data/docker-chrome-profiles/*`
- OpenCode 运行卷里的生成配置、会话状态、日志

每个任务的服务化路径固定为：

```text
/data/work/jobs/{job_id}/input
/data/work/jobs/{job_id}/output
/data/work/jobs/{job_id}/logs
/data/work/jobs/{job_id}/job.json
```

外部调用方不能传入 macOS 绝对路径。所有材料必须上传或写入 job input 目录。

## 首次配置

复制 `.env.example` 到 `.env`，然后填写 DeepSeek API key：

```bash
cp .env.example .env
```

关键配置：

```env
OPENCODE_API_BASE_URL=https://api.deepseek.com/anthropic
OPENCODE_PROVIDER_ID=deepseek-anthropic
OPENCODE_MODEL=deepseek-v4-flash
OPENCODE_MODEL_REASONING=false
OPENCODE_API_KEY=replace-with-your-deepseek-api-key
SKILLS_HOST_DIR=/Users/yao/.claude/skills
```

默认 Docker Chrome 配置：

```env
CHROME_DEVTOOLS_CNVD_HOST=browser-cnvd
CHROME_DEVTOOLS_CNNVD_HOST=browser-cnnvd
CHROME_DEVTOOLS_NCC_HOST=browser-ncc
CHROME_DEVTOOLS_CNVD_PORT=9332
CHROME_DEVTOOLS_CNNVD_PORT=9333
CHROME_DEVTOOLS_NCC_PORT=9334
```

## 启动

启动 OpenCode Server、skills-api、前端和三路 Docker Chrome：

```bash
docker compose --profile docker-browser up -d --build opencode-server skills-api frontend browser-cnvd browser-cnnvd browser-ncc
```

服务地址：

```text
OpenCode Server: http://127.0.0.1:4096
skills-api:      http://127.0.0.1:4100
Frontend:        http://127.0.0.1:4101
CNVD Chrome:     http://127.0.0.1:19332/json/version
CNNVD Chrome:    http://127.0.0.1:19333/json/version
NCC Chrome:      http://127.0.0.1:19334/json/version
```

## 验证

```bash
curl -sS http://127.0.0.1:4096/global/health
curl -sS http://127.0.0.1:4096/mcp
curl -sS http://127.0.0.1:4100/health
curl -sS http://127.0.0.1:19332/json/version
curl -sS http://127.0.0.1:19333/json/version
curl -sS http://127.0.0.1:19334/json/version
```

真实模型调用：

```bash
docker compose exec -T opencode-server sh -lc \
  'cd /data/work && opencode run --model deepseek-anthropic/deepseek-v4-flash "只回复 OK"'
```

本地代码检查：

```bash
docker compose config --quiet
sh -n opencode-server/start-opencode.sh
bash -n browser-service/start.sh
node --check backend/server.js
node --test backend/server.test.js
node --check frontend/server.js
node --check frontend/app.js
git diff --check
git status --short -uall
```

## 任务 API

健康检查会返回服务配置和模板列表：

```bash
curl -sS http://127.0.0.1:4100/health
```

创建任务：

```bash
curl -sS -X POST http://127.0.0.1:4100/jobs \
  -H 'Content-Type: application/json' \
  -d '{"template":"md2wechat","title":"公众号转换测试"}'
```

写入输入文件：

```bash
curl -sS -X POST http://127.0.0.1:4100/jobs/{job_id}/files \
  -H 'Content-Type: application/json' \
  -d '{"filename":"article.md","content":"# 测试标题\n\n测试正文"}'
```

运行模板：

```bash
curl -sS -X POST http://127.0.0.1:4100/jobs/{job_id}/run \
  -H 'Content-Type: application/json' \
  -d '{"template":"md2wechat"}'
```

查看状态、日志和输出：

```bash
curl -sS http://127.0.0.1:4100/jobs/{job_id}
curl -sS http://127.0.0.1:4100/jobs/{job_id}/logs
curl -sS http://127.0.0.1:4100/jobs/{job_id}/outputs
curl -sS http://127.0.0.1:4100/jobs/{job_id}/outputs/{relative_path}
```

## 前端工作流

打开：

```text
http://127.0.0.1:4101
```

最小流程：

1. 选择模板。
2. 创建任务。
3. 上传或粘贴输入材料。
4. 运行任务。
5. 查看任务状态、日志和输出文件。

复杂 skill 模板会显示建议输入、执行模式和输出约定。前端会把材料写入 `/data/work/jobs/{job_id}/input`，然后仍通过 `skills-api` 运行任务。

## 模板

当前后端内置模板：

| 模板 | 用途 | 主要输入 | 主要输出 |
| --- | --- | --- | --- |
| `custom` | 自定义 prompt | 任意 job input 或 prompt | 调用方指定 |
| `md2wechat` | Markdown 转公众号 HTML 和封面图 | `input/article.md` | `wechat-article.html`, `wechat-cover.png` |
| `vulnerability-alert-processor` | 漏洞预警材料生成 | `task.md`, `materials/`, JSON, docx | Markdown, Word, PDF, render context |
| `phase1-material-processor` | 监管上报材料整理 | `materials/` 批次目录和 docx | `processed-materials/`, `summary.txt` |
| `msrc-vulnerability-report` | MSRC 预警报告 | MSRC JSON/CSV 材料包、严重漏洞描述、logo | `report.md`, Word, PDF, preview |
| `cnvd-weekly-db-update` | CNVD 周库更新 | CNVD XML 或更新任务说明 | `summary.txt`, `update-result.json` |
| `phase2-cnvd-report` | CNVD 上报 | CNVD 材料目录 | `form_context.json`, 上报结果 |
| `phase2-cnnvd-report` | CNNVD 上报 | CNNVD 材料目录 | `form_context.json`, 上报结果 |
| `phase2-ncc-report` | NCC 上报 | NCC 材料目录 | `form_context.json`, 上报结果 |

前端只展示 `skills-api /health` 返回的模板，不扫描完整 skills 仓库。服务器可以同步整个 skills Git 仓库，但只有在 `backend/server.js` 注册过的 skill 才会成为前端可选任务。当前已按 `/Users/yao/.claude/skills/README.md` 中的 8 个业务 skill 建立服务化模板。

`md2wechat` 会固定读取：

```text
/data/work/jobs/{job_id}/input/article.md
```

并要求 OpenCode 使用 `md2wechat` skill 脚本写入：

```text
/data/work/jobs/{job_id}/output/wechat-article.html
/data/work/jobs/{job_id}/output/wechat-cover.png
```

## Docker Chrome

Docker Chrome 使用三个独立服务和 profile：

```text
browser-cnvd  -> container 9332 -> host 19332 -> ./data/docker-chrome-profiles/cnvd-report
browser-cnnvd -> container 9333 -> host 19333 -> ./data/docker-chrome-profiles/cnnvd-report
browser-ncc   -> container 9334 -> host 19334 -> ./data/docker-chrome-profiles/ncc-report
```

Chromium 实际监听容器内 `127.0.0.1:9222`。`browser-service/start.sh` 会启动 nginx，把 `0.0.0.0:933x` 代理到 `127.0.0.1:9222`，并改写 Host 头，解决 Chrome DevTools 对 Docker service name 的限制。

容器启动时会清理当前 profile 下的 Chromium `Singleton*` stale lock。每个 profile 只允许对应的一个 browser 服务使用，不要多个浏览器共用同一 profile。

宿主机 Chrome 只作为 fallback：

```bash
./scripts/start-host-chrome.sh
```

## Skills 更新和迁移

本项目不把 skills 代码复制进仓库，默认通过 bind mount 使用外部 skills 目录：

```text
${SKILLS_HOST_DIR} -> /root/.agents/skills:ro
```

本地默认值是：

```env
SKILLS_HOST_DIR=/Users/yao/.claude/skills
```

因此本地 skills 更新后的处理规则是：

- 只改 `SKILL.md`、references 或脚本内容：通常不用重建镜像，新任务会读到 bind mount 里的新文件。
- 改了 OpenCode provider、MCP 或模型配置：重启 `opencode-server`。
- 新增脚本依赖系统包或 Python/Node 依赖：更新 `opencode-server/Dockerfile` 或对应 skill 的依赖安装方式，然后重建镜像。
- 新增一个要服务化的 skill：更新 `backend/server.js` 的模板注册、prompt 约束和测试；前端会从 `/health` 自动读取模板列表。

迁移服务器时推荐把 skills 作为独立同步对象，而不是混进这个服务仓库。服务器可以使用如下目录：

```text
/opt/opencode-skills/skills
```

服务器 `.env` 中设置：

```env
SKILLS_HOST_DIR=/opt/opencode-skills/skills
```

同步方式二选一：

1. 如果 skills 已经是 Git 仓库：服务器上 `git clone` 或 `git pull`，再重启相关服务。
2. 如果 skills 还只是本机目录：用 `rsync` 同步到服务器，排除 `.DS_Store`、运行缓存、浏览器 profile、密钥和临时输出。

每次同步 skills 后，至少验证：

```bash
docker compose exec -T opencode-server sh -lc 'test -f /root/.agents/skills/md2wechat/SKILL.md'
curl -sS http://127.0.0.1:4096/mcp
curl -sS http://127.0.0.1:4100/health
```

## 开发约束

- 不要提交 `.env`、job 输出、Chrome profile、密钥或运行数据。
- 不要让外部请求携带 `/Users/yao/...` 这类 macOS 绝对路径。
- 不要让前端直接依赖 OpenCode 内部 API。
- 修改模板、prompt、job 行为后必须跑 `node --test backend/server.test.js`。
- 修改 Docker 或浏览器链路后必须验证 `/mcp` 和三个 `/json/version`。

## 下一步

服务器迁移前，先用本地 API 和前端完成至少一个真实 skill workflow。当前优先级仍是稳定 `md2wechat` 和复杂上报 skill 的服务化输入/输出约定，再做鉴权、队列、并发控制和日志流。
