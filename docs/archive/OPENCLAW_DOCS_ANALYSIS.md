# OpenClaw 공식문서 분석 — 팀 제이 통합 전략

> 분석일: 2026-04-01 | 분석자: 메티 (Claude Opus 4.6)
> OpenClaw 버전: 2026.3.24

---

## 1. Webhook (/hooks/agent) — mainbot.js 흡수 핵심

### 현재 아키텍처
```
각 봇 → mainbot_queue(PostgreSQL) INSERT
mainbot.js → 폴링(3초) → filter.js → 텔레그램 발송
```

### 목표 아키텍처
```
각 봇 → POST /hooks/agent (deliver:true, channel:telegram)
OpenClaw 게이트웨이 → 에이전트 실행 → 텔레그램 자동 발송
mainbot.js DB 큐 폴링 제거!
```

### /hooks/agent 파라미터
```json
{
  "message": "봇 알람 내용",        // 필수
  "name": "루나팀",                 // 세션 요약에 사용
  "agentId": "main",              // 라우팅 대상 에이전트
  "sessionKey": "hook:luna:alert", // 세션 식별 (hooks.allowRequestSessionKey=true 필요)
  "deliver": true,                 // 텔레그램 발송
  "channel": "telegram",          // 발송 채널
  "to": "{topic_id}",             // 텔레그램 Topic ID
  "model": "groq/...",            // 모델 오버라이드
  "timeoutSeconds": 30            // 타임아웃
}
```

### 필수 설정
```json
{
  "hooks": {
    "enabled": true,
    "token": "secrets-store에서 로딩",
    "defaultSessionKey": "hook:ingress",
    "allowRequestSessionKey": true,
    "allowedSessionKeyPrefixes": ["hook:"]
  }
}
```

---

## 2. Agent Send — 팀장 간 통신

### CLI 사용법
```bash
# 루나팀장에게 메시지
openclaw agent --agent luna --message "BTC -5% 급락. 포지션 점검 필요."

# 텔레그램으로 전달
openclaw agent --agent luna --message "..." --deliver --channel telegram

# JSON 출력
openclaw agent --agent luna --message "상태 보고" --json
```

### 팀 제이 활용
- 현재: team-comm.js + State Bus(PostgreSQL agent_events/agent_tasks)
- 변경: `openclaw agent --agent {팀장id} --message "..."` → 직접 전달
- ⚠️ agents.list에 팀장별 에이전트 등록 필요 (Phase 3)

---

## 3. Cron — 스케줄 작업

### CLI 사용법
```bash
# 매일 오전 7시 일일 브리핑
openclaw cron add \
  --name "Daily brief" \
  --cron "0 7 * * *" \
  --tz "Asia/Seoul" \
  --session isolated \
  --message "일일 운영 현황 리포트를 작성해줘" \
  --announce \
  --channel telegram \
  --to "{총괄_topic_id}"

# 목록 확인
openclaw cron list

# 즉시 실행
openclaw cron run <job-id>
```

### 팀 제이 활용
- 일일 리포트: launchd → OpenClaw cron 전환
- 주간 안정화 리포트: 매주 일요일 자동
- ⚠️ 현재 cron 미설정 → 점진적 추가

---

## 4. Hooks — 이벤트 기반 자동화

### 이벤트 종류
```
command:new       — /new 명령 시
command:reset     — /reset 명령 시
message:received  — 메시지 수신 시
agent:bootstrap   — 에이전트 초기화 시
session:patch     — 세션 변경 시
gateway:start     — 게이트웨이 시작 시
```

### 커스텀 훅 생성
```
~/.openclaw/hooks/my-hook/
  HOOK.md          — 메타데이터 (YAML frontmatter)
  handler.ts       — 이벤트 핸들러

HOOK.md:
---
name: team-jay-monitor
event: message:received
enabled: false
---

handler.ts:
export default async function(context) {
  if (context.message.text.includes('장애')) {
    // 긴급 알림 로직
  }
}
```

### 팀 제이 활용
- message:received: 텔레그램 메시지 필터링/라우팅
- agent:bootstrap: 팀장별 동적 컨텍스트 주입
- 덱스터 연동: 장애 감지 → 커스텀 훅 → 에스컬레이션

---

## 5. Multi-Agent — 팀장 구조

### 에이전트 추가
```bash
openclaw agents add luna
openclaw agents add ska
openclaw agents add claude-lead
openclaw agents add blog
```

### 경로 구조
```
~/.openclaw/agents/luna/
  agent/           — auth-profiles, 모델 레지스트리
  sessions/        — 세션 저장소
~/.openclaw/workspace-luna/
  SOUL.md          — 루나팀장 페르소나
  USER.md          — 사용자 정보
  skills/          — 팀장 전용 스킬
```

### 텔레그램 바인딩 (팀장별 Topic 라우팅)
```json
{
  "agents": {
    "list": [
      {
        "agentId": "luna",
        "model": { "primary": "groq/kimi-k2" },
        "bindings": [{ "channel": "telegram", "topicId": "14" }]
      }
    ]
  }
}
```

---

## 6. 실행 계획 (우선순위)

### Phase 1: hooks 활성화 (즉시 — 10분)
```
openclaw config set hooks.enabled true
openclaw config set hooks.token "$(cat ~/.openclaw/openclaw.json | node -e ...)"
→ POST /hooks/wake + /hooks/agent 엔드포인트 활성화
→ mainbot.js 흡수 준비 완료
```

### Phase 2: mainbot.js webhook 전환 설계 (1~2시간)
```
1. 각 봇의 sendTelegram() 호출 포인트 매핑
2. POST /hooks/agent 래퍼 함수 작성 (packages/core/lib/openclaw-client.js)
3. mainbot_queue INSERT → webhook POST 교체
4. 단계적 전환 (한 팀씩)
5. mainbot.js DB 폴링 로직 제거
```

### Phase 3: Multi-Agent 팀장 등록 (연구 → 구현)
```
1. openclaw agents add luna/ska/claude-lead/blog
2. 각 팀장 SOUL.md + workspace 설정
3. 텔레그램 Topic 바인딩
4. 모델 + 폴백 체인 설정
```

### Phase 4: Cron 활용 (점진적)
```
1. 일일 리포트 cron 등록 (KST 08:00)
2. 주간 안정화 리포트 (일요일 09:00)
3. launchd 의존성 점진적 감소
```

### Phase 5: A2A 프로토콜 (향후)
```
- openclaw-a2a-gateway 플러그인 설치
- 외부 에이전트(Claude Code, GPT-5.4) 통신
- Agent Card 설정
```

---

## 7. 핵심 발견 요약

```
✅ webhook /hooks/agent → mainbot.js DB 큐 폴링 대체 가능
✅ openclaw agent CLI → 팀장 간 통신 대체 가능
✅ cron 내장 스케줄러 → launchd 일부 대체 가능
✅ multi-agent → 팀장별 격리된 에이전트 가능
✅ hooks → 커스텀 이벤트 핸들러로 덱스터 연동 가능
✅ sub-agents → 병렬 작업 스폰 가능 (연구 용도)

⚠️ 주의사항:
- hooks.enabled 활성화 필요 (현재 미활성)
- multi-agent는 agents.list 확장 필요 (현재 main만)
- cron은 점진적 전환 (launchd 즉시 제거 금지)
- webhook 인증은 hooks.token 별도 (gateway.auth.token과 다름!)
```
