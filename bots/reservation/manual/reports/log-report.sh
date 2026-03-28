#!/bin/bash
# ============================================================
# 스카봇 오류 로그 분석 리포트 (3시간마다 실행)
# - 최근 3시간 로그에서 오류/경고 추출
# - OpenClaw agent로 분석 요청 → 텔레그램 전송
# ============================================================

LOG_FILE="$HOME/.openclaw/workspace/naver-monitor.log"
CHAT_ID="${TELEGRAM_CHAT_ID:-}"
REPORT_TIME=$(date '+%Y-%m-%d %H:%M')

# ── 1. 로그 파일 존재 여부 확인 ──────────────────────────────
if [ ! -f "$LOG_FILE" ]; then
  echo "[$REPORT_TIME] 로그 파일 없음: $LOG_FILE"
  exit 0
fi

# ── 2. 최근 3시간치 로그 추출 (최대 2000줄) ──────────────────
RECENT_LOGS=$(tail -2000 "$LOG_FILE")

# ── 3. 오류/경고 라인 필터링 ──────────────────────────────────
ERROR_LINES=$(echo "$RECENT_LOGS" | grep -E "❌|⚠️|오류|실패|Error|Timeout|detached|crash|undefined|not defined|Cannot|failed|FAIL" | tail -60)
ERROR_COUNT=$(echo "$ERROR_LINES" | grep -c . 2>/dev/null || echo 0)

# ── 4. 오류 없으면 조용히 종료 ────────────────────────────────
if [ "$ERROR_COUNT" -eq 0 ]; then
  echo "[$REPORT_TIME] 오류 없음 → 리포트 스킵"
  exit 0
fi

# ── 4-1. 텔레그램 전송 시간대 체크 (09:00~22:00만 전송) ────────
CURRENT_HOUR=$(date '+%H' | sed 's/^0//')
if [ "$CURRENT_HOUR" -lt 9 ] || [ "$CURRENT_HOUR" -ge 22 ]; then
  echo "[$REPORT_TIME] 오류 ${ERROR_COUNT}건 감지됐으나 전송 시간 외(${CURRENT_HOUR}시) → 스킵"
  exit 0
fi

echo "[$REPORT_TIME] 오류 ${ERROR_COUNT}건 감지 → 분석 시작"

# ── 5. 최근 전체 로그 요약 (컨텍스트용, 마지막 30줄) ──────────
CONTEXT_LOGS=$(echo "$RECENT_LOGS" | tail -30)

# ── 6. OpenClaw agent로 분석 요청 ─────────────────────────────
PROMPT="다음은 네이버 스마트플레이스 예약 모니터링 봇(naver-monitor.js)의 최근 오류 로그야.

[오류/경고 로그 - ${ERROR_COUNT}건]
${ERROR_LINES}

[최근 전체 로그 마지막 30줄]
${CONTEXT_LOGS}

위 로그를 분석해서 아래 형식으로 한국어로 간결하게 답해줘:

1. 오류 패턴 요약 (어떤 오류가 몇 번 반복됐는지)
2. 원인 추정 (각 오류의 가능한 원인)
3. 우선순위 (지금 당장 고쳐야 하는지, 나중에 봐도 되는지)

최대 5줄로 핵심만 요약해줘."

ANALYSIS=$(openclaw agent \
  --message "$PROMPT" \
  --local \
  2>/dev/null | tail -50)

# openclaw --local 실패 시 텍스트만 전송
if [ -z "$ANALYSIS" ]; then
  ANALYSIS="(분석 실패 - 로그 직접 확인 필요)"
fi

# ── 7. 텔레그램 리포트 전송 ────────────────────────────────────
REPORT="🔍 스카봇 오류 분석 리포트

📅 분석 시각: ${REPORT_TIME}
⚠️ 오류 감지: ${ERROR_COUNT}건

━━━━━━━━━━━━━━━
${ANALYSIS}
━━━━━━━━━━━━━━━

🔧 지금 시간 되시면 같이 수정할 수 있을까요?
가능하시면 '응' 또는 '지금 봐줘'라고 답장해주세요!"

openclaw agent \
  --message "$REPORT" \
  --channel telegram \
  --deliver \
  --to "$CHAT_ID" \
  2>/dev/null

echo "[$REPORT_TIME] 텔레그램 리포트 전송 완료"
