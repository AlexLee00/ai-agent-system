# 세션 핸드오프

> 다음 Claude Code 세션에서 이 파일을 먼저 읽어주세요.

## 최종 세션 (2026-03-07) — 1주차 완료

### 현재 상태
- **1주차 Day 1~7 전체 완료** ✅
- 통합 테스트 5/5 카테고리 전체 통과
- 기존 OPS 서비스 정상 운영 중 (크립토 실투자 포함)
- 안정화 기준선 v3.2.0 설정 완료

### 완료 커밋 이력 (1주차)
```
3c530a0  docs: 세션 마감 문서 업데이트 (2026-03-07)
b3d0ace  chore: 덱스터 체크섬 갱신 (markResolved 반영)
c11886d  fix: 오류 패턴 오탐 근본 수정 — markResolved() 추가
d5df7df  chore: 덱스터 체크섬 갱신 (Day 6 반영)
b9e7b46  feat: Day 6 — 독터 + 보안 강화 + OPS/DEV 분리
(이전) Day 5: team-comm + heartbeat + SOUL.md
(이전) Day 4: 매매일지 시스템
(이전) Day 3: llm-logger + llm-router + llm-cache
(이전) Day 1~2: State Bus + TP/SL OCO + 덱스터 v2
```

### 다음 세션에서 해야 할 것

**2주차 시작: 스카팀 Shadow Mode 적용**
1. `bots/reservation/lib/shadow-mode.js` 구현
   - 규칙 엔진 실행과 LLM 판단을 병렬로 실행
   - 결과 일치율 DB에 기록 (shadow_log 테이블)
   - LLM: Groq llama-4-scout (무료)
2. Groq API 연동 (스카팀 config.yaml에 groq 키 추가)
3. Shadow Mode 검증: 일치율 모니터링 대시보드

**주의사항**
- tmux 세션명은 `ska` (skaya 아님)
- 팀장 봇(스카/클로드/루나 OpenClaw 에이전트) 아직 미구축 — 구조만 존재
- agent_events 보고 경로 전환은 3주차
- TP/SL은 고정 비율 (네메시스 동적 산출은 향후)
- Gemini API는 스카팀 전용 — 루나팀 사용 불가
- insertReview 함수: `insertReview(tradeId, review)` 형식 (tradeId 첫 번째 인자)

### 알려진 이슈
- KNOWN_ISSUES.md 참조
- KI-001: workspace-git.js `*.key` warn — .gitignore에 추가 완료, 덱스터 체크 다음 실행 시 자동 소거 예정
- KI-002: archer.js trackTokens() 미적용 — LLM 비용 미추적 (낮은 우선순위)
- KI-003: npm audit high 5건 (duckdb→node-gyp) — 런타임 무관, 무시

### 시스템 현황 (2026-03-07 기준)
| 팀 | 상태 | 모드 |
|----|------|------|
| 스카팀 | ✅ OPS | 예약관리 정상 |
| 루나팀 크립토 | ✅ OPS | PAPER_MODE=false |
| 루나팀 국내/해외 | ✅ DEV | PAPER_MODE=true |
| 클로드팀 덱스터 | ✅ OPS | 5분+1시간 주기 |
| OpenClaw 제이 | ✅ OPS | 포트 18789 |
