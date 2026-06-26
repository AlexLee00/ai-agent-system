# AGENTS.md — Hub팀 (OPS 리소스 API·제어면)

> 이 파일은 OpenAI Codex·Claude Code가 Hub팀(bots/hub) 작업 시 읽는 가이드다.
> 상위 규칙 상속: 루트 AGENTS.md + ~/.codex/AGENTS.md(Lean Mode). 본 파일은 Hub 특화 컨텍스트만 추가한다.

## 역할 경계 (불변)
- **메티(Claude app)** = 전략·설계·코드점검·독립검증. 코드 직접 수정 금지.
- **코덱스(OpenAI Codex)** = 명세 기반 구현과 검증.
- **마스터(제이)** = 승인·git commit·launchd 재시작·DB write·secret 변경. 마스터 전용.
- 절차: 메티 설계 → 코덱스 구현 → 메티 검증 → 마스터 승인.

## ★ 절대 무중단 (PROTECTED)
- Hub는 OPS 리소스 프록시 서버이자 DEV↔OPS 브릿지다. 장애 시 여러 팀의 DB·secret·상태 조회·알람 흐름이 끊긴다.
- `ai.hub.resource-api` 재시작, secret 변경, 외부 쓰기, DB DDL 적용은 명시 승인 없이는 하지 않는다.
- `/hub/health*` 외 라우트는 인증과 가드를 유지한다. SQL 쓰기 차단을 약화하지 않는다.

## 역할
- 시크릿, DB, 에러, 서비스 상태, agent registry, n8n, legal case API를 단일 API로 제공한다.
- 운영 포트는 `:7788`, 기본 바인딩은 `HUB_BIND_HOST=127.0.0.1` loopback-only다.
- 외부 접근이 필요하면 SSH 터널 또는 Tailscale IP를 명시적으로 사용한다. `0.0.0.0` 바인딩은 예외 상황에서만 사용한다.

## 핵심 파일
- **서버**: `src/hub.ts` (source of truth), `src/app.ts`(Express app), `src/route-registry.ts`(라우트 등록), `src/rate-limiters.ts`, `src/server-hardening.ts`
- **운영 엔트리**: `launchd/ai.hub.resource-api.plist` → `/Users/alexlee/projects/ai-agent-system/dist/daemons/ai.hub.resource-api.mjs`
- **보안/가드**: `lib/auth.ts`, `lib/sql-guard.ts`, `lib/routes/pg.ts`
- **라우트**: `lib/routes/secrets.ts`, `lib/routes/errors.ts`, `lib/routes/health.ts`, `lib/routes/services.ts`, `lib/routes/agents.ts`, `lib/routes/n8n.ts`
- **LLM 경로**: `src/llm-selector.ts`, `lib/llm/*`, `scripts/llm-*`, `migrations/*llm*`
- **운영 검증**: `scripts/*smoke*.ts`, `scripts/runtime-*`, `output/*.json`

## API 엔드포인트
```
GET  /hub/health
GET  /hub/health/live
GET  /hub/health/ready
GET  /hub/health/startup
GET  /hub/secrets/:category
POST /hub/pg/query
GET  /hub/errors/recent
GET  /hub/errors/summary
GET  /hub/services/status
GET  /hub/env
GET  /hub/agents/*
GET  /hub/n8n/workflows
POST /hub/n8n/workflows/:id/run
POST /hub/n8n/webhook/:path
POST /hub/legal/case
GET  /hub/legal/cases
GET  /hub/legal/case/:id
GET  /hub/legal/case/:id/status
POST /hub/legal/case/:id/approve
POST /hub/legal/case/:id/feedback
GET  /hub/legal/case/:id/report
```

## 현재 상태
- launchd `ai.hub.resource-api`는 `/opt/homebrew/bin/node /Users/alexlee/projects/ai-agent-system/dist/daemons/ai.hub.resource-api.mjs`를 실행한다.
- `src/hub.ts` 변경 후 운영 반영 전에는 루트 `npm run build:hub-runtime` 또는 승인된 배포 경로로 `dist/daemons/ai.hub.resource-api.mjs` 갱신 여부를 확인한다.
- readiness는 core service 기준이며 retired gateway catalog entry는 optional/expected-idle로만 보존한다.
- `classification=running|idle|down` 의미를 유지한다. idle은 정상 등록된 비상주/스케줄 대기 상태다.
- LLM 라우팅은 policy engine shadow, promotion gate, provider cooldown, local guard 계열 검증을 포함한다.

## 운영 주의
- `/hub/health/ready`와 `/hub/services/status` 판정 기준을 바꿀 때는 core/idle/retired 구분을 보존한다.
- `lib/sql-guard.ts`는 SELECT/WITH/EXPLAIN만 허용해야 한다. INSERT/UPDATE/DELETE/DROP 차단을 유지한다.
- pg overload guard는 waiting/active 기준으로 503 + Retry-After를 반환한다. 과부하 보호를 약화하지 않는다.
- `secrets-store.json`은 git 미추적 민감 파일이다. 내용 출력, 커밋, 무단 변경 금지.

## 공용 유틸 강제 (신규 코드 필수)
- 시간: packages/core/lib/kst.js
- DB: packages/core/lib/pg-pool.js 또는 Hub route 내부 wrapper
- LLM: packages/core/lib/llm-fallback.js + llm-model-selector.js
- RAG: packages/core/lib/rag.js
- launchd: StartCalendarInterval은 KST 기준

## 구현 하네스
1. Karpathy 4원칙 (Lean Mode 상속): 최소 변경, 기존 패턴 우선, surgical, 검증 가능 성공기준.
2. 검증 루프: `node --check [변경파일]` → 관련 smoke/runtime check → 필요 시 read-only health 확인.
3. 미검증 "완료" 금지. 재시작·secret·DDL·외부 쓰기는 마스터 승인 후만 수행한다.

## 참조
- DEV 클라이언트: `packages/core/lib/hub-client.ts`
- 시크릿 소스: `secrets-store.json` (14섹션, git 미추적)
- 운영 daemon 재생성: repo 루트에서 `npm run build:hub-runtime`
