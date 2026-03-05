# 오케스트레이터(제이) 개발 요약

> 최종 업데이트: 2026-03-05

## 시스템 역할

제이(Jay)는 AI 봇 시스템의 총괄 오케스트레이터.
- **OpenClaw 에이전트**: 사장님과 Telegram 자연어 대화
- **mainbot.js**: 알람 큐(mainbot_queue) 처리 전용 백그라운드 프로세스
- **팀장 지휘**: bot_commands DB를 통해 스카/루나/클로드팀에 명령 전달

## 아키텍처

```
사장님(Telegram) → OpenClaw(Jay/Gemini) → bot_commands → 팀장 커맨더
                                        ← mainbot_queue ← 팀봇 알람
```

## 핵심 파일

| 파일 | 역할 |
|------|------|
| `src/mainbot.js` | 알람 큐 폴링(2초) + 아침 브리핑 + 정리 작업 |
| `src/router.js` | 인텐트 → 핸들러 매핑 + bot_commands 연동 |
| `src/filter.js` | 무음·중복·야간 필터 |
| `src/dashboard.js` | /status 빌더 |
| `lib/intent-parser.js` | 4단계 파싱 (slash→learned→keyword→LLM fallback) + nlp-learnings.json 5분 리로드 |
| `lib/identity-checker.js` | 팀장 커맨더 정체성 점검·자동 복원 (6시간 주기) |
| `lib/token-tracker.js` | LLM 토큰 추적 (duration_ms·gpt-4o 단가 추가, 2026-03-05) |
| `lib/mute-manager.js` | 무음 관리 |
| `lib/night-handler.js` | 야간 보류 큐 |
| `lib/confirm.js` | 확인 요청 |
| `migrations/` | DB 마이그레이션 |

## bot_commands 지원 명령

### 스카팀 (to_bot='ska')
- `query_reservations` — 오늘 예약 현황
- `query_today_stats` — 오늘 매출
- `query_alerts` — 미해결 알람
- `restart_andy` — 앤디 재시작
- `restart_jimmy` — 지미 재시작

### 루나팀 (to_bot='luna')
- `get_status` — 루나팀 현황
- `pause_trading` — 거래 일시정지
- `resume_trading` — 거래 재개
- `force_report` — 투자 리포트 즉시 발송

### 클로드팀 (to_bot='claude')
- `run_check` — 덱스터 기본 점검
- `run_full` — 덱스터 전체 점검
- `run_fix` — 덱스터 자동 수정
- `daily_report` — 덱스터 일일 보고
- `run_archer` — 아처 실행
- `ask_claude` — Claude AI 직접 질문 (claude -p headless)
- `analyze_unknown` — 미인식 명령 분석 + NLP 패턴 학습

## NLP 파싱 정책

- **제이 인텐트 파싱**: 4단계 (slash → learned → keyword → LLM fallback)
  - `slash`: `/명령어` 정적 매핑
  - `learned`: `~/.openclaw/workspace/nlp-learnings.json` (5분 리로드, Claude가 자동 학습)
  - `keyword`: 정적 패턴 24개 (구어체 포함)
  - `llm`: LLM_FALLBACK (현재 Gemini 2.5 Flash — 변경 가능)
- **미인식 명령 자동 개선**: default case → analyze_unknown → claude -p → 패턴 추출 → nlp-learnings.json
- **제이↔클로드 직접 통신**: `/claude <질문>` or `/ask <질문>` → ask_claude bot_command (5분 타임아웃)
- **TEAMS.md**: 팀 기능 정의서 (`context/TEAMS.md`) — 신규 봇 추가 시 업데이트 필요

## 정체성 유지 시스템

- **제이(mainbot.js)**: 6시간마다 `runCommanderIdentityCheck()` → 각 팀장 COMMANDER_IDENTITY.md 점검·복원
- **각 팀장**: 6시간마다 팀원 `bot-identities/[id].json` 점검·갱신
- **모든 커맨더**: 시작 시 + 6시간마다 `loadBotIdentity()` → `BOT_IDENTITY` 로드 (LLM 없이 작동)
- **이슈 시**: Telegram 보고 + 자동 복원. 정상이면 침묵.

## launchd

- `ai.orchestrator` — mainbot.js KeepAlive, 2초 폴링
- 재시작: `launchctl kickstart -k gui/$(id -u)/ai.orchestrator`

## token_usage 테이블 (claude-team.db)

전 봇 LLM 사용 이력 공용 기록. `lib/token-tracker.js` 사용.

```sql
token_usage (id, bot_name, team, model, provider, is_free, task_type,
             tokens_in, tokens_out, cost_usd, duration_ms, recorded_at, date_kst)
```

- `duration_ms`: 응답 소요 시간 (2026-03-05 추가)
- `is_free=1`: Groq/Google 무료 호출
- investment 봇은 `shared/llm-client.js`에서 자동 기록
- `/cost` 명령으로 조회 (buildCostReport)
