# 시스템 보완점 분석 — OpenHarness 외 현대 에이전트 프레임워크 대비

> 작성: 메티 (Claude Opus 4.6)
> 작성일: 2026-04-06
> 분석 대상: HKUDS/OpenHarness, MaxGfeller/open-harness, AutoGPT, CrewAI, Dify, LangChain
> 분류: 전략 문서

---

## 1. 분석 범위

OpenHarness 생태계 5개 프로젝트 + 주요 에이전트 프레임워크 대비
팀 제이 ai-agent-system의 구조적 보완점 15개 식별.

---

## 2. P0 — 즉시 보완 필요 (3건)

### P0-1: 테스트 커버리지 거의 없음

```
현재: 테스트 파일 1개 (auth.test.js)만 존재
벤치마크: OpenHarness pytest 스위트, AutoGPT 포괄적 테스트
위험: 리팩터링/기능 추가 시 회귀 버그 감지 불가
영향: 121에이전트 시스템에서 사일런트 버그 = 운영 장애

보완:
  Phase 1: hiring-contract.js 테스트 (selectBestAgent, evaluate)
  Phase 2: llm-fallback.js 테스트 (chain, timeout, fallback)
  Phase 3: pg-pool.js, openclaw-client.js 테스트
  Phase 4: 각 팀 핵심 로직 테스트
  도구: Node.js built-in test runner 또는 vitest
```

### P0-2: 에이전트 간 통신 프로토콜 없음

```
현재: 에이전트 간 직접 통신 경로 없음 (DB 폴링 또는 Hub API 경유만)
벤치마크: OpenHarness coordinator, Google A2A, AutoGPT agent-to-agent
위험: 121 에이전트 데이터 교환 시 비효율, 실시간 협업 불가

보완:
  방안 A: PostgreSQL LISTEN/NOTIFY (추가 인프라 불필요!)
    → 에이전트가 채널 구독, 이벤트 발행
    → pg-pool.js에 pub/sub 래퍼 추가
  방안 B: 경량 이벤트 버스 (packages/core/lib/event-bus.js)
    → in-process 이벤트 + DB 영속화
  추천: 방안 A (PostgreSQL 단일화 원칙 유지)
```

### P0-3: 권한/안전장치 체계 미흡

```
현재: DEV/OPS 분리 + 닥터 블랙리스트만
      에이전트별 권한 scope 정의 없음
벤치마크: OpenHarness 3단계 권한 (default/trust/deny)
         + path_rules + denied_commands
위험: 에이전트가 의도치 않은 DB 쓰기, 파일 삭제 가능

보완:
  packages/core/lib/agent-permissions.js (신규)
  에이전트별 scope: { read: [...], write: [...], execute: [...] }
  예: pipe(sigma) = { read: ['*'], write: ['sigma.*'], execute: ['SELECT'] }
  예: sweeper(luna) = { read: ['luna.*'], write: ['luna.wallets'], execute: [] }
```

---

## 3. P1 — 이번 달 내 보완 (4건)

### P1-4: 타입 안전성 부재

```
현재: TypeScript 파일 4개뿐, 순수 JS 전체
벤치마크: MaxGfeller/open-harness 완전 TypeScript
위험: 리팩터링 시 타입 에러 런타임 발견

보완:
  단계적 접근 (TypeScript 전환 대신):
  Phase 1: packages/core/lib/*.d.ts 타입 정의 파일 추가
  Phase 2: JSDoc @typedef/@param/@returns 강화
  Phase 3: tsconfig.json checkJs:true (JS에서 타입 체크)
```

### P1-5: 구조화된 로깅 없음

```
현재: console.log/warn/error 167회 산재, 포맷 표준 없음
벤치마크: OpenHarness 구조화 로깅 + 이벤트 추적
위험: 프로덕션 디버깅 어려움, 시그마팀 분석 데이터 품질 저하

보완:
  packages/core/lib/logger.js (신규)
  { level, timestamp, team, agent, message, meta }
  → console.* 전부 logger.* 로 교체
  → 시그마팀 pipe가 수집하기 쉬운 JSON 포맷!
  → 로그 레벨: debug/info/warn/error/fatal
```

### P1-6: 컨테이너화 없음

```
현재: macOS launchd 직접 실행, 다른 환경 이식 불가
벤치마크: Dify docker-compose 한 줄 실행
위험: 맥 스튜디오 장애 시 빠른 복구 불가

보완:
  당장은 불필요 (Apple Silicon MLX 최적화)
  중장기: docker-compose.yml 정의만 준비
  → PostgreSQL + Hub + 핵심 서비스 컨테이너화
  → 재해 복구 시간 단축
```

### P1-7: 플러그인/확장 시스템 없음

```
현재: 스킬 시스템 31파일 있지만 외부 플러그인 미지원
벤치마크: OpenHarness 12개 플러그인 + hooks 시스템
위험: 새 기능 추가 시 코어 코드 수정 필요

보완:
  스킬 시스템 확장 → 플러그인 시스템
  hooks: PreTaskRun / PostTaskRun / OnError / OnComplete
  플러그인 인터페이스: { name, version, hooks, skills, tools }
  → 코어 코드 변경 없이 기능 추가 가능!
```

---

## 4. P2 — 분기 내 보완 (6건)

### P2-8: MCP 서버 역할 미약

```
현재: MCP 파이프라인 2파일 (클라이언트 역할만)
      우리가 MCP 서버를 제공하지 않음
기회: 우리 RAG/경험 데이터를 MCP 서버로 외부 제공!
      → 데이터 자산화의 실질적 첫 단계!
보완: packages/core/lib/mcp/mcp-server.js (신규)
```

### P2-9: 버전 관리 미흡

```
현재: package.json "version": "1.0.0" 고정, CHANGELOG 없음
보완: semantic versioning + CHANGELOG.md 자동 생성
     conventional commits + standard-version
```

### P2-10: 크로스 세션 메모리 제한적

```
현재: blog-rag-store (세션 기반), 에이전트 간 공유 메모리 없음
보완: experience_record 스키마 구현 (이미 설계 완료!)
     + 에이전트별 메모리 저장소
```

### P2-11: 레이트 리밋/코스트 추적 부분적

```
현재: llm-logger.js 있지만 통합 대시보드 없음
보완: 시그마팀 canvas가 LLM 호출 비용 대시보드 생성
```

### P2-12: 에러 핸들링 표준화 부재

```
현재: try-catch 31회, 각각 다른 패턴, 중앙 에러 핸들러 없음
보완: packages/core/lib/error-handler.js (신규)
     { code, team, agent, recoverable, action }
```

### P2-13: 백업/복구 스카팀만

```
현재: reservation/backup-db.js만 존재, 전체 시스템 백업 없음
위험: PostgreSQL 장애 시 전체 데이터 손실
보완: pg_dump 일일 자동 백업 + 복구 절차 문서화
     launchd: ai.system.daily-backup
```

---

## 5. P3 — 장기 개선 (4건)

### P3-14: 벤치마크/평가 프레임워크 없음
### P3-15: 웹 대시보드 미완성
### P3-16: 문서 자동 생성 (JSDoc → API docs)
### P3-17: 멀티 머신 스케일아웃 대비

---

## 6. 우리만의 강점 (보완 불필요)

```
✅ 121 에이전트 실전 24/7 프로덕션 (5개월+!)
✅ 3중 피드백 루프 (L1/L2/L3) — 어디에도 없는 구조
✅ 자율 고용 시스템 (ε-greedy)
✅ 자율 연구팀 (Darwin — arXiv/HF 자동 스캔→적용)
✅ 데이터 자산화 전략 (5대 라벨 + 거래 준비)
✅ $0 비용 (로컬 LLM 완전 전환)
✅ 136개 마이그레이션 (성숙한 DB 스키마)
✅ 3역할 아키텍처 (메티/코덱스/제이)
✅ 12 텔레그램 토픽 (10팀 완전 라우팅)
```

---

## 7. 보완 로드맵

```
이번 주:
  P0-1 핵심 모듈 테스트 시작 (hiring-contract)
  P1-5 중앙 로거 도입 (logger.js)

이번 달:
  P0-2 PostgreSQL LISTEN/NOTIFY 이벤트 버스
  P0-3 에이전트별 권한 scope 정의
  P1-12 에러 핸들러 표준화
  P2-13 전체 시스템 백업 전략

분기:
  P1-4 JSDoc + .d.ts 타입 정의
  P1-7 플러그인/hooks 시스템
  P2-8 MCP 서버 제공 (데이터 자산화!)
  P2-9 버전 관리 + CHANGELOG
  P2-10 experience_record 구현
```

---

## 8. 리서치 출처

```
[1] HKUDS/OpenHarness (4.1K⭐, 2026-04-01, Python, MIT)
[2] MaxGfeller/open-harness (TypeScript SDK, Vercel AI SDK 기반)
[3] zhijiewong/openharness (터미널 코딩 에이전트, Ollama 지원)
[4] Open-Harness/open-harness (워크플로우 테스트, Recording/Replay)
[5] philo-kim/openharness (세션 디스커버리 MCP 서버, 한국인)
[6] thu-nmrc/OpenHarness-For-Codex (칭화대, Codex CLI 특화)
[7] AutoGPT (177K⭐), CrewAI, Dify (90K⭐), LangChain (112K⭐)
[8] GitHub Blog "How to write a great agents.md" (2025.11)
```

---

## 9. Claude Code 소스 코드 분석 기반 추가 보완점 (2026-04-06)

> 출처: 위키독스 "별첨 91. 클로드 코드 소스 코드 분석서"
> 분석 대상: Claude Code 1,884 TypeScript 파일 전체 아키텍처
> 상세: docs/research/RESEARCH_CLAUDE_CODE_ANALYSIS.md (299줄)

### Claude Code 8대 설계 패턴 vs 팀 제이 갭 분석

```
패턴                    Claude Code              팀 제이        갭
────────────────────   ────────────            ──────────     ────
Generator Streaming    query() yields           ❌ 없음       A
Feature Gate           빌드 시 dead code 제거   ❌ 없음       ─
Memoized Context       Git/CLAUDE.md 캐시       ✅ 부분적     ─
Withhold & Recover     에러 보류+자동 복구       ❌ 없음       G
Lazy Import            순환 의존 방지            ✅ 부분적     ─
Immutable State        DeepImmutable            ❌ 없음       장기
Crash Resilience       쿼리 전 저장             ✅ 부분적     ─
Dependency Injection   테스트를 위한 DI          ❌ 없음       P0-1
```

### 추가 식별 보완점 (A~H)

| ID | 항목 | 심각도 | 대상 시기 | 상세 |
|----|------|--------|-----------|------|
| CC-A | 통합 에이전트 루프 엔진 | P2 | 분기 | 모든 팀의 에이전트가 동일한 agent-loop.js 위에서 동작 |
| CC-B | 훅 시스템 (Pre/PostTaskRun) | P1 | 이번 달 | 시그마팀 PostTaskRun 훅으로 데이터 자동 수집! P1-7 연계 |
| CC-C | 에이전트 동시성 분류 | P2 | 분기 | 읽기=병렬(최대10개), 쓰기=순차. agent_registry에 concurrencySafe 추가 |
| CC-D | 에이전트 권한 scope | P0 | 이번 달 | { read, write, execute } 에이전트별 scope. P0-3 강화! |
| CC-E | 에이전트 컨텍스트 관리 | P2 | 분기 | 장기 실행 에이전트 토큰 자동 요약 (auto-compact) |
| CC-F | experience_record "why" 필드 | P1 | 이번 주 | 결과만 저장 → 의사결정 근거(why+how_to_apply)까지! |
| CC-G | 에러 보류+복구 패턴 | P1 | 이번 주 | 에러 즉시 throw ❌ → 자동 복구 시도 후 실패 시만 표면화. P2-12 강화 |
| CC-H | 리더-워커 4단계 패턴 | P2 | 분기 | Research→Synthesis→Implement→Verify. 시그마팀 일일 사이클 매핑 |

### 5대 인사이트

```
① 도구 풀 순서 → 비용: 스킬 등록 순서를 알파벳순 고정 → 캐시 안정성
② 대형 결과 디스크 저장: maxResultSizeChars 초과 → 디스크 저장, 참조만 전달
③ 비용 추적 세분화: 모델별 입력/출력/캐시 토큰 실시간 추적
④ 서킷 브레이커 확대: 자동 압축/LLM fallback에도 연속 실패 제한
⑤ Bash 보안 fail-closed: Tree-sitter AST 분석, 허용 목록만 통과
```

---

## 10. 통합 보완점 로드맵 (OpenHarness + Claude Code 통합)

```
이번 주 (즉시):
  P0-1  테스트 커버리지 (hiring-contract부터) ← DI 패턴 도입
  P1-5  구조화된 로깅 (logger.js)
  CC-F  experience_record "why" 필드 추가
  CC-G  에러 보류+복구 패턴 (error-recovery.js)

이번 달:
  P0-2  에이전트 간 통신 (pg LISTEN/NOTIFY)
  P0-3  에이전트별 권한 scope ← CC-D 통합!
  CC-B  훅 시스템 (Pre/PostTaskRun) ← P1-7 통합!
  P2-12 에러 핸들링 표준화 ← CC-G 통합!
  P2-13 전체 시스템 백업

분기:
  P1-4  타입 안전성 (JSDoc + .d.ts)
  CC-A  통합 에이전트 루프 엔진 (agent-loop.js)
  CC-C  에이전트 동시성 분류
  CC-H  리더-워커 4단계 (시그마팀)
  P2-8  MCP 서버 제공
  P2-9  버전 관리 + CHANGELOG
  P2-10 experience_record 구현
  CC-E  에이전트 컨텍스트 관리

장기:
  P1-6  컨테이너화 (docker-compose)
  P3-14 벤치마크/평가 프레임워크
  P3-15 웹 대시보드
  P3-16 문서 자동 생성
  P3-17 멀티 머신 스케일아웃
```

---

## 11. 리서치 출처 (통합)

```
OpenHarness 생태계:
  [1] HKUDS/OpenHarness (4.1K⭐, 2026-04-01, Python, MIT)
  [2] MaxGfeller/open-harness (TypeScript SDK, Vercel AI SDK)
  [3] zhijiewong/openharness (터미널 코딩 에이전트, Ollama)
  [4] Open-Harness/open-harness (워크플로우 테스트, Recording/Replay)
  [5] philo-kim/openharness (세션 디스커버리 MCP 서버)
  [6] thu-nmrc/OpenHarness-For-Codex (칭화대)

에이전트 프레임워크:
  [7] AutoGPT (177K⭐), CrewAI, Dify (90K⭐), LangChain (112K⭐)
  [8] GitHub Blog "How to write a great agents.md" (2025.11)

Claude Code 소스 분석:
  [9] 위키독스 "별첨 91. 클로드 코드 소스 코드 분석서" (2026-04-01)
      1,884 TypeScript 파일, 8대 설계 패턴, 10개 서브시스템
```
