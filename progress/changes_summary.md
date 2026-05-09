# Phase B + Phase D 完整实施总结

## 改动统计

| 文件 | 行数 | 说明 |
|------|------|------|
| `backend/server.js` | +680 | 模板 outputGroups 元数据、输出分组 API、adapter 集成、人工验证、取消标记、日志脱敏 |
| `backend/adapters/runner.js` | +119 (新文件) | 共享 adapter 运行器：runPython、日志、配置读取 |
| `backend/adapters/phase1-material-processor.js` | +147 (新文件) | 材料整理确定性 adapter |
| `backend/adapters/phase2-cnvd-report.js` | +127 (新文件) | CNVD 上报确定性 adapter |
| `backend/adapters/phase2-cnnvd-report.js` | +107 (新文件) | CNNVD 上报确定性 adapter |
| `backend/adapters/phase2-ncc-report.js` | +110 (新文件) | NCC 上报确定性 adapter |
| `docker-compose.yml` | +11 | skills-api 挂载 skills 目录(只读)、SKILL_ROOT、Docker Chrome MCP 环境变量 |
| `frontend/app.js` | +193/-65 | 过滤器、错误高亮、模板感知输出、内联预览 |
| `frontend/index.html` | +13 | 任务列表过滤栏 HTML |
| `frontend/styles.css` | +214/-21 | 过滤栏、彩色徽章、错误样式、预览面板 |

---

## Phase B：确定性 Adapter 层

### 架构

```
POST /jobs/{id}/run
  ↓
tryLoadAdapter(template)
  ├── adapter 存在 → 直接 spawn Python 脚本 (无 LLM)
  │     ├── 返回结果 → 标记成功/失败
  │     └── 返回 null → 回退到 OpenCode prompt
  └── adapter 不存在 → 原有 OpenCode prompt 路径
```

### 路由结果

| 模板 | 执行方式 | submit=false | submit=true |
|------|----------|-------------|-------------|
| `phase1-material-processor` | adapter | ✅ 直接 Python | ✅ 直接 Python |
| `phase2-cnvd-report` | adapter | ✅ 直接 Python | 回退 OpenCode |
| `phase2-cnnvd-report` | adapter | ✅ 直接 Python | 回退 OpenCode |
| `phase2-ncc-report` | adapter | ✅ 直接 Python | 回退 OpenCode |
| `md2wechat` | OpenCode prompt | - | - |
| `vulnerability-alert-processor` | OpenCode prompt | - | - |
| `msrc-vulnerability-report` | OpenCode prompt | - | - |
| `cnvd-weekly-db-update` | OpenCode prompt | - | - |
| `custom` | OpenCode prompt | - | - |

### adapter 运行特征

- `job.run.adapter = true` — 前端可据此显示「确定性 adapter」而非模型名
- `job.run.model = "adapter"` — 不消耗 LLM API 额度
- adapter 日志写入 `logs/adapter.log`
- stdout/stderr 同步写入 `logs/run.jsonl` 和 `logs/stderr.log`
- 脚本路径自动从 SKILL_ROOT 解析，cwd 可自由覆盖
- 取消任务会写入 `input/cancel-requested.json`，并尝试终止底层执行进程组

---

## Phase D：任务体验增强

### 1. 模板感知输出分组 ✅

后端 `GET /jobs/{id}/outputs` 返回 `groups` 数组，前端按模板定义渲染。

### 2. 内联预览 ✅

`summary.txt`、`form_context.json` 等 6 种文件可点击「预览」按钮展开查看。

### 3. 任务列表筛选 ✅

- 按模板类型筛选
- 按状态（创建/运行/成功/失败/中断）筛选
- 无匹配时显示「无匹配任务」

### 4. 状态彩色徽章 ✅

| 状态 | 颜色 |
|------|------|
| 已成功 | 🟢 绿色 |
| 已失败 | 🔴 红色 |
| 运行中/重试中 | 🔵 蓝色 |
| 已中断 | ⚪ 灰色 |

### 5. 失败原因高亮 ✅

- 任务列表中失败任务显示红色左边线
- 状态面板中错误信息单独高亮显示（红底红字）
- 无错误时不显示错误行

### 6. 执行方式标识 ✅

状态面板「模型」字段改为「执行方式」，adapter 任务显示「确定性 adapter」。

### 7. 人工验证与业务进度 ✅

- 后端暴露 `logs/progress.jsonl` 解析后的业务事件
- 前端展示登录、填表、上传、验证码、提交等关键节点
- 验证码/Cloudflare 截图从 `logs/` 返回到前端
- 前端可提交人工验证码或人工验证完成结果

### 8. 日志脱敏 ✅

`GET /jobs/{id}/logs` 返回前会脱敏邮箱、密码、Token、Webhook 等常见敏感信息。

---

## 验证结果

- ✅ `node --check backend/server.js` — 语法通过
- ✅ `node --test backend/server.test.js` — 23/23 测试通过
- ✅ `docker compose config --quiet` — 配置合法
- ✅ `curl /health` — API 正常，outputGroups 数据完整
- ✅ `curl /jobs/{id}/outputs` — 分组数据正确
- ✅ adapter 烟雾测试 — phase1-material-processor 正确调用 Python 脚本
- ✅ 无 adapter 模板 — 正确回退到 OpenCode prompt
- ✅ `git diff --check` — 无格式问题
- ✅ `git status` — 无 .env 或敏感文件

---

## 2026-05-09：CNVD submit=true 确定性登录/验证码 adapter

### 已完成

- `phase2-cnvd-report` 的 `submit=true` 不再回退 OpenCode，改为确定性 CDP adapter。
- 新增轻量 CDP 客户端 `backend/adapters/cdp-client.js`，后端可直接连接 `browser-cnvd:9332`。
- CNVD adapter 固定流程：
  1. 运行 `prepare_form_context.py` 生成 `output/form_context.json`。
  2. 连接 Docker Chrome 并打开 `https://www.cnvd.org.cn/flaw/create`。
  3. 检查 Cloudflare、登录页、上报表单。
  4. Cloudflare/登录态失效时截图写入 `logs/`，前端显示人工验证面板。
  5. 前端提交人工确认或验证码后，当前任务继续执行。
  6. 登录通过后按 `form_context.json` 填写 Select2、文本字段、是否公开、附件和提交验证码。
  7. 成功提交后写 `output/submission-result.json` 和 `output/summary.txt`。
- 前端新增 CNVD 账号、密码配置项；密码字段以 `type=password` 渲染。

### 当前验收结果

- ✅ 后端容器内 `/health` 已返回 `cnvd_email`、`cnvd_password` 配置 schema。
- ✅ 后端容器可通过 CDP 连接 `http://browser-cnvd:9332`。
- ✅ smoke job `job_b6b2844fc3f4452d8c3a9707d7d01d5b` 已验证：
  - `submit=true` 进入确定性 adapter。
  - 已生成 `form_context.json`。
  - 已返回 `logs/human-login-cnvd.png` 到前端人工验证面板。
  - 前端人工输入接口可唤醒等待中的 adapter。
- ⚠️ 本次 smoke 未真实提交 CNVD：Docker Chrome 未保持 CNVD 登录态，且 smoke 未配置真实 `cnvd_email/cnvd_password`，人工确认后仍未进入上报表单，任务按预期失败并记录原因。

### 其他上报 skill

- 暂未把 `submit=true` 确定性浏览器提交扩展到 CNNVD/NCC。
- 原因：CNVD 尚未完成一次真实平台提交闭环；CNNVD/NCC 页面结构、验证码和提交流程不同，需要在 CNVD 真实成功后分别固化 adapter，避免把未验证的浏览器逻辑复制到多个平台。
