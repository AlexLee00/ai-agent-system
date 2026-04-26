# Hub — Claude Code 컨텍스트

## 역할
OPS 리소스 프록시 서버. DEV↔OPS 브릿지.
시크릿, DB, 에러, 서비스 상태를 단일 API로 제공.

## 포트
`:7788` (OPS 맥 스튜디오, launchd `ai.hub.resource-api`)

## 네트워크 바인딩
- 기본 바인딩은 `HUB_BIND_HOST=127.0.0.1`
- 운영에선 loopback-only를 기본값으로 유지
- 외부 접근이 필요하면 SSH 터널 또는 Tailscale IP를 명시적으로 사용
- `0.0.0.0` 바인딩은 예외 상황에서만 사용

## 핵심 파일
- `src/hub.ts` — Express 서버 source of truth
- `src/hub.js` — launchd가 직접 타는 source wrapper (`hub.ts` 우선, 실패 시 `hub.legacy.js` 폴백)
- `dist/ts-runtime/bots/hub/src/hub.js` — targeted dist 재생성 대상 (platform pilot 복구용)
- `lib/auth.ts` — Bearer 토큰 인증 미들웨어
- `lib/sql-guard.ts` — SQL 화이트리스트 (SELECT/WITH/EXPLAIN만 허용)
- `lib/routes/secrets.ts` — secrets-store.json 14섹션 제공
- `lib/routes/pg.ts` — PostgreSQL 읽기 전용 쿼리 프록시 + overload guard
- `lib/routes/errors.ts` — /tmp/*.err.log 에러 집계
- `lib/routes/health.ts` — live/ready 포함 헬스 체크
- `lib/routes/services.ts` — launchd 서비스 상태 + 환경 변수
- `lib/routes/agents.ts` — 에이전트 레지스트리 엔드포인트
- `lib/routes/n8n.ts` — n8n 웹훅 프록시 + 워크플로우 관리 API

## API 엔드포인트
```
GET  /hub/health              — 헬스 체크 (인증 불필요)
GET  /hub/health/live         — 프로세스 생존 확인
GET  /hub/health/ready        — 의존성 준비 상태 확인
GET  /hub/health/startup      — 부팅 완료 상태 확인
GET  /hub/secrets/:category   — 시크릿 (14개 카테고리)
POST /hub/pg/query            — PG 읽기 전용 쿼리 (과부하 시 503 + Retry-After)
GET  /hub/errors/recent       — 에러 로그 집계
GET  /hub/errors/summary      — 에러 현황 요약
GET  /hub/services/status     — launchd 서비스 상태
GET  /hub/env                 — 환경 변수 요약
GET  /hub/agents/*            — 에이전트 레지스트리
GET  /hub/n8n/workflows       — n8n 워크플로우 목록 (API 키 기반)
POST /hub/n8n/workflows/:id/run — n8n 워크플로우 실행
POST /hub/n8n/webhook/:path   — n8n 웹훅 프록시
POST /hub/legal/case               — 새 사건 접수 (저스틴팀)
GET  /hub/legal/cases              — 사건 목록 (?status= 필터)
GET  /hub/legal/case/:id           — 사건 상세
GET  /hub/legal/case/:id/status    — 진행 상태 요약 (분석/판례/감정서 수)
POST /hub/legal/case/:id/approve   — 마스터 승인 (status 전환)
POST /hub/legal/case/:id/feedback  — 판결 피드백 등록
GET  /hub/legal/case/:id/report    — 최신 감정서 조회
```

## 운영 해석
- `/hub/health/ready`
  - 코어 서비스(`ai.hub.resource-api`, `ai.n8n.server`) 기준 readiness 신호
  - retired gateway catalog entry는 optional/expected-idle로만 보존하며 readiness 기준에서 제외
  - `readiness_summary.core_service_total`, `core_service_down`, `resource_warn_count` 포함
- `/hub/services/status`
  - 허브가 직접 보는 핵심 launchd 서비스만 반환
  - 각 서비스 row에 `classification`과 `core`가 같이 들어감
  - `classification=running`: 현재 상주 실행 중
  - `classification=idle`: launchd에 정상 등록됐고 현재는 비상주/스케줄 대기 상태
  - `classification=down`: 실제 점검이 필요한 비정상 비가동
- 현재 `idle`로 보는 대표 서비스
  - `ai.claude.dexter`
  - `ai.worker.lead`
  - `ai.worker.task-runner`
  - `ai.investment.crypto`

## 보안
- `/hub/health*` 외 전 라우트 `authMiddleware` 적용
- `HUB_AUTH_TOKEN` Bearer 인증
- sql-guard: INSERT/UPDATE/DELETE/DROP 등 쓰기 차단
- rate limiter: secrets 60rpm, pg 120rpm, 일반 200rpm
- pg overload guard: waiting>5 또는 active>=8 이면 즉시 503 defer

## 참조
- DEV 클라이언트: `packages/core/lib/hub-client.ts`
- 시크릿 소스: `secrets-store.json` (14섹션, git 미추적)
- 현재 상태: launchd는 `src/hub.js` wrapper 기준 운영, dist 런타임은 별도 targeted rebuild 대상
- 런타임 dist 재생성: `npm run build:hub-runtime`
