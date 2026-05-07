# Project Rules

This repository is the local PoC and future service wrapper for OpenCode + local skills.

The current priority is to turn existing skills into a stable service workflow:

```text
Client / Frontend
  -> skills-api
  -> OpenCode Server
  -> DeepSeek Anthropic-compatible API
  -> local skills
  -> Chrome DevTools MCP
```

## Current State

- OpenCode runs in Docker as `opencode-server` on `127.0.0.1:4096`.
- The job API runs as `skills-api` on `127.0.0.1:4100`.
- The default model is `deepseek-anthropic/deepseek-v4-flash`.
- The fallback model is `deepseek-anthropic/deepseek-v4-pro`.
- Model configuration is generated from `.env` at container startup.
- `chrome-devtools-mcp@0.25.0` is installed inside the OpenCode runtime image.
- Docker Chrome DevTools services are `browser-cnvd:9332`, `browser-cnnvd:9333`, and `browser-ncc:9334`.
- Host Chrome is now a fallback path only; the default local service path uses Docker Chrome through the `docker-browser` profile.
- The minimal frontend runs as `frontend` on `127.0.0.1:4101` and calls `skills-api` only.

## Source Of Truth

Use these files as the source of truth before making changes:

- `README.md` for startup and API usage.
- `docker-compose.yml` for runtime services and volumes.
- `backend/server.js` for the job API.
- `config/opencode.template.json` for OpenCode config rendering.
- `opencode-server/start-opencode.sh` for environment-to-config generation.
- `progress/整个项目的实现逻辑.md` for the current end-to-end implementation logic.
- `progress/迁移前验收清单.md` for pre-server-migration acceptance gates.
- `progress/迁移前验收报告.md` for the latest local acceptance results.
- `progress/服务器迁移方案.md` for the server trial migration plan.
- `progress/PROJECT_PROGRESS.md` for completed project milestones.
- `progress/BACKEND_DEVELOPMENT_PLAN.md` for the current backend plan.

The older planning document at:

```text
/Users/yao/Documents/网安- AI应用开发/问题及解决思路/2026-05-06-OpenCode-Skills服务化开发计划.md
```

is historical input, not current implementation truth. Adapt ideas from it, but do not blindly copy outdated assumptions.

## Security And Secrets

- Never commit `.env`.
- Never print real API keys in logs, docs, commits, or final responses.
- Keep `.env.example` as placeholders only.
- Keep generated OpenCode runtime config in the Docker volume `opencode-config`, not in the repository.
- Do not commit Chrome profile data, cookies, browser cache, session databases, or job output data.
- Do not add user login/auth unless explicitly requested. This PoC is currently local-only.

## Path Rules

Do not pass arbitrary macOS absolute paths into skills or prompts.

Bad:

```text
/Users/yao/Documents/...
```

Good:

```text
/data/work/jobs/{job_id}/input
/data/work/jobs/{job_id}/output
```

All service-facing tasks must use job directories:

```text
/data/work/jobs/{job_id}/input
/data/work/jobs/{job_id}/output
/data/work/jobs/{job_id}/logs
/data/work/jobs/{job_id}/job.json
```

If a local macOS file or folder is needed, the backend or caller must copy/upload it into the job input directory first.

## Docker Rules

- Keep `opencode-server` and `skills-api` as separate services.
- `skills-api` calls OpenCode through `OPENCODE_SERVER_URL`, currently `http://opencode-server:4096`.
- Keep `opencode-server` based on the custom local image `opencode-skills-service-opencode:local`.
- Do not rely on runtime `npx @latest` for MCP tools. Pin and install required tools in the image.
- Keep Docker browser services behind the `docker-browser` profile.
- Local PoC and server deployment should prefer Docker Chrome. Host Chrome is only for temporary fallback debugging.
- Mount skills through `SKILLS_HOST_DIR` to `/root/.agents/skills:ro`; do not hardcode macOS skills paths in Compose or docs.

## Model Rules

- Use provider id `deepseek-anthropic`, not `deepseek`, to avoid collision with OpenCode built-in provider metadata.
- Keep `OPENCODE_MODEL_REASONING=false` for DeepSeek Anthropic-compatible flash tasks unless a specific test proves otherwise.
- For real skills, prefer new sessions after model/provider config changes.
- Treat `Selected model is at capacity` as a transient provider capacity failure, not a code failure.
- `skills-api` should retry capacity failures and fall back to configured models.

## Job API Rules

`skills-api` is the integration boundary for future frontend work.

Keep the API stable:

- `GET /health`
- `POST /jobs`
- `GET /jobs`
- `GET /jobs/{job_id}`
- `POST /jobs/{job_id}/files`
- `POST /jobs/{job_id}/run`
- `GET /jobs/{job_id}/logs`
- `GET /jobs/{job_id}/outputs`
- `GET /jobs/{job_id}/outputs/{relative_path}`

Implementation rules:

- Do not add dependencies unless they remove real complexity.
- Keep request body limits.
- Reject path traversal.
- Keep all files inside the job root.
- Record attempts, model, exit code, stdout, stderr, and capacity fallback status in `job.json`.
- Preserve asynchronous execution for `/run`; do not block the HTTP request until OpenCode finishes.

## Skills Rules

Important skills for this project:

- `md2wechat`
- `vulnerability-alert-processor`
- `phase1-material-processor`
- `msrc-vulnerability-report`
- `cnvd-weekly-db-update`
- `phase2-cnvd-report`
- `phase2-cnnvd-report`
- `phase2-ncc-report`

When making skills serviceable:

- Replace hardcoded `/Users/yao/...` paths with container paths, relative paths, or environment variables.
- Prefer `/root/.agents/skills/{skill_name}` inside containers.
- Keep skills as an external synced asset. Do not vendor generated skill working data, profiles, secrets, or outputs into this repo.
- Keep shared browser profiles separate per platform/task.
- Validate one skill end to end before generalizing abstractions.
- Start with `md2wechat` for service-level tests because it has clearer input/output behavior.

## Browser MCP Rules

Current local browser endpoints exposed on the host:

```text
http://127.0.0.1:19332
http://127.0.0.1:19333
http://127.0.0.1:19334
```

Current Docker browser endpoints from containers:

```text
http://browser-cnvd:9332
http://browser-cnnvd:9333
http://browser-ncc:9334
```

Rules:

- Use `/usr/local/bin/chrome-devtools-mcp` in OpenCode config, not a bare command name.
- Verify MCP with `GET http://127.0.0.1:4096/mcp`.
- Verify Chrome DevTools with `/json/version`.
- Docker Chrome runs Chromium on internal loopback port `9222` and exposes task ports through nginx, so keep the nginx Host rewrite if service names are used.
- Browser startup may remove Chromium `Singleton*` profile locks because each Docker profile is single-writer per browser service.
- Do not expose Chrome DevTools ports publicly on a server.
- Server migration should keep Docker Chrome or another controlled headless Chrome service.

## Frontend Direction

The frontend should call `skills-api`, not arbitrary OpenCode internals.

Expected frontend workflow:

```text
Create job
  -> upload/write files
  -> run job
  -> poll job status or subscribe to future events
  -> list/download outputs
```

Do not build a decorative landing page. Build the usable task dashboard first.

Initial frontend should include:

- Job creation form.
- File upload/input panel.
- Run button.
- Status display.
- Log/output viewer.
- Download links.

## Server Migration Rules

Do not migrate to a server until the local job API can complete at least one real skill workflow.

Minimum server requirements:

- Ubuntu 22.04 or 24.04.
- Docker and Docker Compose.
- 4 CPU cores minimum, 8 GB RAM minimum, 16 GB recommended.
- 100 GB disk recommended.
- Network access to DeepSeek API and required package mirrors.

Before server migration:

- Remove local macOS path assumptions.
- Decide how skills are synchronized to the server.
- Decide how Chrome profiles are initialized and refreshed.
- Replace `192.168.65.254` with Docker service names or server-local Chrome endpoints.
- Add health checks and restart policies.

## Verification Rules

Before claiming a change is done, run the relevant checks:

```bash
docker compose config --quiet
node --check backend/server.js
curl -sS http://127.0.0.1:4096/global/health
curl -sS http://127.0.0.1:4096/mcp
curl -sS http://127.0.0.1:4100/health
```

For backend API changes, also run a smoke test:

1. Create a job.
2. Write an input file.
3. Run the job.
4. Confirm job status becomes `succeeded`.
5. Confirm an output file can be listed and downloaded.

Before committing:

```bash
git diff --check
git status --short
```

Confirm `.env`, Chrome profiles, and job output data are not staged.
