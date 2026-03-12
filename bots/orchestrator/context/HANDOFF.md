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
5. **LLM 명칭 일반화**: Gemini 고정 → LLM_FALLBACK_MODEL/PROVIDER (소스별 표기: 'slash'|'learned'|'keyword'|'llm')
6. **NLP 고도화**: 키워드 패턴 14→24개, LLM 프롬프트 전면 개편
7. **제이↔클로드 직접 통신**: `/claude <질문>` → ask_claude bot_command → claude -p headless (5분 타임아웃)
8. **NLP 자동개선 루프**: 미인식 명령 → analyze_unknown → Claude가 패턴 추출 → nlp-learnings.json 학습
9. **팀장·팀원 정체성 유지**: identity-checker.js + 각 팀장 checkXxxTeamIdentity() + loadBotIdentity()
10. **/dexter·/archer**: 정적 응답 → bot_commands 실제 실행 전환

<!-- session-close:2026-03-05:openclaw-업데이트-제이-rag-연동-e2e-데이 -->
#### 2026-03-05 ✨ OpenClaw 업데이트 + 제이 RAG 연동 + e2e 데이터 정리
- OpenClaw 2026.2.26→2026.3.2 업데이트
- 제이 TOOLS.md RAG 검색 섹션 추가 (system_docs 12건 임베딩)
- state.db e2e 테스트 데이터 4건 삭제 (2099-01-01)
<!-- session-close:2026-03-05:openclaw-업데이트-제이-rag-연동-e2e-데이:end -->

<!-- session-close:2026-03-08:phase-1-루나팀-전환판단-llm졸업실전-덱스터팀장 -->
#### 2026-03-08 ✨ Phase 1 — 루나팀 전환판단 + LLM졸업실전 + 덱스터팀장봇연동
- shadow-mode.js getTeamMode/setTeamMode 추가
- luna-transition-analysis.js 신규
- router.js luna_confirm/luna_shadow/luna_analysis 케이스
- run-graduation-analysis.js 신규
- weekly-stability-report.js weeklyValidation 연동
- reporter.js emitDexterEvent (agent_events 이중경로)
- claude-lead-brain.js processAgentEvent/pollAgentEvents
- dexter.js emitDexterEvent+pollAgentEvents 연결
- processAgentEvent payload TEXT 파싱 버그 수정
- db-backup pg_dump 절대경로 버그 수정 (이전 세션 이어)
- pickko-daily-audit manualCount TDZ 버그 수정 (이전 세션 이어)
- 테스트 14/14 전체 통과
- 스카팀 매출 데이터 체크 (마이그레이션 타이밍 이슈, 정상화)
- 포캐스트 학습데이터 0일 오류 분석 (정상화)
- pickko-daily-audit+db-backup launchd exit 1 갱신
- 관련 파일: `packages/core/lib/shadow-mode.js scripts/luna-transition-analysis.js scripts/run-graduation-analysis.js scripts/weekly-stability-report.js bots/orchestrator/src/router.js bots/claude/lib/reporter.js bots/claude/lib/claude-lead-brain.js bots/claude/src/dexter.js bots/reservation/scripts/backup-db.js bots/reservation/auto/scheduled/pickko-daily-audit.js`
<!-- session-close:2026-03-08:phase-1-루나팀-전환판단-llm졸업실전-덱스터팀장:end -->

<!-- session-close:2026-03-12:워커웹-ui개선-및-매출데이터-정합성-수정 -->
#### 2026-03-12 ✨ 워커웹 UI개선 및 매출데이터 정합성 수정
- DataTable 페이지네이션(10건/pageSize prop)
- 매출데이터 90일치 날짜오프셋 수정(daily_summary 기준 재입력)
- sales API TO_CHAR date 수정(KST오프셋 버그 해결)
- 3/10~3/11 스카 매출 신규 입력
- 문서관리 삭제버튼 btn-danger 통일
- 사이드바/헤더 높이 h-16 정렬
- DataTable 빈행 채우기 제거
- 관련 파일: `bots/worker/web/components/DataTable.js`, `bots/worker/web/app/sales/page.js`, `bots/worker/web/app/documents/page.js`, `bots/worker/web/server.js`, `bots/worker/web/components/Sidebar.js`, `bots/worker/web/components/Header.js`, `bots/worker/web/app/_shell.js`
<!-- session-close:2026-03-12:워커웹-ui개선-및-매출데이터-정합성-수정:end -->

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
