#!/usr/bin/env sh
set -eu

: "${OPENCODE_PROVIDER_ID:=deepseek}"
: "${OPENCODE_PROVIDER_NAME:=DeepSeek}"
: "${OPENCODE_PROVIDER_NPM:=@ai-sdk/anthropic}"
: "${OPENCODE_API_BASE_URL:=https://api.deepseek.com/anthropic}"
: "${OPENCODE_API_KEY:=replace-with-your-deepseek-api-key}"
: "${OPENCODE_MODEL:=deepseek-v4-flash}"
: "${OPENCODE_MODEL_DISPLAY_NAME:=DeepSeek V4 Flash}"
: "${OPENCODE_MODEL_REASONING:=false}"
: "${OPENCODE_MODEL_CONTEXT:=128000}"
: "${OPENCODE_MODEL_OUTPUT:=64000}"
: "${CHROME_DEVTOOLS_HOST:=192.168.65.254}"
: "${CHROME_DEVTOOLS_CNVD_PORT:=9332}"
: "${CHROME_DEVTOOLS_CNNVD_PORT:=9333}"
: "${CHROME_DEVTOOLS_NCC_PORT:=9334}"
: "${OPENCODE_TEMPLATE:=/opt/opencode/templates/opencode.template.json}"
: "${OPENCODE_CONFIG:=/root/.config/opencode/opencode.json}"

export OPENCODE_PROVIDER_ID
export OPENCODE_PROVIDER_NAME
export OPENCODE_PROVIDER_NPM
export OPENCODE_API_BASE_URL
export OPENCODE_API_KEY
export OPENCODE_MODEL
export OPENCODE_MODEL_DISPLAY_NAME
export OPENCODE_MODEL_REASONING
export OPENCODE_MODEL_CONTEXT
export OPENCODE_MODEL_OUTPUT
export CHROME_DEVTOOLS_HOST
export CHROME_DEVTOOLS_CNVD_PORT
export CHROME_DEVTOOLS_CNNVD_PORT
export CHROME_DEVTOOLS_NCC_PORT
export OPENCODE_TEMPLATE
export OPENCODE_CONFIG

mkdir -p "$(dirname "${OPENCODE_CONFIG}")"

python3 - <<'PY'
import json
import os
import sys
from string import Template

template_path = os.environ["OPENCODE_TEMPLATE"]
config_path = os.environ["OPENCODE_CONFIG"]

with open(template_path, "r", encoding="utf-8") as f:
    rendered = Template(f.read()).safe_substitute(os.environ)

try:
    data = json.loads(rendered)
except json.JSONDecodeError as exc:
    print(f"Invalid rendered OpenCode config: {exc}", file=sys.stderr)
    sys.exit(1)

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY

if [ "${OPENCODE_API_KEY}" = "replace-with-your-deepseek-api-key" ] || [ -z "${OPENCODE_API_KEY}" ]; then
  echo "Warning: OPENCODE_API_KEY is not configured. OpenCode can start, but model calls will fail." >&2
fi

exec opencode "$@"
