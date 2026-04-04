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
