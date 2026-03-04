# 메인봇 (오케스트레이터) 설계 문서
> 2026-03-04 | bots/orchestrator/

---

## 1. 설계 철학

### 문제: 알람 폭탄 + 단일 명령 창구 부재
- 각 봇이 독립적으로 텔레그램 직접 발송 → 폭탄
- 무음 설정, 야간 조용, 배치 요약 없음
- 명령 채널 분산 → 운영 복잡성

### 해결: 메인봇 = 총괄 허브
```
봇들 → mainbot_queue (DB) → 메인봇 필터 → 텔레그램 사용자
사용자 → 텔레그램 → 메인봇 파서 → 라우팅 → 응답
```

### 핵심 원칙
- **알람 통합**: 모든 봇 알람을 mainbot_queue를 통해 수신
- **필터링**: 무음/야간/배치 3단계 필터
- **CRITICAL 보장**: alert_level=4는 어떤 경우에도 발송
- **토큰 추적**: 무료 API(Groq, Gemini)도 모두 기록 → 분석/최적화

---

## 2. 아키텍처

### 파일 구조
```
bots/orchestrator/
├── src/
│   ├── mainbot.js      # 진입점 (polling + 큐 처리)
│   ├── router.js       # 명령 라우팅 + 권한
│   ├── filter.js       # 알람 필터링 엔진
│   └── dashboard.js    # /status 생성
├── lib/
│   ├── intent-parser.js    # 3단계 파싱
│   ├── batch-formatter.js  # 배치 요약 (LLM 0토큰)
│   ├── response-cache.js   # 조회 캐싱
│   ├── confirm.js          # 확인 대기
│   ├── mute-manager.js     # 무음 관리
│   ├── night-handler.js    # 야간 보류
│   ├── team-bus.js         # claude team-bus 래퍼
│   └── token-tracker.js    # LLM 토큰 추적
├── migrations/
│   └── 002_mainbot.js      # DB 마이그레이션
├── context/
│   ├── IDENTITY.md
│   └── PERMISSIONS.md
└── launchd/
    └── ai.orchestrator.plist
```

### 팀별 클라이언트
```
bots/reservation/lib/mainbot-client.js   (CJS — 스카팀)
bots/investment/shared/mainbot-client.js (ESM — 루나팀)
bots/claude/lib/mainbot-client.js        (CJS — 클로드팀)
```

### DB: claude-team.db (기존 확장)
| 테이블 | 용도 |
|--------|------|
| mainbot_queue | 봇→메인봇 알람 큐 |
| mute_settings | 무음 설정 |
| command_history | 명령 히스토리 + 파싱 소스 |
| pending_confirms | Lv4 확인 대기 |
| morning_queue | 야간 보류 알람 |
| token_usage | LLM 토큰 사용 (전 봇 통합) |

---

## 3. 명령 체계

| 명령 | 설명 |
|------|------|
| `/status` | 전체 시스템 현황 (launchd + 에이전트 + 큐 통계) |
| `/cost` | LLM 토큰/비용 현황 (오늘/이번달) |
| `/mute <대상> <시간>` | 알람 무음 (30m/1h/2h/1d) |
| `/unmute <대상>` | 무음 해제 |
| `/mutes` | 활성 무음 목록 |
| `/luna` | 루나팀 현황 |
| `/ska` | 스카팀 현황 |
| `/dexter` | 덱스터 시스템 점검 안내 |
| `/archer` | 아처 기술 소화 현황 |
| `/brief` | 야간 보류 알람 브리핑 |
| `/queue` | 최근 알람 큐 (10건) |
| `/help` | 도움말 |

---

## 4. 알람 레벨

| 레벨 | 이름 | 배치 | 야간 | 예시 |
|------|------|------|------|------|
| 1 | LOW | ✅ | 보류 | PAPER 거래 기록 |
| 2 | MEDIUM | ✅ | 보류 | 일반 모니터링 |
| 3 | HIGH | ❌ | 즉시 | 안전장치 발동 |
| 4 | CRITICAL | ❌ | 즉시 + 직접발송 폴백 | 보안인증 필요 |

---

## 5. LLM 파싱 3단계

```
입력 텍스트
   ↓
1단계: /slash 직접 매핑 (0토큰, <1ms)
   ↓ 미매핑
2단계: 키워드 패턴 (0토큰, <1ms)
   ↓ 미매핑
3단계: Groq Scout LLM (무료, ~200ms)
   ↓ 실패
'unknown' → 도움말 안내
```

목표: 슬래시+키워드 80% 이상 → LLM 최소화

---

## 6. 토큰 추적 (token_usage 테이블)

### 추적 대상
| 봇 | 모델 | 유/무료 | task_type |
|----|------|---------|---------|
| 아처 | claude-sonnet-4-6 | 💸유료 | tech_analysis |
| 루나팀 | groq/llama-4-scout | ✅무료 | trade_signal |
| 메인봇 | groq/llama-4-scout | ✅무료 | command_parse |
| 스카봇 | gemini-2.5-flash | ✅무료 | conversation |

### /cost 명령 출력 예시
```
💰 LLM 토큰 리포트

📅 오늘 (2026-03-04)
  총 토큰: 45,230
  유료 비용: $0.0023

  봇별:
  • luna [trade_signal] 12,400tok (무료)
  • 아처 [tech_analysis] 8,500tok ($0.0023)
  • 메인봇 [command_parse] 3,200tok (무료)

📆 이번 달 (2026-03)
  총 토큰: 312,450
  유료 비용: $0.0182
```

---

## 7. launchd 운영

```bash
# 등록
cp bots/orchestrator/launchd/ai.orchestrator.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ai.orchestrator.plist

# 상태 확인
launchctl list ai.orchestrator

# 재시작
launchctl kickstart -k gui/$(id -u)/ai.orchestrator

# 로그
tail -f ~/.openclaw/logs/mainbot.log
```

---

## 8. 6주 안정화 계획 (맥미니 도착 전)

| 주차 | 항목 |
|------|------|
| 1주 | 시스템 안정화 + CRITICAL/HIGH 누락 0건 검증 + /status /mute 검증 |
| 2주 | 파싱 소스 비율 측정 (슬래시+키워드 80% 목표) + /cost 리포트 |
| 3주 | 배치 요약 품질 + 야간 모드 동작 검증 + 키워드 패턴 개선 |
| 4주 | OpenClaw ↔ 메인봇 연동 + 전체 봇 토큰 통합 대시보드 |
| 5주 | 덱스터 LLM 호출 최적화 + 클로드 코드 세션 상태 동기화 |
| 6주 | 맥미니 이전 체크리스트 연동 + 전체 문서 업데이트 |

---

## 9. 검증 방법

```bash
# 1. 마이그레이션
node bots/orchestrator/migrations/002_mainbot.js
sqlite3 ~/.openclaw/workspace/claude-team.db ".tables"

# 2. 메인봇 시작
node bots/orchestrator/src/mainbot.js
# → 텔레그램 "🤖 메인봇 시작됨" 수신 확인

# 3. 알람 경유 테스트
node -e "
const { publishToMainBot } = require('./bots/reservation/lib/mainbot-client');
publishToMainBot({ from_bot: 'test', event_type: 'alert', alert_level: 2, message: '테스트 알람' });
console.log('큐 삽입 완료');
"
sqlite3 ~/.openclaw/workspace/claude-team.db "SELECT * FROM mainbot_queue ORDER BY id DESC LIMIT 1;"

# 4. 텔레그램 명령 테스트
# /status → 현황 응답
# /cost → 토큰 리포트
# /mute luna 1h → 무음 설정
```
