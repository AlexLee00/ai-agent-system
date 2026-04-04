# 팀별 심층 딥 분석 — CC 아키텍처 비교

> 작성: 메티 (Claude Opus 4.6)
> 작성일: 2026-04-04
> 참조: RESEARCH_AGENT_HARNESS.md (417줄), RESEARCH_CLAUDE_CODE_LEAK.md (391줄)
> 범위: 코어 + 오케스트레이터 + 루나 + 클로드팀 (1차분)

---

## 1. 코어 모듈 심층 분석 (13,973줄/63파일)

### 1-1. LLM 폴백 체인 (llm-fallback.js, 687줄)

```
CC 패턴: QueryEngine.ts 46,000줄
  - MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
  - 서킷 브레이커
  - 프롬프트 캐시 14 벡터 추적
  - 지수 백오프 + 재시도

TJ 현황: llm-fallback.js 687줄
  ✅ 4단계 폴백 체인 (anthropic→openai→groq→gemini+로컬)
  ✅ billingGuard 긴급 차단
  ✅ _recordModelEval 평가 기록
  ✅ traceCollector 추적
  ✅ runtimeProfile 팀별 라우팅
  ❌ 연속 실패 제한 없음! (chain 전체 소진 시 throw만)
  ❌ 세션 레벨 실패 카운터 없음
  ❌ 지수 백오프 없음
  ❌ 프롬프트 캐시 최적화 없음
  ❌ 서킷 브레이커 없음 (billingGuard는 수동 차단만)

개선안 코드 스케치:

  // llm-fallback.js 상단에 추가
  const _sessionFailures = new Map(); // agentName → 연속 실패 수
  const MAX_CONSECUTIVE_FAILURES = 5;

  // callWithFallback 내 체인 루프 전에 추가
  const sessionKey = logMeta.agentName || logMeta.bot || 'global';
  const consecutiveFails = _sessionFailures.get(sessionKey) || 0;
  if (consecutiveFails >= MAX_CONSECUTIVE_FAILURES) {
    throw new Error(`🛑 ${sessionKey} 연속 ${consecutiveFails}회 실패 — 세션 LLM 비활성화`);
  }

  // 성공 시 리셋
  _sessionFailures.set(sessionKey, 0);

  // 전체 실패 시 카운트 증가
  _sessionFailures.set(sessionKey, consecutiveFails + 1);
```

### 1-2. 에이전트 고용 (hiring-contract.js, 258줄) ★ 우리 고유 강점!

```
CC에 없는 패턴:
  ε-greedy 탐색 (EPSILON=0.2)
  taskHint → specialty 매칭
  fatigue/confidence 감정 점수 반영
  팀 격리 (글로벌 폴백 금지)

CC 대비 Gap:
  ❌ 에이전트 간 프롬프트 캐시 공유 없음
  ❌ 에이전트 스폰 비용 추적 없음
  ❌ Progressive Disclosure (팀별 도구 서브셋) 없음

개선안:
  P1: 에이전트 선택 시 "이 에이전트가 접근 가능한 도구 목록" 반환
      → 선택된 에이전트의 도구를 제한 (Vercel 80% 제거 패턴)
  P2: 에이전트 실행 비용 추적 (토큰/시간/성공률)
      → hiring-contract가 비용 효율도 고려하여 선택
```

### 1-3. 경쟁 엔진 (competition-engine.js, 162줄) ★ 우리 고유 강점!

```
CC에 전혀 없는 패턴:
  formGroups → startCompetition → evaluateResults → completeCompetition
  calculateQuality: 글자수+섹션수+AI리스크+코드블록 4축 평가
  승자/패자 점수 반영 → 자연 수렴

CC 대비 보강:
  ❌ 경쟁 결과 → 프롬프트 피드백 루프 없음 (점수만 변동)
  → "지난 경쟁에서 A가 B를 이긴 이유: 글자수 부족" → 다음 생성에 반영

개선안:
  P2: 경쟁 결과 분석 → RAG 저장 → 다음 경쟁 시 참조
      "이전 패배 원인: AI탐지 리스크 높음" → 프롬프트에 추가
```

### 1-4. Shadow Mode (shadow-mode.js, 523줄)

```
CC 패턴: 없음 (단일 모델)
TJ: 룰 기반 vs LLM 기반 비교 → 안전 검증!

Shadow Mode 구조:
  _callGroq + _callLocal → LLM 판단 수집
  _compareResults → 룰 결과와 비교
  _isDangerous → 위험 판단 자동 차단

CC 대비 장점:
  ✅ A/B 비교가 프로덕션에서 동작 (CC에 없음!)
  ✅ 위험 판단 자동 차단 (CC의 mailbox 패턴 유사!)

개선안:
  P2: Gemma 4 시범 배치 시 Shadow Mode 활용
      qwen2.5-7b vs gemma4-26b 병렬 비교 → 자동 판단
```

### 1-5. RAG/메모리 (rag.js, 354줄)

```
CC 패턴: 3계층 메모리 + Strict Write Discipline + autoDream
  Layer 1: MEMORY.md — 포인터 인덱스 (~150자/항목), 항상 로드
  Layer 2: 토픽 파일 — 실제 지식, 온디맨드 로드
  Layer 3: 로우 트랜스크립트 — grep만

TJ: pgvector RAG (354줄)
  ✅ 5개 도메인 (operations, trades, tech, video, experience)
  ✅ 로컬 임베딩 (MLX Qwen3-Embedding-0.6B, 1024차원)
  ✅ HNSW 인덱스 (코사인 유사도)
  ❌ Strict Write Discipline 없음 (실패 시에도 저장 가능!)
  ❌ 메모리 계층 분리 없음 (모든 것이 같은 벡터 테이블)
  ❌ autoDream (야간 증류) 없음
  ❌ "메모리는 힌트" 검증 패턴 없음

개선안:
  P0: rag.store() 호출 전 성공 여부 확인 래퍼
      async function storeIfSuccess(collection, text, meta, source, success) {
        if (!success) { console.warn('[RAG] 실패 결과 저장 스킵'); return; }
        return rag.store(collection, text, meta, source);
      }
  P1: 메모리 계층 분리
      hot_memory (항상 로드) — 최근 7일 성공 패턴
      cold_memory (온디맨드) — 전체 히스토리
  P2: nightly-distill.js — 매일 메모리 정리 + 모순 해소
```

---

## 2. 오케스트레이터 심층 분석 (10,146줄/48파일)

### 2-1. 인텐트 파서 (intent-parser.js, 698줄)

```
CC 패턴: coordinatorMode.ts — 프롬프트 기반 오케스트레이션
  "약한 작업을 승인하지마" "이해 전에 넘기지 마라"

TJ: intent-parser.js — 3단계 파싱
  1단계: 슬래시 명령 정규 매칭 (/status, /help, /luna 등)
  2단계: LLM 기반 의도 분류
  3단계: Few-shot 예시 동적 로더 (unrecognized_intents.promoted_to)

CC 대비 분석:
  ✅ 3단계 파싱 — CC보다 체계적!
  ✅ Few-shot 동적 로더 — CC에 없음 (Standing Orders 유사!)
  ❌ 프롬프트 기반 오케스트레이션 아님 (코드 라우팅)
  ❌ 멀티에이전트 위임 없음 (단일 핸들러)

개선안:
  P2: 인텐트 분류 결과에 "위임 대상 팀/에이전트" 포함
      → 현재: intent → 코드가 핸들러 선택
      → 개선: intent + delegateTo → 에이전트가 에이전트 호출
```

### 2-2. 야간 핸들러 (night-handler.js, 483줄)

```
CC 패턴: KAIROS — 자율 데몬
  /dream (야간 메모리 증류)
  append-only 일일 로그
  5분 cron 새로고침
  GitHub 웹훅 구독

TJ: night-handler.js
  야간 자동 처리 모드
  → CC의 KAIROS와 가장 유사한 구현!

CC 대비:
  ✅ 야간 자동 처리 — KAIROS의 시작점!
  ❌ 메모리 증류 없음 (처리만 하고 학습 없음)
  ❌ 5분 주기 모니터링 없음 (야간 1회 실행)
  ❌ 웹훅 구독 없음

개선안:
  P1: night-handler에 "야간 회고" 단계 추가
      → 하루 로그 분석 → 패턴 추출 → memory.md 업데이트
  P3: KAIROS 유사 데몬으로 확장
      → 5분 주기 환경 모니터링 + 자율 대응
      → deploy.sh 강화 또는 별도 kairos-daemon.js
```

---

## 3. 루나/투자팀 심층 분석 (28,363줄/101파일)

### 3-1. DAG 파이프라인 (nodes/, 1,006줄)

```
CC 패턴: Coordinator → Worker 병렬 실행
  격리 워크트리, 메일박스, 캐시 공유

TJ: 루나 DAG 파이프라인 (15노드!)
  l01 pre-screen → l02 ta-analysis → l03 news/sentinel
  → l04 sentiment → l05 onchain → l06 portfolio-context
  → l10 signal-fusion → l11 bull-debate → l12 bear-debate
  → l13 final-decision → l14 portfolio-decision
  → l21 llm-risk → l30-34 실행/저장/알림/로깅

CC 대비:
  ✅ 15단계 DAG — CC보다 정교한 단계별 파이프라인!
  ✅ Bull/Bear 토론 — CC의 Coordinator-Worker + Consensus 패턴!
  ✅ l13 final-decision — CC "약한 작업 승인하지마"와 동일!
  ❌ 노드 간 병렬 실행 없음 (순차만)
  ❌ 노드별 컨텍스트 격리 없음 (공유 상태)
  ❌ 실패 노드 스킵/재시도 로직 약함
  ❌ 거래 결과 → 다음 판단 피드백 루프 약함

개선안:
  P1: 독립 노드 병렬화 (l03 news + l04 sentiment + l05 onchain 동시)
      const [news, sentiment, onchain] = await Promise.allSettled([
        nodes.l03(signal), nodes.l04(signal), nodes.l05(signal)
      ]);
  P1: 거래 결과 → RAG 저장 → l03에서 "과거 유사 상황 결과" 참조
  P2: 노드별 타임아웃 + 실패 시 다음 노드 스킵 로직
  P3: l11/l12 토론을 Coordinator 프롬프트 기반으로 전환
```

---

## 4. 클로드팀 심층 분석 (12,345줄/58파일)

### 4-1. Doctor (doctor.js, 458줄) ★ CC KAIROS와 가장 유사!

```
CC 패턴: KAIROS
  자율 데몬, /dream, 5분 cron, 웹훅

TJ: Doctor
  scanAndRecover() — 자율 루프!
  pollDoctorTasks() — 태스크 큐 폴링
  execute() — 복구 실행
  getPastSuccessfulFix() — 과거 성공 수정 참조!
  emergencyDirectRecover() — 긴급 직접 복구

CC 대비:
  ✅ scanAndRecover — KAIROS보다 이미 운영 중! ★
  ✅ getPastSuccessfulFix — 과거 학습 참조! (CC에 없음)
  ✅ emergencyDirectRecover — CC에 없는 긴급 복구!
  ❌ 야간 메모리 증류 없음
  ❌ 환경 변화 감지 없음 (문제 발생 후 대응만)
  ❌ 자율 판단이 코드 기반 (프롬프트 기반 아님)

개선안:
  P1: Doctor에 "예방적 스캔" 추가
      → 에러 발생 전에 경고 징후 감지 (메모리 증가, 응답 지연 등)
  P2: autofix 판단을 LLM 프롬프트 기반으로 전환
      → 현재: 코드로 "이 에러면 이 수정" 매핑
      → 개선: LLM에게 "이 에러 로그를 분석하고 수정 방법 제안" 프롬프트
```

### 4-2. Autofix (autofix.js, 296줄)

```
CC 패턴: bashSecurity.ts 23개 보안 검사
  도구별 독립 권한, 3단계 승인

TJ: autofix.js
  fixStaleLock — 오래된 락 파일 수정
  fixSecretsPermissions — 시크릿 권한 수정
  fixLogRotation — 로그 로테이션
  fixChecksums — 체크섬 수정
  fixOpenClawMemory — OpenClaw 메모리
  reportBugs — 버그 보고 (수정 대신 보고!)

CC 대비:
  ✅ reportInsteadOfFix — "수정 대신 보고" 패턴! (안전!)
  ✅ 체크섬 검증 — CC에 없는 무결성 검사
  ❌ 수정 권한 체계 없음 (코드가 직접 수정)
  ❌ 수정 전 백업/롤백 없음

개선안:
  P2: autofix에 3단계 권한 추가
      safe: 자동 실행 (로그 로테이션, 체크섬)
      warn: 실행 + 텔레그램 알림 (락 파일, 권한)
      block: 마스터 승인 필요 (시크릿, 데이터베이스)
```

---

## 5. 종합 — CC 하네스 6대 구성요소 vs 우리 시스템

```
┌──────────────┬──────────────────────┬──────────────────────┬──────┐
│ CC 하네스     │ CC 구현              │ TJ 구현              │ Gap  │
├──────────────┼──────────────────────┼──────────────────────┼──────┤
│ ① 프롬프트   │ coordinator 프롬프트  │ 코드 if/else         │ ★★★ │
│              │ 배포 없이 행동 변경   │ 변경=코드수정+배포    │      │
├──────────────┼──────────────────────┼──────────────────────┼──────┤
│ ② 메모리     │ 3계층 + StrictWrite  │ pgvector RAG          │ ★★☆ │
│              │ + autoDream 야간증류  │ + self-improving      │      │
│              │                      │ ❌ StrictWrite 없음   │      │
│              │                      │ ❌ autoDream 없음     │      │
├──────────────┼──────────────────────┼──────────────────────┼──────┤
│ ③ 도구       │ 40도구 + 권한게이트   │ 33스킬 + 4MCP        │ ★☆☆ │
│              │ 29,000줄 도구정의    │ + 62코어모듈          │      │
│              │ "시도 vs 허용" 분리   │ ❌ 권한분리 미흡      │      │
├──────────────┼──────────────────────┼──────────────────────┼──────┤
│ ④ 오케스트   │ Coordinator-Worker   │ 9팀 × 에이전트       │ ★★☆ │
│              │ 프롬프트 기반 위임    │ blo.js 코드 오케스트  │      │
│              │ 병렬 + 캐시공유      │ ❌ 병렬 실행 약함    │      │
├──────────────┼──────────────────────┼──────────────────────┼──────┤
│ ⑤ 가드레일   │ 4티어 권한            │ DEV/OPS 분리         │ ★☆☆ │
│              │ bashSecurity 23항목   │ mode/file/billing    │      │
│              │ mailbox 패턴          │ guard 3종            │      │
├──────────────┼──────────────────────┼──────────────────────┼──────┤
│ ⑥ 관측성     │ tracing, cache추적   │ traceCollector       │ ★☆☆ │
│              │ 14 캐시파괴벡터      │ llm-logger           │      │
│              │                      │ reporting-hub        │      │
└──────────────┴──────────────────────┴──────────────────────┴──────┘

우리만의 강점 (CC에 없음!):
  ★ hiring-contract ε-greedy 동적 고용
  ★ competition-engine 에이전트 경쟁
  ★ shadow-mode A/B 검증
  ★ doctor scanAndRecover 자율 복구
  ★ Standing Orders 자동 규칙화
  ★ 4단계 LLM 폴백 (로컬→클라우드)
  ★ 로컬 LLM 비용 $0
```

---

## 6. 팀별 개선 우선순위 (1차분)

### 코어 모듈

```
P0: llm-fallback.js 연속 실패 제한 (5회) ← 즉시 3줄!
P0: rag.js Strict Write Discipline (성공 시에만 저장)
P1: hiring-contract에 에이전트별 도구 서브셋 반환
P1: competition-engine 결과 → RAG 피드백 루프
P2: 프롬프트 캐시 불변/가변 분리
P2: context-compactor.js 신규 (MicroCompact)
```

### 오케스트레이터

```
P1: night-handler에 야간 회고(메모리 증류) 추가
P2: intent-parser에 "위임 대상" 필드 추가
P3: KAIROS 유사 5분 주기 자율 데몬
```

### 루나/투자팀

```
P1: 독립 노드 병렬화 (l03+l04+l05)
P1: 거래 결과 → RAG → 다음 판단 참조
P2: 노드별 타임아웃 + 실패 스킵
P3: Bull/Bear 토론 프롬프트 기반 전환
```

### 클로드팀

```
P1: Doctor 예방적 스캔 (경고 징후 감지)
P2: autofix 3단계 권한 (safe/warn/block)
P2: autofix LLM 프롬프트 기반 진단
P3: Doctor → KAIROS 데몬으로 확장
```

---

## 다음 분석 대상

```
2차분 (다음 세션):
  □ 워커팀 (36,094줄) — SaaS 포털 + 에이전트 오피스
  □ 스카팀 (58,238줄) — Python/Node 혼합 이슈
  □ 비디오팀 (11,652줄) — Twick + RED/BLUE 검증
  □ 연구/감정/데이터팀 (신규) — 초기 설계 검토
```


---

## 5. 워커팀 심층 분석 (36,094줄/288파일)

### 5-1. 구조 개요

```
워커팀 = SaaS 포털 + 에이전트 오피스
  lib/ (4,356줄):
    chat-agent.js (876줄) — 채팅 에이전트 (가장 큰 파일!)
    llm-api-monitoring.js (601줄) — LLM API 모니터링
    approval.js (403줄) — 승인 워크플로우
    ai-feedback-service.js (249줄) — AI 피드백
    menu-policy.js (226줄) — 메뉴 정책
    schedule-ai.js (166줄) — 일정 AI
    attendance-ai.js (145줄) — 출석 AI

  web/ (225 JS파일):
    Next.js 앱 (에이전트 오피스, 영상 편집기, 채팅, 매출 등)
    admin/agent-office — 90에이전트 관리 대시보드!
    video/editor — 비디오 편집기 UI
    21+ 마이그레이션 파일
```

### 5-2. CC 비교

```
CC에 없는 것 (우리 강점!):
  ✅ 에이전트 오피스 — 시각적 에이전트 관리 대시보드!
  ✅ approval.js — 승인 워크플로우 (CC의 mailbox 패턴 유사!)
  ✅ llm-api-monitoring — LLM 사용량 모니터링 (CC의 관측성)
  ✅ 마이그레이션 21+개 — 체계적 DB 스키마 관리

CC에서 배울 것:
  ❌ chat-agent.js 876줄 — 대규모 파일 안티패턴! (CC print.ts 5,594줄 교훈)
  ❌ 에이전트 오피스에 CC 패턴 메트릭 없음
     → 컨텍스트 사용량, 캐시 히트율, 실패율, 비용 시각화 필요
  ❌ 채팅에서 에이전트 위임 없음 (단일 chat-agent 처리)

개선안:
  P1: chat-agent.js 리팩토링 (876줄 → 3파일)
     chat-router.js — 의도 분류 + 라우팅
     chat-handler.js — 응답 생성
     chat-state.js — 대화 상태 관리
  P2: 에이전트 오피스에 CC 메트릭 대시보드 추가
     - 에이전트별 토큰 사용량 그래프
     - 실패율 + 평균 응답시간 차트
     - 경쟁 결과 승률 시각화
  P2: approval.js → CC mailbox 패턴으로 강화
     현재: 단순 승인/거부
     개선: 승인 대기열 + 자동 만료 + 에스컬레이션
```

---

## 6. 스카팀 심층 분석 (58,238줄/294파일) ★ 가장 큰 코드베이스!

### 6-1. 구조 개요

```
Python 코어 (4,971줄/8파일):
  forecast.py (2,047줄!) — 매출 예측 ★ 가장 큰 단일 파일!
  rebecca.py (937줄) — 네이버 예약 모니터링
  eve.py (637줄) — 이브 에이전트
  eve_crawl.py (589줄) — 크롤링
  forecast_health.py (345줄) — 예측 헬스체크
  etl.py (268줄) — 데이터 ETL
  weather.py (71줄) — 날씨 데이터

Node.js 보조:
  lib/runtime-config.js (92줄)

+ reservation 봇 (22,397줄/90파일): 예약 관리
```

### 6-2. CC 비교

```
CC에서 배울 것:
  ❌ forecast.py 2,047줄!!! — 최대 안티패턴!
     CC print.ts 5,594줄과 동일 문제
     → 분리 시급: forecast_model.py + forecast_api.py + forecast_viz.py
  ❌ Python↔Node 혼합 — 통신 오버헤드, 디버깅 어려움
  ❌ 컨텍스트 관리 없음 (예약 모니터링 장시간 실행)
  ❌ 실패 복구 패턴 약함 (rebecca 크롤링 실패 시?)

CC에 없는 강점:
  ✅ 실제 비즈니스 운영 자동화! (CC는 코딩 도구만)
  ✅ ETL 파이프라인 (etl.py)
  ✅ 매출 예측 ML (forecast.py)

개선안:
  P1: forecast.py 2,047줄 → 3파일 분리
     forecast_model.py — ML 모델 로직
     forecast_api.py — API 엔드포인트
     forecast_report.py — 리포트 생성
  P2: Python↔Node 인터페이스 명확화
     → JSON-RPC 또는 HTTP API로 통신 표준화
     → 현재: 혼합 호출 → 표준 인터페이스
  P2: rebecca.py 크롤링 실패 복구 강화
     → MAX_CONSECUTIVE_FAILURES 패턴 적용
     → 실패 시 Doctor 팀에 알림
  P3: 예약 모니터링 컨텍스트 관리
     → 장시간 실행 시 상태 요약 + 정리
```

---

## 7. 비디오팀 심층 분석 (11,652줄/48파일)

### 7-1. 구조 개요

```
핵심 파이프라인:
  run-pipeline.js (810줄) — 전체 파이프라인 실행
  edl-builder.js (971줄) — EDL(편집 결정 목록) 생성
  scene-indexer.js (575줄) — 장면 인덱싱
  narration-analyzer.js (504줄) — 나레이션 분석
  sync-matcher.js (463줄) — 동기화 매칭
  step-proposal-engine.js (439줄) — 편집 단계 제안
  video-rag.js (486줄) — 비디오 RAG

품질 검증:
  critic-agent.js (570줄) — 비평 에이전트 (RED 역할!)
  refiner-agent.js (670줄) — 개선 에이전트 (BLUE 역할!)
```

### 7-2. CC 비교

```
CC 패턴과 매우 유사한 구조!:
  ✅ critic-agent = CC의 "약한 작업을 승인하지마" 패턴!
  ✅ refiner-agent = CC의 워커 에이전트 (수정 전담)
  ✅ run-pipeline = CC의 coordinatorMode (파이프라인 조율)
  ✅ video-rag = 경험 학습 (CC의 메모리 패턴)

CC에서 배울 것:
  ❌ critic/refiner 판단이 코드 기반 (프롬프트 기반 아님)
  ❌ 병렬 처리 약함 (장면 분석 순차)
  ❌ 컨텍스트 관리 없음 (영상 메타데이터 누적)
  ❌ edl-builder 971줄 — 분리 후보

개선안:
  P1: scene-indexer 병렬화 (장면별 독립 분석)
     const scenes = await Promise.allSettled(
       segments.map(s => analyzeScene(s))
     );
  P2: critic-agent를 프롬프트 기반으로 전환
     → 현재: 코드 규칙으로 품질 판단
     → 개선: LLM(gemma4) 프롬프트로 품질 판단 (더 유연!)
  P2: video-rag 강화 (편집 패턴 학습)
     → "이전 유사 영상에서 효과적이었던 편집 패턴" RAG 검색
  P3: Gemma 4 멀티모달 활용 (이미지/비디오 이해)
```

---

## 8. 신규팀 분석 (연구/감정/데이터)

### 8-1. 연구팀 (15에이전트)

```
CC 패턴 적용 기회:
  ✅ KAIROS /dream 패턴 — 연구 결과 야간 증류에 최적!
  ✅ Coordinator-Worker — 여러 연구원이 병렬 조사
  ✅ Progressive Disclosure — 논문 검색 → 관련 논문만 상세 로드

설계 제안:
  frame(팀장) → 코디네이터 프롬프트 기반
  연구원 에이전트 → 워커 (arXiv, GitHub, 논문 검색)
  야간 증류 → 하루 연구 결과 자동 정리
  Standing Orders → "이 분야에서 이 패턴이 효과적" 자동 규칙화
```

### 8-2. 감정팀 (10에이전트)

```
CC 패턴 적용 기회:
  ✅ 4티어 권한 — 법원 문서 접근 권한 엄격 필요!
  ✅ Strict Write Discipline — 감정 결과 정확성 최우선
  ✅ mailbox 패턴 — 감정 판단은 반드시 전문가 승인

설계 제안:
  briefing(팀장) → 코디네이터 (마스터 승인 필수)
  분석 에이전트 → 워커 (데이터 분석, 코드 분석)
  모든 출력에 Strict Write → 검증 후에만 저장
  approval-queue 적용 → 감정 결과 마스터 최종 승인
```

### 8-3. 데이터팀 (6에이전트)

```
CC 패턴 적용 기회:
  ✅ MicroCompact — 대용량 데이터 처리 시 컨텍스트 관리
  ✅ Progressive Disclosure — 데이터셋 요약 → 상세 분석 순서
  ✅ Build to Delete — 데이터 파이프라인 모듈화

설계 제안:
  pivot(팀장) → 데이터 파이프라인 조율
  분석 에이전트 → ETL + 시각화 + 리포트
  대용량 데이터 처리 시 컨텍스트 압축 필수
```

---

## 9. 전체 시스템 횡단 개선 종합

```
┌──────────┬────────────────────────────────┬──────┐
│ 우선순위  │ 개선사항                        │ 영향 │
├──────────┼────────────────────────────────┼──────┤
│ P0 즉시  │ 연속실패제한 (llm-fallback)      │ 전팀 │
│ P0 즉시  │ Strict Write (rag.js)          │ 전팀 │
├──────────┼────────────────────────────────┼──────┤
│ P1 단기  │ 대규모파일 분리                 │ 4팀  │
│          │  forecast.py 2,047줄            │ 스카 │
│          │  chat-agent.js 876줄            │ 워커 │
│          │  edl-builder.js 971줄           │ 비디오│
│          │  blo.js 991줄 (진행중!)         │ 블로 │
│ P1 단기  │ 독립노드 병렬화                 │ 루나 │
│ P1 단기  │ 야간회고 (night-handler)         │ 전팀 │
│ P1 단기  │ Doctor 예방적 스캔              │ 클로드│
├──────────┼────────────────────────────────┼──────┤
│ P2 중기  │ 에이전트오피스 CC메트릭          │ 워커 │
│ P2 중기  │ Python↔Node 인터페이스 표준화    │ 스카 │
│ P2 중기  │ critic-agent 프롬프트 전환       │ 비디오│
│ P2 중기  │ approval→mailbox 패턴 강화      │ 워커 │
│ P2 중기  │ autofix 3단계 권한              │ 클로드│
│ P2 중기  │ context-compactor MicroCompact  │ 전팀 │
├──────────┼────────────────────────────────┼──────┤
│ P3 장기  │ 프롬프트 기반 오케스트레이션      │ 전팀 │
│ P3 장기  │ AgentTool 서브에이전트 스폰      │ 전팀 │
│ P3 장기  │ KAIROS 데몬                     │ 전팀 │
│ P3 장기  │ Build to Delete 아키텍처         │ 전팀 │
└──────────┴────────────────────────────────┴──────┘

대규모 파일 안티패턴 경고 (CC print.ts 5,594줄 교훈):
  forecast.py   2,047줄 ← 최우선 분리!
  blo.js          991줄 ← Phase A-3 진행중
  edl-builder.js  971줄 ← P1 분리
  rebecca.py      937줄 ← P2 분리
  chat-agent.js   876줄 ← P1 분리
```
