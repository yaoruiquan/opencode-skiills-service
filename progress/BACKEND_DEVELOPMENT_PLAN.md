# OpenCode Skills Service 后端开发计划

更新时间：2026-05-07

状态：v0 已实现并完成本地 smoke test。

## 目标

先开发一个最小可用的任务服务层，用来承接后续前端或外部系统调用。

当前阶段不直接迁移服务器，也不做完整用户体系。重点先解决三个问题：

1. 前端或 API 不能直接把 macOS 绝对路径交给容器。
2. 每次 skill 任务需要统一 job 目录、输入目录、输出目录和日志目录。
3. 外部调用方需要通过稳定 API 创建任务、上传文件、启动 OpenCode、查看状态和拿输出。

## v0 架构

```text
Client / Frontend
  -> skills-api
  -> OpenCode Server
  -> DeepSeek v4 flash
  -> skills
  -> Chrome DevTools MCP
```

## 目录规范

每个任务使用独立目录：

```text
/data/work/jobs/{job_id}/input
/data/work/jobs/{job_id}/output
/data/work/jobs/{job_id}/logs
/data/work/jobs/{job_id}/job.json
```

对外展示时，API 返回容器内路径和相对路径。

后续前端上传的文件会进入：

```text
/data/work/jobs/{job_id}/input
```

skill 产物统一写入：

```text
/data/work/jobs/{job_id}/output
```

## v0 API

### 健康检查

```text
GET /health
```

返回 API 服务状态和 OpenCode Server 地址。

### 创建任务

```text
POST /jobs
```

请求示例：

```json
{
  "type": "md2wechat",
  "title": "测试公众号转换"
}
```

返回：

```json
{
  "id": "job_xxx",
  "status": "created",
  "paths": {
    "root": "/data/work/jobs/job_xxx",
    "input": "/data/work/jobs/job_xxx/input",
    "output": "/data/work/jobs/job_xxx/output",
    "logs": "/data/work/jobs/job_xxx/logs"
  }
}
```

### 列出任务

```text
GET /jobs
```

### 查看任务

```text
GET /jobs/{job_id}
```

### 写入输入文件

```text
POST /jobs/{job_id}/files
```

v0 使用 JSON 上传，避免先引入 multipart 依赖：

```json
{
  "filename": "article.md",
  "content": "# 标题\n正文"
}
```

也支持 base64：

```json
{
  "filename": "image.png",
  "contentBase64": "..."
}
```

### 启动任务

```text
POST /jobs/{job_id}/run
```

请求示例：

```json
{
  "prompt": "使用 md2wechat skill，把 /data/work/jobs/job_xxx/input/article.md 转成公众号 HTML，输出到 /data/work/jobs/job_xxx/output",
  "model": "deepseek-anthropic/deepseek-v4-flash"
}
```

API 会异步执行：

```text
opencode run --attach http://opencode-server:4096 --dir /data/work/jobs/{job_id}
```

### 查看日志

```text
GET /jobs/{job_id}/logs
```

### 查看输出

```text
GET /jobs/{job_id}/outputs
```

### 下载输出文件

```text
GET /jobs/{job_id}/outputs/{relative_path}
```

## 实施步骤

1. 新增 `backend/server.js`，使用 Node 内置 HTTP，不引入 npm 依赖。
2. 在 `docker-compose.yml` 增加 `skills-api` 服务，复用 OpenCode 自定义镜像。
3. API 只操作 `/data/work/jobs` 和 `/data/output`，不接收任意宿主机路径。
4. 用 `opencode run --attach` 调用已经运行的 OpenCode Server。
5. 更新 README，补充 API 使用示例。
6. 完成本地验证并提交 git。

## 非目标

v0 暂不做：

- 用户登录。
- 权限隔离。
- 前端页面。
- multipart/form-data 上传。
- WebSocket/SSE 实时日志。
- 多 worker 队列。
- 服务器迁移。

这些放到 v1 以后再做。
