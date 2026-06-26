# AGENTS.md — Edu-X팀 (커뮤니티 교육형 시황 게시)

> 이 파일은 OpenAI Codex·Claude Code가 Edu-X팀(bots/edu-x) 작업 시 읽는 가이드다.
> 상위 규칙 상속: 루트 AGENTS.md + ~/.codex/AGENTS.md(Lean Mode). 본 파일은 Edu-X 특화 컨텍스트만 추가한다.

## 역할 경계 (불변)
- **메티(Claude app)** = 전략·설계·코드점검·독립검증. 코드 직접 수정 금지.
- **코덱스(OpenAI Codex)** = 명세 기반 구현과 검증.
- **마스터(제이)** = 승인·git commit·launchd 등록/재시작·secret 변경·실게시 승인. 마스터 전용.
- 절차: 메티 설계 → 코덱스 구현 → 메티 검증 → 마스터 승인.

## ★ 절대 무중단 (PROTECTED)
- 실제 Edu-X 게시, launchd bootstrap/kickstart, secret 변경, DB migration 적용은 명시 승인 없이는 하지 않는다.
- `EDUX_DRY_RUN=true`가 기본이다. 실게시에는 `EDUX_LIVE_PUBLISH_APPROVED=true`, `EDUX_PROMOTION_GATE_PASSED=true`, promotion report PASS가 모두 필요하다.
- PROTECTED 기존 launchd와 Luna/Hub 의존 프로세스는 중단하지 않는다.

## 역할
- Edu-X 자유게시판에 crypto/KIS/overseas 교육형 시황 글을 7개 슬롯으로 생성한다.
- 기본은 이미지 없는 텍스트-only 게시다. 이미지 생성/첨부는 보류 경로이며 별도 승인 없이는 켜지 않는다.
- Luna 데이터, 공개 시장 데이터, Hub LLM Gateway를 사용하고 실패 시 deterministic formatter로 fallback한다.

## 팀 구조와 슬롯
```
Edu-X runtime
  crypto:    06:00 / 14:00 / 22:30 KST
  overseas: 06:30(미국증시 마감) / 22:00(NY 30분 전)
  KIS:      09:00(장시작 30분 전) / 16:00(국내증시 마감)
  daily digest / promotion gate / launchd doctor
```

## 핵심 파일
- **클라이언트**: `lib/edux-client.ts` (JWT, 401 refresh, 429 retryAfter, POST /api/community/posts)
- **포맷터**: `lib/edux-formatter.ts`, `lib/edux-content-safety.ts`, `lib/edux-runtime-support.ts`
- **데이터/fixture**: `lib/edux-fixtures.ts`, `output/*.json`
- **런타임**: `scripts/runtime-edux-crypto-daily.ts`, `scripts/runtime-edux-kis-daily.ts`, `scripts/runtime-edux-overseas-daily.ts`, `scripts/runtime-edux-daily-digest.ts`
- **게이트/운영**: `scripts/edux-promotion-gate.ts`, `scripts/edux-launchd-doctor.ts`, `scripts/check-edux-integration.ts`
- **launchd**: `launchd/ai.edux.*.plist`

## 현재 상태
- 7슬롯 운영 구조가 코드와 plist에 존재한다.
- `edux_publish_log`는 category `crypto|kis|overseas`, schedule_slot `0600|0630|0900|1400|1600|2200|2230`, status `success|fail|skipped|dry_run`을 사용한다.
- 마감 슬롯 `kis:1600`, `overseas:0630`은 휴장/주말 가드와 이전 슬롯 watchPoints 회고 경로를 가진다.
- Hub LLM Gateway를 우선 사용하되, 품질 게이트 실패 또는 Hub 호출 실패 시 deterministic formatter로 자동 fallback한다.

## 운영 주의
- 게시 카테고리는 `free` 고정이다. `activity` 사용 금지.
- 제목은 슬롯 지역명보다 날짜 + 자산/지수 중심으로 생성한다.
- 암호화폐 심볼은 `BTC/USDT`처럼 `BASE/QUOTE` 형식으로 표시한다.
- 내부 소스명과 raw signal은 게시글에 노출하지 않고 독자용 라벨로 변환한다.
- 루나팀 자동매매는 개발/테스트 중인 내부 자동화로만 언급하며 권위 있는 매매 근거처럼 표현하지 않는다.
- live 차단, dry-run artifact, promotion gate, launchd doctor 검증 흐름을 우회하지 않는다.

## 공용 유틸 강제 (신규 코드 필수)
- 시간: packages/core/lib/kst.js
- DB: packages/core/lib/pg-pool.js 또는 Hub 경유
- LLM: packages/core/lib/llm-fallback.js + llm-model-selector.js, Hub client 경유
- RAG/시장 데이터: 기존 Luna/Hub read-only 경로 우선
- launchd: StartCalendarInterval은 KST 기준

## 구현 하네스
1. Karpathy 4원칙 (Lean Mode 상속): 최소 변경, 기존 패턴 우선, surgical, 검증 가능 성공기준.
2. 검증 루프: `node --check [변경파일]` → `smoke:formatter`/`smoke:runtime-fixture`/`smoke:promotion-gate`/관련 슬롯 smoke.
3. 미검증 "완료" 금지. 실제 게시 없이 fixture/dry-run/smoke 산출물로 먼저 검증한다.

## 참조
- `bots/edu-x/SPEC.md`
- `docs/design/EDUX_MARKET_CLOSE_DESIGN_2026-06.md`
- `bots/edu-x/output/edux-promotion-gate.json`
- `bots/edu-x/output/edux-launchd-doctor.json`
