#!/bin/bash
# update-rc-context.sh
# Remote Control 접속 시 Claude Code가 가장 먼저 읽을 현황판 자동 생성

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONTEXT_FILE="$PROJECT_DIR/RC_CONTEXT.md"
CONFIG="$PROJECT_DIR/config/tmux-windows.json"
DB_PATH="$HOME/.openclaw/workspace/state.db"
TODAY=$(date '+%Y-%m-%d')
NOW=$(date '+%Y-%m-%d %H:%M:%S KST')

# ── 헬퍼 ─────────────────────────────────────────────────────
db_query() {
  sqlite3 "$DB_PATH" "$1" 2>/dev/null || echo "?"
}

launchd_status() {
  local svc="$1"
  local result
  result=$(launchctl list 2>/dev/null | grep -w "$svc" | awk '{print $1}')
  if [[ -z "$result" ]]; then
    echo "중단 ❌"
  elif [[ "$result" == "-" ]]; then
    echo "대기 중 ⏸"
  else
    echo "실행 중 ✅ (PID: $result)"
  fi
}

# ── 스카팀 현황 ───────────────────────────────────────────────
SKA_TODAY=$(db_query "SELECT COUNT(*) FROM reservations WHERE date='$TODAY'")
SKA_PENDING=$(db_query "SELECT COUNT(*) FROM reservations WHERE status='pending'")
SKA_FAILED=$(db_query "SELECT COUNT(*) FROM reservations WHERE status='failed'")
SKA_BLOCK_QUEUE=$(db_query "SELECT COUNT(*) FROM pending_blocks WHERE processed=0" 2>/dev/null || echo "0")
SKA_ANDY=$(launchd_status "ai.ska.naver-monitor")
SKA_JIMMY=$(launchd_status "ai.ska.kiosk-monitor")

# OBSERVE_ONLY 상태 확인
OBSERVE_STATUS="전체 OPS ✅"
OBSERVE_VAL=$(pgrep -f "naver-monitor.js" | head -1 | xargs -I{} sh -c 'ps eww {} 2>/dev/null | tr " " "\n" | grep "^OBSERVE_ONLY"' 2>/dev/null)
[[ "$OBSERVE_VAL" == "OBSERVE_ONLY=1" ]] && OBSERVE_STATUS="관찰 모드 👀 (화이트리스트)"

# ── 루나팀 현황 ───────────────────────────────────────────────
LUNA_CRYPTO=$(launchd_status "ai.investment.crypto")
LUNA_DOM=$(launchd_status "ai.investment.domestic")
LUNA_OVS=$(launchd_status "ai.investment.overseas")

# 오늘 LLM 비용 (investment state 파일)
LUNA_COST=$(node -e "
try {
  const s = require('$HOME/.openclaw/investment-state.json');
  const cost = s.dailyCost || s.daily_cost || 0;
  console.log('\$' + parseFloat(cost).toFixed(4));
} catch { console.log('?'); }
" 2>/dev/null || echo "?")

# ── 클로드팀 현황 ────────────────────────────────────────────
DEXTER=$(launchd_status "ai.claude.dexter")
ARCHER=$(launchd_status "ai.claude.archer")

# ── 미해결 버그 ───────────────────────────────────────────────
OPEN_BUGS=$(node -e "
try {
  const fs = require('fs');
  const bt = JSON.parse(fs.readFileSync('$HOME/.openclaw/workspace/bug-tracker.json', 'utf8'));
  const open = bt.bugs ? bt.bugs.filter(b => b.status === 'open') : [];
  if (!open.length) { console.log('없음 ✅'); return; }
  open.slice(0, 3).forEach(b => console.log('  - [' + b.id + '] ' + b.title));
  if (open.length > 3) console.log('  ... 외 ' + (open.length - 3) + '건');
} catch { console.log('확인 불가'); }
" 2>/dev/null || echo "확인 불가")

# ── tmux 창 현황 (config 기반) ───────────────────────────────
WINDOWS_STATUS=$(node -e "
const c = require('$CONFIG');
c.windows.filter(w => w.name !== 'cc').forEach(w => {
  const icon = w.status === 'active' ? '🟢' : '⏳';
  console.log('  ' + icon + ' ' + w.name.padEnd(10) + ' Phase ' + w.phase + '  ' + w.desc);
});
" 2>/dev/null || echo "  config 읽기 실패")

# ── RC_CONTEXT.md 생성 ───────────────────────────────────────
cat > "$CONTEXT_FILE" << EOF
# 🚀 RC_CONTEXT — Remote Control 현황판
> 자동 생성: ${NOW}
> ⚠️ 이 파일을 먼저 읽고 작업을 시작해

---

## 📅 오늘 현황 (${TODAY})

### 스카팀
| 항목 | 현황 |
|------|------|
| 오늘 예약 | ${SKA_TODAY}건 |
| Pending | ${SKA_PENDING}건 |
| Failed | ${SKA_FAILED}건 |
| 즉시차단 큐 | ${SKA_BLOCK_QUEUE}건 |
| 앤디 (naver-monitor) | ${SKA_ANDY} |
| 지미 (kiosk-monitor) | ${SKA_JIMMY} |
| OPS 모드 | ${OBSERVE_STATUS} |

### 루나팀
| 항목 | 현황 |
|------|------|
| 크립토 사이클 | ${LUNA_CRYPTO} |
| 국내주식 사이클 | ${LUNA_DOM} |
| 미국주식 사이클 | ${LUNA_OVS} |
| 오늘 LLM 비용 | ${LUNA_COST} |

### 클로드팀
| 항목 | 현황 |
|------|------|
| 덱스터 (점검봇) | ${DEXTER} |
| 아처 (인텔봇) | ${ARCHER} |

---

## 🤖 팀 구성

${WINDOWS_STATUS}

---

## 🐛 미해결 버그

${OPEN_BUGS}

---

## 🗂️ 작업 이어받기

- 팀 프로필 → \`docs/team-profiles.md\`
- 기능 목록 → \`docs/team-features.md\`
- 코딩 가이드 → \`docs/coding-guide.md\`
- 팀 창 설정 → \`config/tmux-windows.json\`

---

## ⚡ 자주 쓰는 명령

\`\`\`bash
skastatus                              # 스카팀 서비스 상태
skalog                                 # OPS 로그 실시간
tail -f /tmp/cc-remote.log             # Remote Control 로그
bash scripts/reload-monitor.sh         # 스카팀 빠른 재시작
bash scripts/tmux-start.sh --reload    # 새 팀 창 추가
rcupdate                               # 현황판 수동 갱신
\`\`\`

---

## 🛡️ 절대 규칙

- DEV → OPS 전환은 반드시 사용자 확인 후
- secrets.json / API 키 절대 git push 금지
- 직접 launchctl 대신 \`bash scripts/reload-monitor.sh\` 사용
- 새 팀 추가 = \`config/tmux-windows.json\` 수정만
EOF

echo "[RC] 컨텍스트 업데이트 완료: $CONTEXT_FILE"
