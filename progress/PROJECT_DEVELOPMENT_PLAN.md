# OpenCode Skills Service 项目开发计划

更新时间：2026-05-07

状态：本地 PoC 已打通，进入 workflow 产品化阶段。

## 1. 项目定位

本项目的目标是把本地 OpenCode + agent skills 封装成一个可服务化调用的自动化任务平台。平台对外提供稳定的任务 API，内部负责任务目录、输入输出、日志、OpenCode 调用、模型配置、浏览器 MCP 和真实 skill 执行。

当前阶段不是重新验证 OpenCode 是否可运行，而是在已经打通的本地 Docker PoC 上，把真实业务 workflow 固化成可重复调用的服务能力。

近期优先级：

1. 先跑通 `md2wechat` 真实 workflow 模板。
2. 再在 `skills-api` 上扩展任务模板系统。
3. 然后做最小可用前端。
4. 本地至少完成一个真实 skill workflow 后，再考虑 Docker Chrome 和服务器迁移。

## 2. 当前已完成能力

### 2.1 OpenCode Docker PoC

已完成 `opencode-server` Docker 服务，当前服务地址：

```text
http://127.0.0.1:4096
```

运行时使用自定义本地镜像：

```text
opencode-skills-service-opencode:local
```

镜像基于官方 OpenCode 镜像，并额外安装了：

- `node`
- `npm`
- `curl`
- `python3`
- `python-dotenv`
- `chrome-devtools-mcp@0.25.0`

### 2.2 DeepSeek 配置

已完成 DeepSeek Anthropic 兼容接口配置。

当前默认 provider 和模型：

```text
deepseek-anthropic/deepseek-v4-flash
```

当前备用模型：

```text
deepseek-anthropic/deepseek-v4-pro
```

配置从 `.env` 渲染到 Docker volume `opencode-config` 内的运行时配置，不写回仓库。DeepSeek flash 任务保持：

```text
OPENCODE_MODEL_REASONING=false
```

已通过真实模型调用验证：

```bash
docker compose exec -T opencode-server sh -lc \
  'cd /data/work && opencode run --model deepseek-anthropic/deepseek-v4-flash "只回复 OK"'
```

### 2.3 skills-api 任务服务层

已完成 `skills-api` v0，当前服务地址：

```text
http://127.0.0.1:4100
```

当前能力：

- 创建 job。
- 列出 job。
- 查询 job。
- 写入输入文件。
- 异步调用 OpenCode Server。
- 查询运行日志。
- 列出输出文件。
- 下载输出文件。
- 遇到 DeepSeek capacity 错误时重试，并尝试备用模型。

已完成一次 API smoke test：

1. 创建 job。
2. 写入 `input/article.md`。
3. 通过 `/run` 调用 OpenCode。
4. OpenCode 读取输入并写入 `output/summary.txt`。
5. 通过 API 成功读取输出文件。

### 2.4 Chrome DevTools MCP

已完成三路 Chrome DevTools MCP 连接：

```text
chrome-devtools-cnvd
chrome-devtools-cnnvd
chrome-devtools-ncc
```

本地 macOS Docker Desktop 当前通过宿主机网关访问 Chrome DevTools：

```text
http://192.168.65.254:9332
http://192.168.65.254:9333
http://192.168.65.254:9334
```

当前 MCP 已验证为 connected。服务器迁移时必须替换这组 macOS Docker Desktop 专用地址。

### 2.5 Job 目录规范

所有服务化任务统一使用：

```text
/data/work/jobs/{job_id}/input
/data/work/jobs/{job_id}/output
/data/work/jobs/{job_id}/logs
/data/work/jobs/{job_id}/job.json
```

外部调用方不能把 macOS 绝对路径直接传给 skill 或 prompt。需要处理的本地文件必须先上传或复制到 job input 目录。

## 3. 总体架构

### 3.1 当前本地架构

```text
Client
  -> skills-api
  -> OpenCode Server
  -> DeepSeek
  -> local skills
  -> Chrome DevTools MCP
  -> Host Chrome
```

当前本地架构的重点是快速验证真实 skill workflow。Host Chrome 只作为本地 PoC 依赖，不作为目标服务器形态。

### 3.2 目标服务器架构

```text
Frontend
  -> skills-api
  -> OpenCode Server
  -> DeepSeek
  -> skills
  -> Docker Chrome
```

前端只调用 `skills-api`，不直接依赖 OpenCode 内部 API。OpenCode Server、模型 provider、MCP、skills 路径和浏览器细节都应由服务层封装。

## 4. 阶段开发计划

## Phase 1：`md2wechat` workflow 模板

目标：把 `md2wechat` 从可见 skill 变成可通过 API 稳定触发的真实 workflow。

开发内容：

- 在 `/jobs` 或 `/jobs/{job_id}/run` 中支持 `template=md2wechat`。
- 固定输入文件约定为 `input/article.md`。
- 固定输出目录为 `output/`。
- 固定产物至少包括公众号 HTML。
- 如 skill 生成封面图、日志或预览文件，也必须写入 `output/` 或 `logs/`。
- 后端生成默认 prompt，调用方不需要手写 macOS 路径或完整 prompt。
- 保留 `custom` 模式，便于临时验证。

建议接口示例：

```json
{
  "template": "md2wechat"
}
```

验收命令：

```bash
curl -sS -X POST http://127.0.0.1:4100/jobs \
  -H 'Content-Type: application/json' \
  -d '{"type":"md2wechat","title":"md2wechat smoke"}'
```

```bash
curl -sS -X POST http://127.0.0.1:4100/jobs/{job_id}/files \
  -H 'Content-Type: application/json' \
  -d '{"filename":"article.md","content":"# 测试标题\n\n测试正文"}'
```

```bash
curl -sS -X POST http://127.0.0.1:4100/jobs/{job_id}/run \
  -H 'Content-Type: application/json' \
  -d '{"template":"md2wechat"}'
```

```bash
curl -sS http://127.0.0.1:4100/jobs/{job_id}
curl -sS http://127.0.0.1:4100/jobs/{job_id}/logs
curl -sS http://127.0.0.1:4100/jobs/{job_id}/outputs
```

验收标准：

- job 最终状态为 `succeeded`。
- `output/` 中存在公众号 HTML 文件。
- 所有输入输出均位于 `/data/work/jobs/{job_id}` 下。
- API 调用方不需要提供宿主机绝对路径。

## Phase 2：任务模板系统

目标：把一次性的 `md2wechat` 默认 prompt 固化为后端模板注册表。

开发内容：

- 在后端新增内置模板注册表。
- 支持 `custom` 和 `md2wechat`。
- 每个模板声明输入文件、输出约定、默认 prompt、允许的选项和验收检查。
- 为后续复杂 skills 预留扩展接口。

预留模板：

- `vulnerability-alert-processor`
- `phase1-material-processor`
- `phase2-cnvd-report`
- `phase2-cnnvd-report`
- `phase2-ncc-report`
- `msrc-vulnerability-report`

验收命令：

```bash
node --check backend/server.js
curl -sS http://127.0.0.1:4100/health
```

验收标准：

- `custom` 旧调用方式仍可用。
- `md2wechat` 可不传 prompt 直接执行。
- 未知模板返回明确的 400 错误。
- 模板不能绕过 job root 路径限制。

## Phase 3：最小前端

目标：提供可操作的任务 Dashboard，让用户不写 curl 也能完成一次 job。

开发内容：

- Job 创建表单。
- 模板选择。
- Markdown 上传或粘贴。
- 运行任务按钮。
- 状态显示。
- 日志查看。
- 输出文件列表和下载链接。

前端必须调用 `skills-api`，不能直接调用 OpenCode Server。

验收标准：

- 从 UI 创建一次 `md2wechat` job。
- 从 UI 写入或上传 `article.md`。
- 从 UI 启动任务。
- UI 能显示任务状态、日志和输出文件。
- 浏览器刷新后仍可查询已有 job。

建议本地验证：

```bash
docker compose up -d --build opencode-server skills-api
curl -sS http://127.0.0.1:4100/health
```

如果前端需要独立 dev server，启动后记录本地访问地址。

## Phase 4：复杂 skill 接入

目标：在 `md2wechat` 模板稳定后，逐步接入更复杂的业务 skills。

优先级：

1. `vulnerability-alert-processor`
2. `phase1-material-processor`
3. `phase2-cnvd-report`
4. `phase2-cnnvd-report`
5. `phase2-ncc-report`

开发原则：

- 每个 skill 独立模板化。
- 每个模板先定义输入目录、输出目录和日志规则。
- 浏览器类 skill 必须明确使用哪一路 Chrome MCP。
- 不允许模板要求外部调用方传入 macOS 绝对路径。
- 每接入一个 skill，都要有独立 smoke test。

验收标准：

- 每个模板至少完成一次本地端到端运行。
- job metadata 记录模型、尝试次数、退出码、stdout、stderr 和输出文件。
- 失败时 API 能返回可诊断日志。

## Phase 5：Docker Chrome

目标：从宿主机 Chrome 调试口切换到 Docker Chrome，消除 macOS Docker Desktop 专用依赖。

开发内容：

- 启用并稳定 `docker-browser` profile。
- 替换 `192.168.65.254` 为 Docker service name 或容器内可解析地址。
- 固化 Chrome profile 初始化流程。
- 明确不同平台和任务的 profile 隔离策略。
- 验证 `chrome-devtools-mcp` 能稳定连接 Docker Chrome。

验收命令：

```bash
docker compose --profile docker-browser up -d --build
curl -sS http://127.0.0.1:4096/mcp
```

验收标准：

- MCP 状态为 connected。
- 至少一个浏览器类 skill 可使用 Docker Chrome 完成测试流程。
- 不再依赖 `192.168.65.254`。

## Phase 6：服务器迁移

目标：在本地真实 workflow 验证完成后，把服务迁移到 Ubuntu 服务器。

最低环境：

- Ubuntu 22.04 或 24.04。
- Docker 和 Docker Compose。
- 4 CPU cores minimum。
- 8 GB RAM minimum，16 GB recommended。
- 100 GB disk recommended。
- 能访问 DeepSeek API 和必要软件源。

迁移内容：

- 部署 `opencode-server` 和 `skills-api`。
- 同步 skills 到服务器。
- 规范服务器数据目录。
- 使用 Docker Chrome 或服务器本地受控 Chrome。
- 配置 `.env`，不把密钥写入仓库。
- 增加 Nginx、端口策略、健康检查和 restart policy。

迁移前置条件：

- 本地 `md2wechat` workflow 已通过 API 生成 HTML。
- 至少一个真实业务 skill workflow 已完成端到端验证。
- 所有模板都不依赖 macOS 绝对路径。
- Chrome 方案已经从本地 PoC 依赖中抽象出来。

验收标准：

- 服务器上 `GET /health` 正常。
- OpenCode Server health 正常。
- 模型调用正常。
- 至少一个真实 skill workflow 在服务器上执行成功。

## Phase 7：生产化增强

目标：在服务形态稳定后补齐对外使用所需的可靠性和安全能力。

候选内容：

- 登录鉴权。
- API token。
- 任务队列。
- 并发限制。
- SSE 或日志流。
- 任务取消。
- 输出文件清理策略。
- 审计日志。
- 监控和告警。
- 失败重试策略。
- 模型 fallback 策略可配置化。

这些能力不阻塞当前本地 workflow 产品化。不要在真实 workflow 跑通前提前扩大系统复杂度。

## 5. API 规划

### 5.1 当前 v0 API

当前 `skills-api` 已提供：

```text
GET  /health
POST /jobs
GET  /jobs
GET  /jobs/{job_id}
POST /jobs/{job_id}/files
POST /jobs/{job_id}/run
GET  /jobs/{job_id}/logs
GET  /jobs/{job_id}/outputs
GET  /jobs/{job_id}/outputs/{relative_path}
```

这些接口是未来前端的集成边界。前端不直接调用 OpenCode 内部 API。

### 5.2 下一步新增模板调用

下一步在 `/jobs/{job_id}/run` 中支持：

```json
{
  "template": "md2wechat"
}
```

也可以在创建任务时记录模板：

```json
{
  "type": "md2wechat",
  "template": "md2wechat",
  "title": "公众号转换"
}
```

后端负责把模板解析成稳定 prompt、输入文件约定和输出路径约定。

### 5.3 路径和安全规则

- 不允许外部传入 macOS 绝对路径。
- 不允许 path traversal。
- 输入文件只能写入 job input。
- 输出文件只能从 job output 读取。
- 日志只能从 job logs 读取。
- `.env`、Chrome profile、cookies、job 运行数据和密钥不能提交到仓库。

## 6. 全局验收标准

每个阶段完成前至少运行：

```bash
git diff --check
git status --short
```

后端代码变更必须额外运行：

```bash
docker compose config --quiet
node --check backend/server.js
curl -sS http://127.0.0.1:4100/health
```

如果 OpenCode Server 或 MCP 相关配置变更，还必须运行：

```bash
curl -sS http://127.0.0.1:4096/global/health
curl -sS http://127.0.0.1:4096/mcp
```

真实 workflow 阶段必须完成 API smoke test：

1. 创建 job。
2. 写入输入文件。
3. 启动任务。
4. 等待 job 状态变为 `succeeded`。
5. 列出输出文件。
6. 下载或读取关键输出文件。

`md2wechat` 阶段的关键验收是：必须能通过 API 从 `article.md` 生成公众号 HTML 输出文件。

前端阶段的关键验收是：必须能从 UI 完成一次完整任务。

服务器迁移前的关键验收是：本地必须完成至少一个真实 skill workflow。

## 7. 风险与应对

### DeepSeek capacity

风险：模型返回 `Selected model is at capacity`，导致任务失败。

应对：

- 保持当前 retry + fallback 机制。
- 在 job metadata 中记录 attempts。
- 将 capacity 视为 provider 临时容量问题，不直接判定为代码错误。

### thinking mode 不兼容

风险：Anthropic 兼容接口与 OpenCode thinking/reasoning 参数组合不稳定。

应对：

- 保持 provider id 为 `deepseek-anthropic`。
- 保持 `OPENCODE_MODEL_REASONING=false`。
- 模型配置变更后使用新 session 验证。

### macOS 路径不可访问

风险：容器内无法访问调用方传入的宿主机路径。

应对：

- 外部文件统一上传到 job input。
- prompt 和模板只使用 `/data/work/jobs/{job_id}` 下的路径。
- 后端拒绝路径穿越和不安全相对路径。

### Chrome profile 失效

风险：浏览器登录态、cookies 或 profile 数据过期。

应对：

- 后续建立 profile 初始化和刷新流程。
- 按平台和任务隔离 profile。
- 不提交 Chrome profile 数据到仓库。

### Docker Chrome 构建慢或网络不稳定

风险：浏览器镜像构建依赖较多，影响当前 workflow 验证。

应对：

- 本地先保留 Host Chrome。
- `docker-browser` profile 继续作为目标方案迭代。
- 本地真实 workflow 稳定后再切换 Docker Chrome。

### 前端过早绑定 OpenCode 内部 API

风险：前端直接依赖 OpenCode 内部接口，后续难以替换任务执行实现。

应对：

- 前端只调用 `skills-api`。
- OpenCode API 细节由后端封装。
- 任务状态、日志、输出文件都以 job API 为准。

## 8. 下一步执行顺序

建议立即执行：

1. 实现 `template=md2wechat`。
2. 用 API 跑通 `article.md -> output HTML`。
3. 把 `md2wechat` 模板抽象进模板注册表。
4. 做最小任务前端。
5. 再推进复杂 skill、Docker Chrome 和服务器迁移。

当前不要优先做服务器迁移。服务器迁移应建立在本地真实 workflow 已经稳定的基础上。
