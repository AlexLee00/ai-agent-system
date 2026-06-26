# AGENTS.md — 오케스트레이터팀 (제이, 중앙 허브)

> 이 파일은 OpenAI Codex·Claude Code가 오케스트레이터팀(bots/orchestrator) 작업 시 읽는 가이드다.
> 상위 규칙 상속: 루트 AGENTS.md + ~/.codex/AGENTS.md(Lean Mode). 본 파일은 특화 컨텍스트만 추가한다.

## 역할 경계 (불변)
- **메티(Claude app)** = 전략·설계·코드점검·독립검증. 코드 직접 수정 금지.
- **코덱스(OpenAI Codex)** = 명세 기반 구현.
- **마스터(제이)** = 승인·git commit·launchctl·DB write. 마스터 전용.
- 절차: 메티 설계 → 코덱스 구현 → 메티 검증 → 마스터 승인.

## ★ 절대 무중단 (PROTECTED)
- 오케스트레이터는 **마스터↔팀장 중앙 허브** — 텔레그램 라우팅이 멈추면 전체 시스템 명령/알람 마비.
- launchd 런타임 엔트리(dist/ts-runtime/.../orchestrator.js) 무중단.
- router.js(2,819줄)는 핵심 — 변경 시 텔레그램 의도분류·위임 경로 보존 필수.

## 역할
제이 오케스트레이터 — 마스터↔팀장 간 중앙 허브, 텔레그램 라우팅, 알람 큐 관리.

## 팀 구조
```
제이(오케스트레이터)
  router.js — 텔레그램 메시지 → 의도 분류 → 팀장 위임 (2,819줄, 핵심)
  orchestrator.ts/.js — 현재 launchd 런타임 엔트리 (source of truth)
  jay-runtime.ts — 텔레그램 pending flush, 아침 브리핑, cleanup, identity check
  filter.js — 알람 필터링 (Phase 4 Standing Orders 이전 예정)
  dashboard.js — 일일 대시보드 | write.js — 일일 리포트
  mainbot.js — 은퇴한 호환 alias (retired)
```

## 핵심 파일
- **src/router.js** (2,819줄) — 메시지 라우팅 + 의도 분류 + Hub 제어면 위임 (최중요)
- **src/orchestrator.ts** — 현재 source of truth 엔트리
- **src/jay-runtime.ts** — Jay runtime housekeeping loop
- **dist/ts-runtime/bots/orchestrator/src/orchestrator.js** — 실제 운영 런타임 엔트리
- **scripts/experience-store-cli.js** — RAG 경험 저장 CLI (Hub 연동)
- **scripts/enqueue-ska-reservation.js** — 스카팀 예약 등록 exec
- src/mainbot.js — retired alias only (수정 금지, 곧 제거)

## 현재 상태
- Phase 4 진행 중: legacy mainbot alias 축소 + alert resolve Hub 통합.
- experience-store-cli.js 신규 (RAG 자기학습).
- router.js 소스 딥분석 미완료 (잔여 영역).

## 운영 주의
- **router.js 무중단**: 텔레그램 의도분류·팀장 위임의 심장. 변경 시 기존 라우팅 경로 회귀 검증 필수.
- **dist/ vs src/**: 실제 런타임은 dist/ts-runtime/. src 수정 후 빌드 반영 확인.
- **Hub 연동**: 제어면(alert resolve 등)이 Hub(:7788) 경유. Hub 인터페이스 변경 시 동기화.

## 공용 유틸 강제 (신규 코드 필수)
- 시간: packages/core/lib/kst.js | DB: packages/core/lib/pg-pool.js (또는 Hub)
- LLM: packages/core/lib/llm-fallback.js | RAG: packages/core/lib/rag.js
- launchd: StartCalendarInterval은 KST 기준

## 구현 하네스
1. Karpathy 4원칙 (Lean Mode 상속): 최소 변경, 기존 패턴 우선, surgical.
2. 검증 루프: node --check → tsc --noEmit → smoke. 실패 시 3회 자동수정, 3회 실패 시 마스터 보고.
3. 미검증 "완료" 금지.
