#!/bin/bash
# start-worker-web.sh — 워커팀 API 서버 시작 스크립트 (launchd 호출)
# config.yaml에서 API 키를 런타임에 로드 (하드코딩 금지)

CONFIG_YAML="$(dirname "$0")/../../investment/config.yaml"

# config.yaml에서 값 추출 함수
yaml_val() {
  # 섹션 내 api_key 첫 번째 값 추출
  grep -A1 "^$1:" "$CONFIG_YAML" | grep "api_key" | head -1 | sed 's/.*api_key: *"\(.*\)"/\1/'
}

# Anthropic API 키
if [ -z "$ANTHROPIC_API_KEY" ]; then
  export ANTHROPIC_API_KEY="$(yaml_val anthropic)"
fi

# Groq API 키 (첫 번째 키 사용)
if [ -z "$GROQ_API_KEY" ]; then
  export GROQ_API_KEY="$(grep -A2 "accounts:" "$CONFIG_YAML" | grep "api_key" | head -1 | sed 's/.*api_key: *"\(.*\)"/\1/')"
fi

NODE="/Users/alexlee/.nvm/versions/node/v24.13.1/bin/node"
SCRIPT="$(dirname "$0")/../web/server.js"

exec "$NODE" "$SCRIPT"
