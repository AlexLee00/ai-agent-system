# AGENTS.md — 스카팀 (예약·키오스크·매출)

> 이 파일은 OpenAI Codex·Claude Code가 스카팀(bots/reservation) 작업 시 읽는 가이드다.
> 상위 규칙 상속: 루트 AGENTS.md + ~/.codex/AGENTS.md(Lean Mode). 본 파일은 특화 컨텍스트만 추가한다.
> 참고: 디렉토리명은 reservation이나 팀명은 "스카팀". 하위 모듈 일부는 bots/ska/.

## 역할 경계 (불변)
- **메티(Claude app)** = 전략·설계·코드점검·독립검증. 코드 직접 수정 금지.
- **코덱스(OpenAI Codex)** = 명세 기반 구현.
- **마스터(제이)** = 승인·git commit·launchctl·DB write. 마스터 전용.
- 절차: 메티 설계 → 코덱스 구현 → 메티 검증 → 마스터 승인.

## ★★ 절대 무중단 (PROTECTED — 실매출 직결!)
- 스카팀은 **실제 스터디카페 매출·예약 운영** — 중단 시 직접 매출 손실·고객 영향.
- launchd `ai.ska.*` 직접 중지 절대 금지. 네이버 예약·픽코 키오스크 모니터 무중단.
- 예약/매출 로직 변경은 극도로 신중. shadow/dry-run 우선, 마스터 승인 필수.

## 팀 구조
```
스카(팀장)
  앤디(andy) — 네이버 예약 모니터
  지미(jimmy) — 픽코(Pickko) 키오스크 모니터
  레베카(rebecca) — 매출 분석
  포캐스트(forecast) — 매출 예측
  대시보드 (:3031)
```

## 핵심 파일
- **auto/monitors/**: naver-monitor.ts (네이버 예약), pickko-kiosk-monitor.ts (키오스크)
- **bots/ska/src/**: forecast.py (매출예측), rebecca.py (매출분석), runtime_config.py
- **lib/**: ska-read-service.ts, runtime-config.ts
- 대시보드: 포트 :3031

## 현재 상태
- 운영 안정. n8n 5개 워크플로우 연동.
- 실매출 무중단 가동 중.

## 운영 주의 (실매출 — 최고 신중)
- **무중단 최우선**: 예약·키오스크·매출 모니터는 실제 영업에 직결. 어떤 변경도 영업 중단 0 보장.
- **dry-run 우선**: 신규/변경 기능은 dry-run 모드로 먼저 검증 → 마스터 승인 후 실가동.
- **n8n 연동 주의**: 5개 워크플로우와 정합. n8n 자격증명 에러 이력 있음(PostgreSQL/Telegram).
- **장시간 가드**: 영업시간 외 동작 주의. 키오스크 실물 연동 고려.

## 공용 유틸 강제 (신규 코드 필수)
- 시간: packages/core/lib/kst.js | DB: packages/core/lib/pg-pool.js (또는 Hub)
- LLM: packages/core/lib/llm-fallback.js | RAG: packages/core/lib/rag.js
- launchd: StartCalendarInterval은 KST 기준

## 구현 하네스
1. Karpathy 4원칙 (Lean Mode 상속): 최소 변경, 기존 패턴 우선, surgical.
2. 검증 루프: node --check (TS) / python -m py_compile (PY) → smoke. 실패 시 3회 자동수정, 3회 실패 시 마스터 보고.
3. 미검증 "완료" 금지. ★실매출이므로 검증 없이 절대 완료 보고 금지.

## 참조: docs/dev/SKA_*.md (9개 운영 문서)
