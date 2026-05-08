# 复杂 Skill 验收矩阵

更新时间：2026-05-08

## 1. 目的

本矩阵用于把 8 个业务 skills 从“前端可见、后端可调用”推进到“服务化可验收、可重复运行”。

验收重点不是证明 skill 在本机命令行能跑，而是证明它在本项目服务化边界内能跑：

```text
Frontend/API -> skills-api -> job input/service-config.json -> skill -> job output/logs
```

所有 smoke test 默认使用安全模式：

```json
{
  "submit": false,
  "publish": false,
  "dingtalk_notify": false,
  "dry_run": true
}
```

真实平台提交、报告发布、钉钉通知、远端数据库更新不属于本轮 smoke test，必须在单独确认后执行。

## 2. 本轮验收结论

本轮在服务器 `10.50.10.29` 上完成验收。结论：8 个业务模板均已完成服务化安全模式验收。

| 模板 | 验收状态 | job id | 本轮边界 |
|------|----------|--------|----------|
| `md2wechat` | 通过 | `job_decf126eb039427ca6184247f6454f31` | 生成公众号 HTML 和封面，不上传草稿箱 |
| `phase1-material-processor` | 通过 | `job_528e8732674d4071b2e950c3ecdbf34e` | 批次材料整理，输出处理结果 |
| `vulnerability-alert-processor` | 通过 | `job_9e66031cdd0f416ea58d655c52f23a41` | `full` 模式，`wechat_draft=false`、`publish=false` |
| `msrc-vulnerability-report` | 通过 | `job_ca571f684b99486b996c9efdb0538764` | `format-only`，不发布、不通知 |
| `cnvd-weekly-db-update` | 通过 | `job_14cdab8f3c924c60b4d2376f71244676` | `check` + `dry_run=true`，不执行真实更新 |
| `phase2-cnvd-report` | 通过 | `job_6eea192bceba438894aa1a45ab174fed` | `single` + `submit=false`，只生成 `form_context.json` |
| `phase2-cnnvd-report` | 通过 | `job_e9a135405f40408387707de87d94c610` | `single` + `submit=false`，不更新汇总表 |
| `phase2-ncc-report` | 通过 | `job_6f448db639d44ccba4128e82df6fd0b8` | `single` + `submit=false`，只生成 `form_context.json` |

本轮健康检查：

| 检查项 | 结果 |
|--------|------|
| `skills-api` | `ok=true`，模板数 9 |
| OpenCode Server | `healthy=true`，版本 `1.14.40` |
| Docker Chrome CNVD | `127.0.0.1:19332/json/version` 可访问 |
| Docker Chrome CNNVD | `127.0.0.1:19333/json/version` 可访问 |
| Docker Chrome NCC | `127.0.0.1:19334/json/version` 可访问 |

## 3. 通用验收边界

### 3.1 必须满足

- 通过 `POST /jobs` 创建 job。
- 输入文件必须上传或复制到 `input/`。
- 模板配置必须写入 `input/service-config.json`。
- 产物必须写入 `output/`。
- 运行日志必须可通过 `GET /jobs/{id}/logs` 查看。
- 输出文件必须可通过 `GET /jobs/{id}/outputs` 列出。
- 缺少材料、登录态、验证码、远端密钥时，必须在 `output/summary.txt` 记录明确原因。

### 3.2 禁止项

- 不允许在前端配置或任务备注中传入 macOS 绝对路径。
- 不允许读取 `/Users/yao/LLM/vulns`、`~/Downloads` 或宿主机 Chrome profile。
- 不允许把 API key、Webhook、SSH 密钥、平台密码写入 job input/output/logs。
- smoke test 不允许真实提交 CNVD/CNNVD/NCC。
- smoke test 不允许执行 CNVD 周库真实 update。
- smoke test 不允许推送钉钉或发布报告。

### 3.3 通用检查命令

服务器环境：

```bash
curl -sS http://127.0.0.1:4100/health
curl -sS http://127.0.0.1:4096/global/health
curl -sS http://127.0.0.1:19332/json/version
curl -sS http://127.0.0.1:19333/json/version
curl -sS http://127.0.0.1:19334/json/version
```

job 检查：

```bash
curl -sS http://127.0.0.1:4100/jobs/{job_id}
curl -sS http://127.0.0.1:4100/jobs/{job_id}/logs
curl -sS http://127.0.0.1:4100/jobs/{job_id}/outputs
```

## 4. 验收矩阵

### 4.1 `md2wechat`

| 项目 | 内容 |
|------|------|
| 前端名称 | 公众号转换 |
| 输入模式 | Markdown |
| 必需输入 | `input/article.md` |
| 必需输出 | `output/wechat-article.html`、`output/wechat-cover.png` |
| 禁止行为 | 不上传公众号草稿箱，不打开浏览器 |
| 当前状态 | 通过 |

已知通过记录：

```text
job_decf126eb039427ca6184247f6454f31
```

### 4.2 `vulnerability-alert-processor`

| 项目 | 内容 |
|------|------|
| 前端名称 | 漏洞预警材料 |
| 输入模式 | 材料目录 |
| 本轮模式 | `full` |
| 安全配置 | `wechat_draft=false`、`publish=false` |
| 必需输出 | `summary.txt`、`final.md`、`final.docx`、`render_context.json` |
| 本轮输出 | `final.md`、`final.docx`、`render_context.json`、`vuln-data.json`、`summary.txt` |
| 禁止行为 | smoke test 不上传公众号、不发布报告、不推送钉钉 |
| 当前状态 | 通过 |

已知通过记录：

```text
job_9e66031cdd0f416ea58d655c52f23a41
```

后续：沉淀一组脱敏 `vuln-data.json` + Word 模板作为固定回归样例，减少对模型推理的依赖。

### 4.3 `phase1-material-processor`

| 项目 | 内容 |
|------|------|
| 前端名称 | 材料整理 |
| 输入模式 | 材料目录 |
| 本轮模式 | `batch` |
| 配置 | `batch_dir=2026-03-30-161902(1)`、`submitter=恒脑AI代码审计智能体` |
| 必需输出 | `processed-materials/`、`summary.txt` |
| 附加输出 | `material-result.json` |
| 禁止行为 | 不修改 `input/` 原件 |
| 当前状态 | 通过 |

已知通过记录：

```text
job_528e8732674d4071b2e950c3ecdbf34e
```

后续：将该模板升级为后端确定性 adapter，直接执行已迁移的材料处理脚本。

### 4.4 `msrc-vulnerability-report`

| 项目 | 内容 |
|------|------|
| 前端名称 | MSRC 预警报告 |
| 输入模式 | 材料目录 |
| 本轮模式 | `format-only` |
| 本轮输入 | `input/materials/report.md` |
| 安全配置 | `publish=false`、`dingtalk_notify=false` |
| 必需输出 | `summary.txt`、`report.docx` |
| 本轮输出 | `report.docx`、`summary.txt`、格式化后的报告目录 |
| 禁止行为 | smoke test 不发布、不推送钉钉 |
| 当前状态 | 通过 |

已知通过记录：

```text
job_ca571f684b99486b996c9efdb0538764
```

后续：补真实脱敏 MSRC JSON/CSV 材料包后，再验 `generate` 模式生成 `report.md`、`report.docx`。

### 4.5 `cnvd-weekly-db-update`

| 项目 | 内容 |
|------|------|
| 前端名称 | CNVD 周库更新 |
| 输入模式 | 文件/目录 |
| 本轮模式 | `check` |
| 本轮输入 | `input/xml/CNVD-TEST-2026.xml` |
| 安全配置 | `dry_run=true`、`dingtalk_notify=false` |
| 必需输出 | `summary.txt`、`update-result.json` |
| 禁止行为 | smoke test 不执行真实 update、不推送钉钉 |
| 当前状态 | 通过 |

已知通过记录：

```text
job_14cdab8f3c924c60b4d2376f71244676
```

真实 update 前置条件：确认远端容器名、XML 来源、SSH key、归档目录和人工确认窗口。

### 4.6 `phase2-cnvd-report`

| 项目 | 内容 |
|------|------|
| 前端名称 | CNVD 上报 |
| 输入模式 | 材料目录 |
| 本轮模式 | `single` |
| 本轮材料 | `DAS-T106053-hugegraph系统-GremlinAPI模块存在命令执行漏洞` |
| 安全配置 | `submit=false`、`dingtalk_notify=false` |
| 必需输出 | `summary.txt`、`form_context.json` |
| 浏览器通道 | `chrome-devtools-cnvd` / `9332` |
| 禁止行为 | smoke test 不点击提交 |
| 当前状态 | 通过 |

已知通过记录：

```text
job_6eea192bceba438894aa1a45ab174fed
```

真实提交前置条件：Docker Chrome CNVD profile 已登录，验证码或人工确认流程可处理，前端二次确认已实现。

### 4.7 `phase2-cnnvd-report`

| 项目 | 内容 |
|------|------|
| 前端名称 | CNNVD 上报 |
| 输入模式 | 材料目录 |
| 本轮模式 | `single` |
| 本轮材料 | `DAS-T106053-hugegraph系统-GremlinAPI模块存在命令执行漏洞` |
| 安全配置 | `submit=false`、`update_summary=false`、`dingtalk_notify=false` |
| 必需输出 | `summary.txt`、`form_context.json` |
| 浏览器通道 | `chrome-devtools-cnnvd` / `9333` |
| 禁止行为 | smoke test 不点击提交、不更新汇总表 |
| 当前状态 | 通过 |

已知通过记录：

```text
job_e9a135405f40408387707de87d94c610
```

真实提交前置条件：Docker Chrome CNNVD profile 已登录，页面下拉项和上传控件 selector 与当前平台页面一致。

### 4.8 `phase2-ncc-report`

| 项目 | 内容 |
|------|------|
| 前端名称 | NCC 上报 |
| 输入模式 | 材料目录 |
| 本轮模式 | `single` |
| 本轮材料 | `DAS-T106053-hugegraph系统-GremlinAPI模块存在命令执行漏洞` |
| 安全配置 | `submit=false`、`dingtalk_notify=false` |
| 必需输出 | `summary.txt`、`form_context.json` |
| 浏览器通道 | `chrome-devtools-ncc` / `9334` |
| 禁止行为 | smoke test 不点击提交 |
| 当前状态 | 通过 |

已知通过记录：

```text
job_6f448db639d44ccba4128e82df6fd0b8
```

真实提交前置条件：Docker Chrome NCC profile 已登录，拖拽拼图或验证码的人工介入流程明确。

## 5. 已记录验收

### 2026-05-08 `md2wechat` smoke

| 项目 | 结果 |
|------|------|
| 环境 | server |
| 模板 | `md2wechat` |
| job id | `job_decf126eb039427ca6184247f6454f31` |
| 状态 | `succeeded` |
| 输出 | 公众号 HTML、封面 |
| 结论 | 通过 |

### 2026-05-08 `phase1-material-processor` smoke

| 项目 | 结果 |
|------|------|
| 环境 | server |
| 模板 | `phase1-material-processor` |
| 模式 | `batch` |
| job id | `job_528e8732674d4071b2e950c3ecdbf34e` |
| 状态 | `succeeded` |
| 输出 | `processed-materials/`、`summary.txt`、`material-result.json` |
| 结论 | 通过 |

### 2026-05-08 `vulnerability-alert-processor` smoke

| 项目 | 结果 |
|------|------|
| 环境 | server |
| 模板 | `vulnerability-alert-processor` |
| 模式 | `full` |
| job id | `job_9e66031cdd0f416ea58d655c52f23a41` |
| 配置 | `wechat_draft=false`、`publish=false` |
| 状态 | `succeeded` |
| 输出 | `final.md`、`final.docx`、`render_context.json`、`vuln-data.json`、`summary.txt` |
| 结论 | 通过 |

### 2026-05-08 `phase2-cnvd-report` smoke

| 项目 | 结果 |
|------|------|
| 环境 | server |
| 模板 | `phase2-cnvd-report` |
| 模式 | `single` |
| job id | `job_6eea192bceba438894aa1a45ab174fed` |
| 配置 | `das_id=DAS-T106053`、`submit=false`、`dingtalk_notify=false` |
| 状态 | `succeeded` |
| 输出 | `form_context.json`、`summary.txt` |
| 结论 | 通过 |

### 2026-05-08 `phase2-cnnvd-report` smoke

| 项目 | 结果 |
|------|------|
| 环境 | server |
| 模板 | `phase2-cnnvd-report` |
| 模式 | `single` |
| job id | `job_e9a135405f40408387707de87d94c610` |
| 配置 | `das_id=DAS-T106053`、`submit=false`、`update_summary=false`、`dingtalk_notify=false` |
| 状态 | `succeeded` |
| 输出 | `form_context.json`、`summary.txt` |
| 结论 | 通过 |

### 2026-05-08 `phase2-ncc-report` smoke

| 项目 | 结果 |
|------|------|
| 环境 | server |
| 模板 | `phase2-ncc-report` |
| 模式 | `single` |
| job id | `job_6f448db639d44ccba4128e82df6fd0b8` |
| 配置 | `das_id=DAS-T106053`、`prefer_source=CNVD`、`submit=false`、`dingtalk_notify=false` |
| 状态 | `succeeded` |
| 输出 | `form_context.json`、`summary.txt` |
| 结论 | 通过 |

### 2026-05-08 `cnvd-weekly-db-update` smoke

| 项目 | 结果 |
|------|------|
| 环境 | server |
| 模板 | `cnvd-weekly-db-update` |
| 模式 | `check` |
| job id | `job_14cdab8f3c924c60b4d2376f71244676` |
| 配置 | `remote_host=10.50.10.29`、`docker_container=crawlab`、`dry_run=true`、`dingtalk_notify=false` |
| 状态 | `succeeded` |
| 输出 | `summary.txt`、`update-result.json` |
| 结论 | 通过 |

### 2026-05-08 `msrc-vulnerability-report` smoke

| 项目 | 结果 |
|------|------|
| 环境 | server |
| 模板 | `msrc-vulnerability-report` |
| 模式 | `format-only` |
| job id | `job_ca571f684b99486b996c9efdb0538764` |
| 配置 | `month=2026-05`、`require_critical_descriptions=false`、`publish=false`、`dingtalk_notify=false` |
| 状态 | `succeeded` |
| 输出 | `report.docx`、`summary.txt`、格式化后的报告目录 |
| 结论 | 通过 |

## 6. Phase A 完成标准

- [x] 8 个业务模板都有一条明确的 smoke 测试路径。
- [x] 每个模板都有脱敏样例输入位置或本轮安全输入。
- [x] 每个模板都有默认安全配置。
- [x] 每个模板都有必需输出契约。
- [x] 每个模板都有通过状态和服务器 job 记录。
- [x] 至少 5 个模板完成 `submit=false` 或等价安全模式验收。
- [x] CNVD/CNNVD/NCC 三个平台的 Docker Chrome 前置检查通过。

## 7. 仍需补强

- MSRC 本轮只验证 `format-only`，还需要补一套脱敏 MSRC JSON/CSV 材料包验 `generate`。
- CNVD/CNNVD/NCC 本轮只验到 `form_context.json`，真实提交必须单独确认登录态、验证码处理和二次确认。
- `vulnerability-alert-processor` 已能服务化跑通，但应沉淀固定脱敏输入，降低模型生成不稳定性。
- `phase1-material-processor` 建议继续改造成后端确定性 adapter，避免让模型调度稳定脚本。
- 前端后续应增加验收样例入口、任务进度流、输出按模板分组和中断后的状态提示。
