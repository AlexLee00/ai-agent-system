# Changelog

All notable changes to ai-agent-system will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/).

---

## [Unreleased]

---

## [v3.2.0] - 2026-03-07 — 1주차 완료: 3계층 핵심 기반 구축

### Added
- **헤파이스토스 TP/SL OCO** (`bots/investment/team/hephaestos.js`)
  - Binance Spot OCO 주문 자동 설정 (TP +6%, SL -3%, R/R 2:1)
  - PAPER_MODE 시 OCO 생략, `tp_sl_set` 플래그 기록
- **State Bus agent_events/agent_tasks** (`bots/reservation/lib/state-bus.js`)
  - 팀원↔팀장 비동기 소통 채널 (emitEvent, createTask 등 7개 함수)
- **덱스터 v2 체크 모듈** (`bots/claude/lib/checks/`)
  - team-leads / openclaw / llm-cost / workspace-git
- **DexterMode 이중 모드** (`bots/claude/lib/dexter-mode.js`)
  - Normal ↔ Emergency 자동 전환 + 알림 버퍼링
- **LLM 인프라** (`packages/core/lib/`)
  - llm-logger.js: 전 팀 LLM 비용 DB 추적
  - llm-router.js: 복잡도 기반 모델 자동 분배 (simple→Groq, complex→Sonnet)
  - llm-cache.js: SQLite 시맨틱 캐시, 팀별 TTL 차등
- **루나팀 매매일지** (`bots/investment/shared/trade-journal-db.js`)
  - 5개 테이블: trade_journal / rationale / review / performance_daily / luna_monitor
  - hephaestos/nemesis 자동 기록 연동, 텔레그램 리포트
- **OpenClaw 멀티에이전트 구조** (`packages/core/lib/`)
  - team-comm.js: 팀장 간 소통 (State Bus 기반, sessions_send 대체)
  - heartbeat.js: 팀장 생존 확인 + 이벤트 폴링
  - SOUL.md 3개 (ska / claude-lead / luna)
- **독터 자동 복구 봇** (`bots/claude/lib/doctor.js`)
  - 화이트리스트 5개: 서비스재시작 / 파일권한 / WAL체크포인트 / 캐시정리 / npm패치
  - 블랙리스트 9개: rm-rf / DROP TABLE / DELETE FROM / kill-9 / --force 등
  - doctor_log 테이블 자동 생성 (state.db)
- **OPS/DEV 분리** (`packages/core/lib/mode-guard.js`, `scripts/deploy-ops.sh`)
  - ensureOps / ensureDev / runIfOps
  - 배포 전 5단계 점검 스크립트

### Fixed
- **덱스터 오류 이력 무한 누적** — cleanup() 미호출 버그, 7일 보존으로 수정
- **덱스터 오탐 근본 수정** — markResolved() 추가 (ok 복귀 시 error 이력 즉시 삭제)
- **openclaw.js IPv6 파싱 오탐** — bracket notation `[::1]` 처리 추가
- **미해결 알림 반복 + tool_code 누출** (pickko-alerts-resolve.js 신규)

### Security
- pre-commit에 config.yaml 차단 추가
- .gitignore에 config.yaml, *.key 추가
- security.js에 pre-commit 훅 설치/권한 점검 추가

---

## [2026-03-06] — 팀 제이 아키텍처 Day 3

### Added
- **llm-logger.js** (`packages/core/lib/llm-logger.js`)
  - 전 팀 LLM 호출 통합 추적 (state.db `llm_usage_log` 테이블 자동 생성)
  - 모델별 단가표: Groq=무료, Haiku=$1/$5, Sonnet=$3/$15, Opus=$15/$75 per 1M
  - `logLLMCall`, `getDailyCost`, `getCostBreakdown`, `buildDailyCostReport` 함수
  - 기존 cost-tracker.js (루나팀 파일 기반) 독립 유지

- **llm-router.js** (`packages/core/lib/llm-router.js`)
  - 복잡도 기반 LLM 모델 자동 라우팅 (DB 의존 없음, 순수 로직)
  - simple→Groq(무료), medium→Haiku, complex→Sonnet, deep→Opus
  - 팀별 requestType 매핑: ska(7종), claude(6종), luna(6종)
  - 긴급도(urgency) 상향 로직: simple→medium (high/critical)
  - `selectModel`, `classifyComplexity` 함수

- **llm-cache.js** (`packages/core/lib/llm-cache.js`)
  - 시맨틱 캐시: 벡터 DB 없이 키워드 해시 기반 경량 구현 (state.db `llm_cache`)
  - 캐시 키: 불용어 제거 → 키워드 추출 → 정렬 → SHA256(team:requestType:keywords)
  - TTL 팀별 차등: ska=30분, claude=360분(6h), luna=5분
  - 민감정보 보호: 앞 100자 요약 + 긴 숫자열(6자리+) 마스킹
  - `generateCacheKey`, `getCached`, `setCache`, `getCacheStats`, `cleanExpired` 함수

### Changed
- **llm-client.js** (`bots/investment/shared/llm-client.js`)
  - `_logLLMCall` import 추가 (createRequire 패턴, 무음 실패)
  - callOpenAI / callGroq 양쪽에 `_logLLMCall?.()` 연동

---

## [2026-03-06] — 팀 제이 아키텍처 Day 1~2

### Added
- **State Bus 확장** (`bots/reservation/lib/state-bus.js`)
  - `agent_events` 테이블: 팀원→팀장 이벤트 보고 (emitEvent, getUnprocessedEvents, markEventProcessed)
  - `agent_tasks` 테이블: 팀장→팀원 작업 지시 (createTask, getPendingTasks, completeTask, failTask)
  - priority 정렬: critical(0) > high(1) > normal(2) > low(3)

- **루나팀 TP/SL OCO** (`bots/investment/team/hephaestos.js`)
  - BUY 진입 후 Binance Spot OCO 주문 자동 설정
  - TP: +6%, SL: -3%, SL limit buffer: ×0.999
  - PAPER_MODE 시 OCO 생략
  - `trade.tpSlSet = true/false` 기록

- **DB 마이그레이션 v3** (`bots/investment/shared/db.js`)
  - `tp_price`, `sl_price`, `tp_order_id`, `sl_order_id`, `tp_sl_set` 컬럼 추가

- **덱스터 v2 체크 모듈** (`bots/claude/lib/checks/`)
  - `team-leads.js`: 핵심 봇 프로세스 건강 (OpenClaw/앤디/지미/루나크립토/tmux:ska)
  - `openclaw.js`: OpenClaw 게이트웨이 상태 (launchd+포트+메모리)
  - `llm-cost.js`: LLM 비용 모니터링 (일간/월간, 예산 $10 기준)
  - `workspace-git.js`: 워크스페이스 Git 건강 점검

- **DexterMode 이중 모드** (`bots/claude/lib/dexter-mode.js`)
  - Normal ↔ Emergency 자동 전환 (OpenClaw/스카야 3분 이상 다운 시)
  - Emergency 중 알림 버퍼링 + 복구 시 일괄 발송
  - 상태 파일: `~/.openclaw/workspace/dexter-mode-state.json`

- **덱스터 v2 통합** (`bots/claude/src/dexter.js`)
  - v2 체크 모듈 4개 추가 (에러 격리 적용)
  - DexterMode 모드 전환 판단 연동

- **덱스터 퀵체크 v2** (`bots/claude/src/dexter-quickcheck.js`)
  - 팀장 봇 프로세스 빠른 점검 추가

### Fixed
- **openclaw.js IPv6 파싱 버그**
  - `[::1]:18789` 주소를 `split(':')[0]` → `[` 로 파싱하는 버그 수정
  - IPv6 bracket notation 명시적 처리: `[::1]` → loopback 인식
  - IPv6 wildcard 추가: `::`, `0:0:0:0:0:0:0:0`

- **dexter-quickcheck.js false positive**
  - v2 openclaw 포트 체크(lsof 기반) 제거 → 기존 launchd 체크로 충분
  - 5분 주기 퀵체크에서 CRITICAL "포트 미바인딩" 오경보 해소

### Changed
- CLAUDE.md: 개발 루틴 + 세션 루틴 섹션 추가

---

## [2026-03-05] — 시스템 인프라 확장

### Added
- LLM 토큰 이력 DB (`bots/orchestrator/lib/token-tracker.js`)
- 덱스터 AI 분석 레이어 (`bots/claude/lib/ai-analyst.js`)
- 덱스터 퀵체크 2-티어 체계 (5분 + 1시간)
- OpenClaw 2026.3.2 업데이트

### Fixed
- 덱스터 Phase C 버그 수정
- 헬스체크 회복 로직
- 스카 취소루틴 버그 수정

---

## [2026-03-03] — 스카팀 v3.0 + 클로드팀 v2.0

### Added
- 스카팀 폴더 구조 개편 (auto/manual/lib)
- State Bus 에이전트 통신 구축
- 덱스터 ska 감시 모듈
- 아처 v2.0 AI/LLM 트렌드 재정의
- team-bus 덱스터↔아처 통신

### Changed
- 루나팀 Phase 3-A 크립토 LIVE 전환 (PAPER_MODE=false)
