# Changelog

All notable changes to ai-agent-system will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/).

## 12주차 (2026-03-16 ~ 2026-03-18) — 운영 변수 외부화 + 분석 자동화 정리

### 신규 기능 (feat)
- 워커 웹 관리자 메뉴에 `워커 모니터링` 추가
  - `/admin/monitoring`에서 현재 적용 LLM API 경로와 기본 provider 선택 가능
  - `worker.system_preferences` 테이블로 선택값 저장
  - 최근 24시간 호출 통계와 기본 API 변경 이력까지 확인 가능
  - provider별/경로별 성공률과 평균 응답시간까지 확인 가능
  - provider 변경 사유(note)까지 이력에 함께 저장 가능
  - 최근 변경 전후 12시간 기준 성공률/응답시간 비교 가능
- 팀별 `runtime_config` / `config.json` / `config.yaml` 외부화 체계 추가
  - investment / reservation / ska / worker / orchestrator / claude / blog
- 팀별 운영 설정 조회 스크립트 추가
  - `scripts/show-runtime-configs.js`
- 팀 운영 설정 가이드 문서 추가
  - `docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md`
- 스카 매출 예측 일일/주간 리뷰 스크립트 운영 기준 외부화
- 워커 웹 프론트 timeout/runtime 설정 외부화
  - auth timeout / release buffer / ws reconnect delay
- 스카 예측 shadow 비교 모델 추가
  - `knn-shadow-v1`를 `forecast_results.predictions`에 별도 저장
  - 기존 예측 엔진과 독립 비교 가능한 shadow 관찰 구조 추가
- 워커 문서 재사용 추적 고도화
  - `/documents`, `/documents/[id]` 상세
  - 문서 재사용 이벤트 저장
  - 업무 생성 결과 연결 및 문서별 재사용 성과 집계

### 변경 사항 (changed)
- 투자팀 운영 모드 용어 정리
  - `executionMode = live/paper`
  - `brokerAccountMode = real/mock`
  - 암호화폐는 `brokerAccountMode=real`만 사용하도록 기준 고정
- 루나팀 실행 모드 / `[PAPER]` 태그 / 브로커 표현을 공용 헬퍼 기준으로 통합
  - 암호화폐와 국내외장은 분리 유지하되 한 곳에서 관리
- 국내/해외장 로그 문구를 실제 KIS 모의투자 상태 기준으로 정리
- 자동매매 일지와 주간 리뷰에 `암호화폐 / 국내장 / 해외장` 섹션 강제 분리
- 블로그 생성 임계치와 maestro 관련 timeout/cooldown을 설정 파일에서 조정 가능하게 변경
- 스카 일일/주간 예측 리뷰가 `primary vs shadow` 비교와 promotion 판단을 읽도록 확장
- 일일 운영 분석 리포트 입력 스크립트를 `daily-ops-report.js` 기준으로 정리
- 구현 추적 문서 이름을 `PLATFORM_IMPLEMENTATION_TRACKER.md`로 정리하고 세션 인덱스/팀 문서 링크를 갱신
- 세션 문서 체계를 기존 문서 중심으로 재정리
  - `SESSION_CONTEXT_INDEX.md`
  - `WORK_HISTORY.md`
  - `RESEARCH_JOURNAL.md`
- 제이 모델 정책을 `orchestrator/config.json > runtime_config.jayModels`와 연결
  - OpenClaw 기본 모델과 제이 앱 커스텀 모델을 운영 설정 문맥에서도 분리
  - `/jay-models`와 자연어 질의로 현재 모델 체계를 바로 조회 가능하게 추가

### 버그 수정 (fix)
- 투자 실패 원인 저장 구조 확장
  - `block_reason` + `block_code` + `block_meta`
  - `backfill-signal-block-reasons.js`로 과거 `legacy_*` 실패 이력까지 구조화 백필
  - 자동매매 일지에 시장별 `실패 코드 요약` 추가
- 주간 자동매매 리뷰 입력 강인성 보강
  - 보조 입력 실패 시 전체 리포트 중단 대신 가능한 범위에서 계속 진행
- 덱스터 shadow mismatch 완화
  - 저위험 코드 무결성 이슈(`git 상태`, `git 변경사항`, `체크섬`)의 `monitor ↔ ignore`는 `soft match`로 재해석
- KIS 국내/해외장 주문 금액 단위 보정
  - 국내는 `KRW`, 해외는 `USD` 기준으로 clamp
- 국내/해외 모의투자 경로에서 장외 시간/최소 주문 수량 검증 흐름 점검
- 덱스터 false positive 완화
  - `고아 Node` 판정 오탐 축소
  - `Swap` 경고 기준 현실화
  - `forecast_results` 누락을 필수 오류에서 분리
- 덱스터 AI 진단 문구를 낮은 심각도 이슈에 과장되지 않도록 보수화
- 일일 운영 분석 리포트가 `fallback_probe_unavailable`을 장애처럼 다루지 않도록 보정

### 문서 (docs)
- 워커 모니터링 진입점과 투자 실행 모드 기준을 세션 문서/팀 문서에 반영
- 워커 모니터링 운영 지표와 `018-monitoring-history`, `019-monitoring-change-notes` 마이그레이션 경로를 팀 참조 문서/구현 추적 문서에 반영
- 투자팀 참조 문서에 `legacy_order_rejected`, `legacy_executor_failed` 코드와 백필 스크립트 경로 반영
- 제이 모델 정책 확인 순서를 런북/세션 인덱스/팀 참조 문서에 반영
- 팀 운영 변수 관리 체계 문서화
- 운영 중 조정 가능한 값과 추가 개발 후보 정리
- 세션 인덱스/팀 참조 문서/구현 추적 문서 이름 정리 및 참조 링크 갱신
- 세션 문서 역할 재정리 및 링크 정합성 갱신

### 추가 개발 후보
- `runtime_config` 변경 후보를 일일/주간으로 제안하는 자동화 고도화
- `worker`, `orchestrator`, `claude` 운영 설정 변경 이력 추적
- 제이/전체 운영 분석 리포트와 설정 튜닝 제안의 통합 정리
- 스카 shadow 비교 데이터 누적 후 `ensemble experiment` 승격 여부 판단

---

## 10~11주차 (2026-03-11 ~ 2026-03-15) — 228 커밋

### 신규 기능 (feat)
- KST 시간 유틸리티 (packages/core/lib/kst.js) + 전 팀 적용
- 소스코드 접근 제한 (file-guard.js + autofix 범위 제한)
- 루나 노드화 파이프라인 (L10~L34 스캐폴딩)
- 루나 매매일지 자동 리뷰 + 엑스커전 메트릭
- 루나 장외시간 리서치 모드 + 워치리스트
- 스카 예측 캘리브레이션 + 피처스토어 + 모멘텀
- 워커 WebSocket 실시간 채팅 + 태스크 큐 + 승인
- 제이 인텐트 자동 프로모션 + 롤백 + 감사 추적
- 통합 OPS 헬스 대시보드 (전체 팀 현황)
- 팀별 헬스 리포트 (루나/스카/클로드/워커/블로)

### 버그 수정 (fix)
- KNOWN ISSUES 5개 (mini 폴백 + screening DB + XSS + gemini maxTokens)
- launchd plist UTC→KST 로컬 시간 수정 (블로그 Hour=21→6)
- 루나 스크리닝 폴백 + 신선도 체크
- 스카 예측 정합성 + 정확도 중복 제거
- 제이 인텐트 스키마 정합 + 팀간 안정화
- 워커 웹 모바일 버그 4종 (SSE→XHR, 툴칩, 채팅 중복, 스크롤)
- 워커 웹 채팅 메시지 버블 병합 (tool 사이여도 단일 버블)

### 문서 (docs)
- CLAUDE.md 공통 원칙 8개 추가
- kst.js 사용 규칙 + launchd 시간 규칙

### 리팩터링 (refactor)
- 공유 헬퍼 통합 (헬스리포트 + 프로바이더 + 포맷터)
- 인텐트 스토어 공유 (전 팀 커맨더 연결)
- 스카 레거시 코드 정리

---

## [2026-03-11] — 전 팀 LLM 모델 최적화 + 스크리닝 장애 대응

### Added
- **screening-monitor.js** (루나팀): 아르고스 스크리닝 연속 실패 추적 + 3회 이상 텔레그램 알림
- **loadPreScreenedFallback()** (pre-market-screen.js): 24h TTL RAG 폴백 — 아르고스 실패 시 마지막 성공 결과 재사용
- **callOpenAIMini()** (llm-client.js): gpt-4o-mini 전용 호출 함수
- **MINI_FIRST_AGENTS** (llm-client.js): hermes/sophia/zeus/athena → gpt-4o-mini 메인 라우팅

### Changed
- `llm-client.js`: GROQ_AGENTS `[nemesis,oracle,athena,zeus]` → `[nemesis,oracle]` / callGroq 폴백 gpt-4o→gpt-4o-mini
- `pos-writer.js`, `gems-writer.js`: LLM 폴백 체인 2순위 gpt-oss-20b → gpt-4o-mini
- `star.js`: 단일 체인 → gpt-4o-mini + llama-4-scout 폴백
- `claude-lead-brain.js`: LLM_CHAIN claude-sonnet 제거 → gpt-4o → gpt-4o-mini → scout
- `archer/config.js`: OPENAI.model gpt-4o → gpt-4o-mini
- `domestic.js`, `overseas.js`, `crypto.js`: 아르고스 RAG 폴백 + screening-monitor 연동

---

## [2026-03-10] — 블로그팀 장문 출력 극대화

### Added
- **Continue 이어쓰기 패턴**: 1차 호출 글자수 부족 시 자동 2차 호출 (pos/gems)
- **_THE_END_ 마커**: 시스템 프롬프트에 완성 신호 강제 지시
- **exhaustive 키워드**: comprehensively / in-depth / thoroughly 장문 유도

### Fixed
- temperature 조정: pos 0.75→0.82 / gems 0.80→0.85
- 글자수 기준 상향: 강의 MIN 9,000/GOAL 10,000 / 일반 MIN 5,000/GOAL 7,000

### Result
- 강의 포스팅: 최대 10,225자 달성 (이전 ~8,122자)

---

## [2026-03-10] — 블로그팀 분할 생성 + llm-keys 통합

### Added
- **chunked-llm.js** (packages/core): Gemini Flash / GPT-4o 분할 생성 공용 유틸
- **writeLecturePostChunked()**: 강의 포스팅 4청크 분할 생성
- **writeGeneralPostChunked()**: 일반 포스팅 3청크 분할 생성
- **BLOG_LLM_MODEL 환경변수**: `gemini`(무료 분할) / `gpt4o`(유료 단일) 전환

### Fixed
- `pos-writer`, `gems-writer`, `chunked-llm`: OpenAI 키를 `getOpenAIKey()` (llm-keys 폴백) 로 통일
- 글자수 기준 실측 기반 재조정: 강의 MIN 7,000 / 일반 MIN 4,500

---

## [2026-03-09] — 블로그팀 Phase 1 완전체

### Added
- **블로그팀 5봇**: blo(팀장) + richer(리서치) + pos(강의작성) + gems(일반작성) + publ(퍼블리셔)
- **blog 스키마 5테이블**: posts / category_rotation / curriculum / research_cache / daily_config
- **Node.js 120강 커리큘럼** 시딩 완료
- **ai.blog.daily launchd**: 매일 06:00 KST 자동 실행
- **팀 제이 핵심 기술 15종 통합**: RAG/MessageEnvelope/trace_id/tool-logger/StateBus/llm-cache/mode-guard/AI탐지리스크/GEO+AEO/ai-agent-system컨텍스트/RAG실전에피소드/내부링킹/리라이팅가이드/포럼토픽/Registry등록
- **rag_blog 컬렉션** (pgvector): 과거 포스팅 중복 방지 + 내부 링킹용
- **publ.js 구글드라이브 자동 저장**: `/010_BlogPost` 폴더 동기화

### Fixed
- pos-writer max_tokens 8000 → 16000 (글자수 부족 해결)
- 섹션별 최소 글자수 userPrompt 명시 (GPT-4o 출력 유도)
- 글자수 기준 실측 기반 조정: lecture 7,000자 / general 3,500자

## [2026-03-08] — 제이 자연어 능력 향상 v2.0

### Added
- **intent-parser.js**: Intent 53개 (기존 36 + 17 신규), 슬래시 명령 7개 추가
- **CoT + Few-shot 프롬프트**: 2단계 Chain-of-Thought + 10개 예시 + 동적 DB 주입
- **`loadDynamicExamples()`**: unrecognized_intents DB에서 5분 캐시 동적 Few-shot 주입
- **unrecognized_intents 테이블** (claude 스키마): 미인식 명령 자동 기록
- **chat 폴백 2단계**: TEAM_KEYWORDS → delegateToTeamLead → geminiChatFallback
- **17개 신규 router 핸들러**: Shadow, LLM 졸업, 투자 일지, 덱스터 즉시 실행 등
- **`promoteToIntent()`**: 미인식 명령 → nlp-learnings.json 즉시 승격 + 5분 내 자동 반영
- **HELP_TEXT v2.0**: 전체 명령 + 자동학습 섹션 추가

### Fixed
- ska_query 패턴 bare `|통계` 제거 → "캐시 통계" 오매칭 버그 수정
- OpenClaw `openclaw.json` `agents.teamLeads` 미인식 키 → `openclaw doctor --fix` 제거

---

## [Unreleased]

---

## [v3.3.0] - 2026-03-07 — PostgreSQL 단일 DB 통합 마이그레이션

### Changed
- **DB 아키텍처 전면 통합**: SQLite 2종 + DuckDB 2종 → PostgreSQL 17 단일 DB (`jay`)
  - `~/.openclaw/workspace/state.db` → `reservation` 스키마
  - `~/.openclaw/workspace/claude-team.db` → `claude` 스키마
  - `bots/investment/db/investment.duckdb` → `investment` 스키마
  - `bots/ska/db/ska.duckdb` → `ska` 스키마

### Added
- **`packages/core/lib/pg-pool.js`**: Node.js PostgreSQL 커넥션 풀 싱글톤
  - 스키마별 `search_path` 자동 설정
  - `?` → `$N` 파라미터 자동 변환
  - `prepare()` → `run/get/all()` better-sqlite3 호환 API
- **`bots/ska/scripts/setup-db.py`**: ska PostgreSQL 스키마 초기화 (5개 테이블)

### Removed
- `duckdb` npm 패키지 (`bots/investment`) — KI-003 취약점 해결
- `better-sqlite3` npm 패키지 (`bots/reservation`, `bots/orchestrator`)
- `duckdb==1.2.0` pip 패키지 (`bots/ska`)

### Fixed
- **KI-003**: duckdb→node-gyp→tar npm audit high 취약점 — duckdb 완전 제거로 해결

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
# 2026-03-18

- 오케스트레이터
  - `jay-model-policy.js` 신규
  - 제이 모델 체계를 `OpenClaw gateway 기본 모델`과 `제이 앱 레벨 커스텀 모델 정책`으로 분리
  - `intent-parser.js`, `router.js`가 제이 모델 정책 파일을 공통 참조하도록 정리
- 운영 리뷰
  - `error-log-daily-review.js`에 `최근 3시간 활성 오류`와 `하루 누적 오류`를 분리
  - 종료된 `OpenClaw gateway rate limit`이 현재 장애처럼 과장되지 않도록 보정
- 투자
  - `onchain-data.js`에서 비정상 `nextFundingTime` 방어 추가
  - `PEPEUSDT Invalid time value` 로그 노이즈 완화
