# 오케스트레이터(제이) 개발 요약

> 최종 업데이트: 2026-03-04

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
| `lib/intent-parser.js` | 3단계 파싱 (slash→keyword→Gemini) |
| `lib/token-tracker.js` | LLM 토큰 추적 |
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

## NLP 파싱 정책

- **제이 인텐트 파싱**: 3단계 (slash → keyword 24개 → Gemini 2.5 Flash fallback)
- **키워드 커버리지**: "앤디 죽었어", "매매 멈춰", "서버 괜찮아?", "AI 트렌드 알려줘" 등 구어체 포함
- **Gemini 시스템 프롬프트**: 팀별 컨텍스트·자연어 예시 포함 (intent-parser.js)
- **TEAMS.md**: 팀 기능 정의서 (`context/TEAMS.md`) — 신규 봇 추가 시 업데이트 필요
- **/dexter·/archer**: bot_commands 실제 실행 (5분 타임아웃)

## launchd

- `ai.orchestrator` — mainbot.js KeepAlive, 2초 폴링
- 재시작: `launchctl kickstart -k gui/$(id -u)/ai.orchestrator`
