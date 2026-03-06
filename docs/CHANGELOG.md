# Changelog

All notable changes to ai-agent-system will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/).

---

## [Unreleased]

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
