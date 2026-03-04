# 오케스트레이터(제이) 인수인계

> 최종 업데이트: 2026-03-04

## 현재 상태

- **mainbot.js** ✅ 실행 중 (ai.orchestrator, 알람 큐 처리 전용)
- **OpenClaw** ✅ 실행 중 (ai.openclaw.gateway, Jay 페르소나 로드됨)
- **스카 커맨더** ✅ 실행 중 (ai.ska.commander)
- **루나 커맨더** ✅ 실행 중 (ai.investment.commander)
- **클로드 커맨더** ✅ 실행 중 (ai.claude.commander)

## 최근 주요 변경 (2026-03-04)

1. **제이 OpenClaw 전환**: IDENTITY.md/MEMORY.md/TOOLS.md/HEARTBEAT.md 교체
2. **mainbot.js 슬림화**: Telegram 폴링 제거, 알람 큐 처리만 담당
3. **bot_commands 테이블**: DB 마이그레이션 v4, 팀장 지휘 채널
4. **팀장 커맨더 3종**: ska.js, luna-commander.cjs, claude-commander.js
5. **LLM 교체**: 제이 인텐트 파서 Groq → Gemini 2.5 Flash
6. **NLP 고도화**: 키워드 패턴 14→24개, Gemini 프롬프트 전면 개편
7. **TEAMS.md**: 팀 기능 정의서 신규 작성 (`context/TEAMS.md`)
8. **/dexter·/archer**: 정적 응답 → bot_commands 실제 실행 전환

## 다음 작업 후보

- 루나팀 Phase 3-B: KIS 국내/해외 주식 실거래 전환
- 아처 token_usage 추적 추가
- 루나 커맨더에 루나팀 Phase 0 (`bots/invest/`) 연동
- USDT 잔고 실시간 연동 (현재 $10,000 고정값)

## 트러블슈팅

### mainbot.js 재시작
```bash
launchctl kickstart -k gui/$(id -u)/ai.orchestrator
```

### OpenClaw 재시작 (Jay 페르소나 리로드)
```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

### bot_commands 수동 테스트
```bash
sqlite3 ~/.openclaw/workspace/claude-team.db \
  "INSERT INTO bot_commands (to_bot, command, args) VALUES ('ska', 'query_today_stats', '{}')"
# 30초 후 결과 확인:
sqlite3 ~/.openclaw/workspace/claude-team.db \
  "SELECT status, result FROM bot_commands ORDER BY created_at DESC LIMIT 1"
```
