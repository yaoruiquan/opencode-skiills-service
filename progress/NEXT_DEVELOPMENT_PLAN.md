# 下一步开发计划

更新时间：2026-05-08

当前状态：服务器已完成试迁移，8 个业务 skills 已同步到服务器，前端可创建任务、上传输入、填写模板配置、运行模板并下载输出。`phase1-material-processor` 已通过服务化 API 验收；`md2wechat` 已可输出结果。接下来重点不是继续堆模板，而是把复杂 skill 从“能被 OpenCode 调用”提升到“可稳定服务化验收”。

## 1. 总体目标

把当前平台从 PoC/试迁移状态推进到可日常使用的内部自动化平台。

核心判断标准：

- 每个模板都有固定输入、固定配置、固定输出、固定验收样例。
- 前端可以让非开发人员完成一次完整任务，不需要手写复杂 JSON。
- 真实平台提交默认安全，提交前有明确确认和日志。
- 服务器具备基本鉴权、并发控制、日志留存和恢复能力。

## 2. 优先级总览

| 优先级 | 阶段 | 目标 |
|--------|------|------|
| P0 | 复杂 skill 验收矩阵 | 证明每个模板至少有一个可重复成功路径 |
| P0 | 确定性 adapter 层 | 将脚本型流程从 prompt 约束升级为后端可控执行 |
| P1 | 前端配置表单化 | 用中文表单替代大段 JSON |
| P1 | 日志与任务体验 | 增加实时日志、失败原因、输出预览 |
| P1 | 真实上报安全开关 | 对 `submit=true` 增加二次确认和前置检查 |
| P2 | 鉴权、队列、并发限制 | 支持多人使用和服务器稳定运行 |
| P2 | 部署与备份规范 | 固化服务器更新、skills 同步、job 清理 |

## 3. Phase A：复杂 skill 验收矩阵

目标：为 8 个业务 skills 建立最小可重复验收集。

当前模板：

- `md2wechat`
- `vulnerability-alert-processor`
- `phase1-material-processor`
- `msrc-vulnerability-report`
- `cnvd-weekly-db-update`
- `phase2-cnvd-report`
- `phase2-cnnvd-report`
- `phase2-ncc-report`

开发内容：

1. 为每个模板准备一组脱敏样例输入。
2. 在 `progress/` 下维护验收矩阵。
3. 每个模板定义：
   - 必需输入
   - 推荐配置
   - 可运行模式
   - 必需输出
   - 不提交平台的 smoke test
   - 真实提交前置条件
4. 把 `submit=false` 的准备阶段全部跑通。
5. 对 CNVD/CNNVD/NCC 分别验证 Docker Chrome 登录态和 MCP 连通性。

验收标准：

- 每个模板至少有一个 `submit=false` 成功 job。
- 每个失败场景都能在 `summary.txt` 中给出明确原因。
- 前端输出区能下载关键产物。

已新增验收矩阵：

```text
progress/SKILL_ACCEPTANCE_MATRIX.md
```

当前 Phase A 状态：

- 已建立 8 个业务模板的验收矩阵。
- 已记录 `md2wechat` 和 `phase1-material-processor` 的服务器成功 job。
- 剩余重点是补齐 6 个模板的安全模式 smoke 记录。

## 4. Phase B：确定性 adapter 层

目标：减少复杂 skill 对 LLM 自由执行的依赖。能直接跑脚本的流程，由后端 adapter 明确调用。

当前问题：

- 后端已经把 prompt 约束写清楚，但复杂流程仍依赖 OpenCode 理解并执行脚本。
- 对材料整理、表单上下文生成、MSRC 文档生成这类确定性步骤，后端可以直接调脚本，LLM 只负责非确定性整理或补充。

建议改造：

```text
backend/
├── adapters/
│   ├── phase1-material-processor.js
│   ├── phase2-cnvd-report.js
│   ├── phase2-cnnvd-report.js
│   ├── phase2-ncc-report.js
│   ├── msrc-vulnerability-report.js
│   └── vulnerability-alert-processor.js
└── server.js
```

优先 adapter：

1. `phase1-material-processor`
   - 直接执行 `scripts/test_material.py`
   - 后端负责输出契约校验
2. `phase2-cnvd-report`
   - 直接执行 `scripts/prepare_form_context.py`
   - `submit=false` 时不调用 OpenCode 浏览器阶段
3. `phase2-cnnvd-report`
   - 直接执行 `scripts/prepare_form_context.py`
4. `phase2-ncc-report`
   - 直接执行 `scripts/prepare_form_context.py`
5. `msrc-vulnerability-report`
   - 拆分 `generate`、`format-only`、`publish`

验收标准：

- `submit=false` 的准备类任务不依赖 LLM 也能成功。
- OpenCode 只在需要网页、模型总结、复杂推理时介入。
- 失败原因由 adapter 明确返回，不只依赖 stderr。

## 5. Phase C：前端配置表单化

目标：把现在的 JSON 配置框升级为中文表单，降低误操作概率。

当前前端已经支持：

- 模板选择
- 材料上传
- 执行模式
- 任务备注
- 中文配置表单和高级 JSON
- 任务列表
- 任务进度视图
- 运行中任务中断
- 输出文件分组
- 输出文件下载
- 标准输出/错误输出

下一步改造：

1. 将当前自动表单继续升级为字段级校验，例如月份、DAS 编号、远端主机格式。
2. 为危险开关增加更明确的权限控制，而不只是二次确认。
3. 将任务进度从状态推断升级为后端阶段事件。
4. 增加 `summary.txt` 和 `form_context.json` 的前端内嵌预览。
5. 支持一键下载全部输出 zip。

重点模板表单：

| 模板 | 表单字段 |
|------|----------|
| 材料整理 | 批次目录、DAS 编号、提交人 |
| CNVD 上报 | DAS 编号、目标路径、是否提交、是否通知 |
| CNNVD 上报 | DAS 编号、实体描述、验证方式、是否提交、是否更新汇总 |
| NCC 上报 | DAS 编号、材料来源优先级、是否提交 |
| MSRC 报告 | 月份、是否强制高危描述、是否发布、是否通知 |
| CNVD 周库 | 远端主机、容器名、dry run、是否通知 |

验收标准：

- 常规用户不需要手写 JSON。
- 前端能阻止明显危险配置。
- 每个字段有中文标签和默认值。

## 6. Phase D：任务体验增强

目标：让失败更好排查，让结果更好使用。

开发内容：

1. 任务列表支持按模板、状态、时间筛选。
2. 输出文件支持按类型分组：
   - 报告
   - JSON
   - 图片
   - 压缩包
   - 日志
3. `summary.txt` 在前端直接预览。
4. `form_context.json` 前端格式化预览。
5. 日志改为 SSE 流式更新，减少手动刷新。
6. 失败时突出显示：
   - 失败阶段
   - 缺失输入
   - 缺失输出
   - 人工介入项
7. 支持复制 job ID 和下载全部输出 zip。

验收标准：

- 用户不用进服务器也能判断失败原因。
- 任务运行中日志自动刷新。
- 成功任务可以一键下载全部产物。

## 7. Phase E：真实上报流程安全化

目标：让 CNVD/CNNVD/NCC 的真实提交变成可控动作。

开发内容：

1. `submit=true` 前置检查：
   - Docker Chrome 服务健康
   - MCP connected
   - 平台登录态有效
   - `form_context.json` 存在
   - 上传附件存在
2. 前端二次确认：
   - 明确平台
   - 明确 DAS 编号
   - 明确是否会真实提交
3. 提交阶段输出：
   - 平台编号
   - 截图或关键页面状态
   - 提交时间
   - 人工验证码记录
4. 批量任务支持暂停、继续、跳过单条。

验收标准：

- 默认不会误提交。
- 真实提交前必须显式确认。
- 每次提交都有可追溯记录。

## 8. Phase F：鉴权、队列、并发限制

目标：从单人可信环境升级到服务器可多人使用。

开发内容：

1. 登录鉴权：
   - 简单账号密码或反向代理鉴权
   - API token
2. 权限控制：
   - 查看任务
   - 创建任务
   - 执行真实提交
   - 管理配置
3. 队列：
   - 同时只运行有限数量 job
   - 浏览器类任务按平台串行
   - DeepSeek capacity 自动排队重试
4. 任务取消：
   - 支持取消 running job
   - 清理子进程
5. 运行数据保留策略：
   - 保留最近 N 天
   - 大文件清理
   - 输出归档

验收标准：

- 多个用户同时使用时不会互相覆盖。
- CNVD/CNNVD/NCC 同平台任务不会并发抢同一个浏览器 profile。
- 服务器磁盘不会无限增长。

## 9. Phase G：部署、更新和备份

目标：让服务器迁移成果可长期维护。

开发内容：

1. 固化更新命令：
   - 服务项目 `git pull`
   - skills 仓库 `git pull`
   - Docker 镜像 rebuild
   - 容器重启
2. 健康检查脚本：
   - API health
   - OpenCode health
   - MCP connected
   - Docker Chrome debug endpoint
   - Python 依赖导入
3. 备份：
   - `.env` 不入库，只备份到安全位置
   - Chrome profile 定期备份
   - 关键 job 输出归档
4. 发布记录：
   - 每次部署记录 git commit
   - 每次 skills 同步记录来源 commit

建议新增脚本：

```text
scripts/server-health-check.sh
scripts/sync-skills-to-server.sh
scripts/deploy-server.sh
scripts/archive-old-jobs.sh
```

## 10. 最近一周建议执行顺序

1. 新增 `SKILL_ACCEPTANCE_MATRIX.md`，把 8 个模板验收样例列出来。
2. 先完成 `phase2-cnvd-report`、`phase2-cnnvd-report`、`phase2-ncc-report` 的 `submit=false` 表单上下文验收。
3. 把 `phase1-material-processor` 改成后端确定性 adapter，不再通过 OpenCode prompt 跑脚本。
4. 前端把模板配置从 JSON 改为中文表单，同时保留高级 JSON。
5. 增加 `summary.txt` 前端预览和失败原因高亮。

## 11. 当前不建议优先做的事

- 先不要开放公网。
- 先不要默认开启 `submit=true`。
- 先不要做复杂多租户。
- 先不要把密钥放进前端配置。
- 先不要继续增加新 skill，除非现有 8 个模板都已有 smoke test。
