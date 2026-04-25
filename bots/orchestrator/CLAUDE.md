# 오케스트레이터팀 — Claude Code 컨텍스트

## 역할
제이 오케스트레이터 — 마스터↔팀장 간 중앙 허브, 텔레그램 라우팅, 알람 큐 관리

## 팀 구조
제이(오케스트레이터)
  router.js — 텔레그램 메시지 → 의도 분류 → 팀장 위임 (2,819줄, 핵심)
  orchestrator.js — 현재 launchd/dist 런타임 엔트리
  jay-runtime.js — 텔레그램 pending flush, 아침 브리핑, cleanup, identity check
  mainbot.js — 은퇴한 호환 alias 엔트리
  filter.js — 알람 필터링 (Phase 4 Standing Orders 이전 예정)
  dashboard.js — 일일 대시보드 리포트
  write.js — 일일 리포트 작성

## 핵심 파일
- src/router.js (2,819줄) — 메시지 라우팅 + 의도 분류 + OpenClaw 위임
- src/orchestrator.ts — 현재 source of truth 엔트리
- src/jay-runtime.ts — Jay runtime housekeeping loop
- dist/ts-runtime/bots/orchestrator/src/orchestrator.js — 실제 운영 런타임 엔트리
- src/mainbot.js — retired compatibility alias only
- src/filter.js (107줄) — 알람 필터 규칙 (Standing Orders로 이전 예정)
- scripts/experience-store-cli.js — RAG 경험 저장 CLI (OpenClaw exec 연동)
- scripts/enqueue-ska-reservation.js — 스카팀 예약 등록 exec

## 현재 상태
- Phase 4 진행 중: legacy mainbot alias 축소 + alert resolve OpenClaw 통합
- experience-store-cli.js 신규 추가 (RAG 자기학습, 04-02)
- router.js 소스코드 딥 분석 미완료 (잔여 영역)
