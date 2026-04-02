# Hub — Claude Code 컨텍스트

## 역할
OPS 리소스 프록시 서버. DEV↔OPS 브릿지.
시크릿, DB, 에러, 서비스 상태를 단일 API로 제공.

## 포트
`:7788` (OPS 맥 스튜디오, launchd `ai.hub.resource-api`)

## 핵심 파일
- `src/hub.js` — Express 서버 진입점, 라우트 등록
- `lib/auth.js` — Bearer 토큰 인증 미들웨어
- `lib/sql-guard.js` — SQL 화이트리스트 (SELECT/WITH/EXPLAIN만 허용)
- `lib/routes/secrets.js` — secrets-store.json 14섹션 제공
- `lib/routes/pg.js` — PostgreSQL 읽기 전용 쿼리 프록시
- `lib/routes/errors.js` — /tmp/*.err.log 에러 집계
- `lib/routes/health.js` — 헬스 체크
- `lib/routes/services.js` — launchd 서비스 상태 + 환경 변수
- `lib/routes/agents.js` — 에이전트 레지스트리 엔드포인트
- `lib/routes/n8n.js` — n8n 웹훅 프록시

## API 엔드포인트
```
GET  /hub/health              — 헬스 체크 (인증 불필요)
GET  /hub/secrets/:category   — 시크릿 (14개 카테고리)
POST /hub/pg/query            — PG 읽기 전용 쿼리
GET  /hub/errors/recent       — 에러 로그 집계
GET  /hub/errors/summary      — 에러 현황 요약
GET  /hub/services/status     — launchd 서비스 상태
GET  /hub/env                 — 환경 변수 요약
GET  /hub/agents/*            — 에이전트 레지스트리
```

## 보안
- `/hub/health` 외 전 라우트 `authMiddleware` 적용
- `HUB_AUTH_TOKEN` Bearer 인증
- sql-guard: INSERT/UPDATE/DELETE/DROP 등 쓰기 차단
- rate limiter: secrets 30rpm, pg 60rpm, 일반 120rpm

## 참조
- DEV 클라이언트: `packages/core/lib/hub-client.js`
- 시크릿 소스: `secrets-store.json` (14섹션, git 미추적)
- 현재 상태: 운영 안정 (7카테고리 200 OK 확인)
