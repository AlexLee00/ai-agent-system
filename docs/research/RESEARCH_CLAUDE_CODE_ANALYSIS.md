# Claude Code 소스 코드 분석 → 팀 제이 시스템 개선점

> 작성: 메티 (Claude Opus 4.6)
> 작성일: 2026-04-06
> 출처: 위키독스 "별첨 91. 클로드 코드 소스 코드 분석서" (1,884파일 TypeScript)
> 분류: 연구 문서

---

## 1. 분석 요약

Claude Code는 1,884개 TypeScript 파일로 구성된 프로덕션 에이전트 하네스.
핵심 아키텍처 패턴 8가지 + 서브시스템 20개를 심층 분석.
팀 제이 시스템에 즉시 적용 가능한 개선점 12개 도출.

---

## 2. Claude Code 핵심 아키텍처 vs 팀 제이

### 2-1. 쿼리 루프 (핵심 엔진)

```
Claude Code:
  query.ts (68KB) = 비동기 제너레이터 패턴
  메시지 전처리 → API 스트리밍 → 에러 보류/복구 → 도구 실행 → 후처리
  = 무한 루프, 도구 사용 없을 때까지 반복

팀 제이:
  각 팀 봇이 자체 루프 (blo.js, crypto.js 등)
  ❌ 통합된 쿼리 루프 엔진 없음
  ❌ 에러 보류/복구 패턴 없음 (에러 즉시 throw)
  ❌ 비동기 제너레이터 미사용

개선점 A: 통합 에이전트 루프 엔진!
  packages/core/lib/agent-loop.js
  모든 팀의 에이전트가 동일한 루프 엔진 위에서 동작
  → 전처리/에러복구/도구실행/후처리 표준화!
```

### 2-2. 도구 실행 파이프라인 (10단계)

```
Claude Code:
  1. 도구 조회 → 2. 중단 확인 → 3. 입력 검증(Zod)
  → 4. PreToolUse 훅 → 5. 권한 확인 → 6. 도구 실행
  → 7. 결과 변환 → 8. 대형 결과 디스크 저장
  → 9. PostToolUse 훅 → 10. 텔레메트리 로깅

팀 제이:
  ✅ 스킬 시스템 있음 (31파일)
  ✅ hiring-contract로 에이전트 선택
  ❌ 입력 검증 표준화 없음 (각 팀이 자체 처리)
  ❌ Pre/Post 훅 시스템 없음!
  ❌ 대형 결과 디스크 저장 없음
  ❌ 텔레메트리/로깅 표준화 없음

개선점 B: 훅 시스템 도입!
  packages/core/lib/hooks.js
  PreTaskRun / PostTaskRun / OnError / OnComplete
  → 각 팀이 커스텀 검증/로깅 훅 등록 가능!
  → 시그마팀이 PostTaskRun 훅으로 모든 활동 데이터 자동 수집!
```

### 2-3. 동시성 모델 (파티셔닝 알고리즘)

```
Claude Code:
  안전한 도구 (Read/Grep/Glob) → 최대 10개 병렬!
  위험한 도구 (Edit/Bash) → 하나씩 순차!
  "파티셔닝 알고리즘"으로 자동 배치 분류

팀 제이:
  ✅ 다윈팀 9명 searcher 병렬 실행
  ❌ 범용 동시성 분류 없음
  ❌ 에이전트별 안전/위험 분류 없음

개선점 C: 에이전트 동시성 분류!
  agent-registry에 concurrencySafe: boolean 추가
  읽기 전용 에이전트 → 병렬 실행
  쓰기 에이전트 → 순차 실행
  → 안전하게 속도 향상!
```

### 2-4. 권한 시스템 (4단계 모드)

```
Claude Code:
  Default: 읽기=자동, 쓰기=질문
  Auto: AI 분류기 2단계 (빠른판단+심층분석)
  Plan: 읽기 전용만 허용
  Bypass: 전부 자동 승인

  규칙 우선순위: Local > Project > User > Flags > Policy

팀 제이:
  ✅ DEV/OPS 분리 (4중 안전장치)
  ✅ 닥터 블랙리스트 (RECOVERY_BLACKLIST)
  ❌ 에이전트별 세밀한 권한 없음!
  ❌ AI 기반 위험도 분류 없음

개선점 D: 에이전트 권한 scope! (P0-3과 연계)
  { read: ['luna.*'], write: ['luna.wallets'], execute: ['SELECT'] }
  → 에이전트가 자기 팀 데이터만 접근!
  → sweeper는 luna.wallets만, pipe는 전체 read만
```

### 2-5. 자동 압축 (컨텍스트 관리)

```
Claude Code:
  4단계 압축: Snip → Microcompact → Context Collapse → Auto-Compact
  서킷 브레이커: 3연속 실패 시 시도 중단
  압축 후 상위 5개 참조 파일 복원 (50K 토큰 예산)

팀 제이:
  ✅ RAG로 경험 데이터 검색
  ❌ 에이전트 대화 컨텍스트 관리 없음
  ❌ 장기 실행 에이전트의 메모리 관리 없음

개선점 E: 에이전트 컨텍스트 관리!
  장기 실행 에이전트 (루나팀 매매 사이클 등)의
  컨텍스트가 토큰 한계에 도달하면 자동 요약
  → 에이전트가 더 긴 작업을 안정적으로 수행!
```

### 2-6. 메모리 시스템

```
Claude Code:
  4가지 메모리 유형: user/feedback/project/reference
  YAML 프론트매터 + 마크다운 본문
  "왜(Why)" + "어떻게 적용(How)" 함께 기록
  NOT saved: 코드 패턴, 아키텍처, Git 히스토리

팀 제이:
  ✅ RAG 대도서관 설계 (experience_record)
  ✅ Standing Orders (반복 패턴 승격)
  ❌ 메모리 유형 분류 없음!
  ❌ "왜" 기록 없음 (결과만 저장)

개선점 F: experience_record에 "why" 필드 추가!
  experience_record.reason: "왜 이 결정을 했는가"
  experience_record.how_to_apply: "다음에 어떻게 적용하는가"
  → 단순 결과 저장 → 의사결정 근거까지 저장!
```

### 2-7. 에러 보류와 복구 (Withhold & Recover)

```
Claude Code:
  복구 가능한 에러 → 사용자에게 바로 보여주지 않고 "보류"!
  413 → 컨텍스트 축소 시도 → 전체 요약 시도 → 실패 시 표면화
  출력 초과 → 한도 에스컬레이션 (8K→64K) → 최대 3회 이어쓰기
  = "자동으로 고칠 수 있는 건 고치고, 안 되면 보여줘"

팀 제이:
  ✅ llm-fallback.js chain 패턴 (qwen→groq 폴백)
  ❌ 에러 유형별 복구 전략 없음
  ❌ "보류" 패턴 없음 (에러 즉시 throw/warn)

개선점 G: 에러 보류+복구 패턴 도입!
  packages/core/lib/error-recovery.js
  LLM timeout → 자동 chain fallback (이미 있음, 강화!)
  DB 연결 실패 → 자동 재연결 (pg-pool 강화)
  외부 API 실패 → 재시도 + 지수 백오프
  → 에이전트가 스스로 에러를 복구하는 자율성 향상!
```

### 2-8. 코디네이터 모드 (멀티에이전트 오케스트레이션)

```
Claude Code:
  리더 1명 + 워커 N명
  리더: 코드 직접 수정 안 함! 분배만!
  4단계: Research(병렬) → Synthesis(순차) → Implement(영역별) → Verify(병렬)
  핵심 규칙: 리더가 워커 결과를 반드시 직접 이해해야 함!

팀 제이:
  ✅ 3역할 (메티/코덱스/제이) — 유사 패턴!
  ✅ 시그마팀 동적 편성 — 유사 패턴!
  ❌ 범용 리더-워커 패턴은 없음
  ❌ 4단계 워크플로우 표준화 없음

개선점 H: 리더-워커 4단계 패턴 시그마팀에 적용!
  sigma(리더):
    Research → pipe+pivot 병렬 데이터 수집
    Synthesis → sigma가 직접 분석 이해
    Implement → 피드백 적용 (영역별 순차)
    Verify → canvas 리포트로 검증
  → 시그마팀 일일 사이클이 정확히 이 4단계!
```

---

## 3. Claude Code 8대 설계 패턴 → 팀 제이 적용

```
패턴                     Claude Code              팀 제이 현재    적용 방안
─────────────────────   ────────────────          ─────────────   ────────────
1. Generator Streaming   query() yields           ❌ 없음         에이전트 루프 엔진
2. Feature Gate          빌드 시 dead code 제거    ❌ 없음         config.yaml feature flags
3. Memoized Context      Git/CLAUDE.md 캐시       ✅ 부분적       에이전트별 컨텍스트 캐시
4. Withhold & Recover    에러 보류+자동 복구       ❌ 없음         error-recovery.js
5. Lazy Import           순환 의존 방지            ✅ 부분적       require() 지연 로딩 확대
6. Immutable State       DeepImmutable+Zustand    ❌ 없음         상태 불변성 도입 (중장기)
7. Crash Resilience      쿼리 전 트랜스크립트 저장  ✅ 부분적       에이전트 체크포인트
8. Dependency Injection  query()에 deps 주입       ❌ 없음         테스트를 위한 DI (P0-1)
```

---

## 4. 즉시 적용 가능한 개선점 12개 (우선순위)

```
즉시 (이번 주):
  G. 에러 보류+복구 패턴 → error-recovery.js (P2-12 강화!)
  F. experience_record에 "why" 필드 추가

이번 달:
  B. 훅 시스템 (PreTaskRun/PostTaskRun) → P1-7 연계!
     → 시그마팀 데이터 수집을 훅으로 자동화!
  D. 에이전트 권한 scope → P0-3 연계!
  C. 에이전트 동시성 분류 (안전/위험)

분기:
  A. 통합 에이전트 루프 엔진 (agent-loop.js)
  H. 리더-워커 4단계 패턴 (시그마팀)
  E. 에이전트 컨텍스트 관리 (장기 실행)
  8. DI 패턴 (테스트 용이성)

장기:
  6. 상태 불변성 (Immutable State)
  2. Feature Gate (빌드 시 코드 제거)
  1. Generator Streaming (에이전트 루프)
```

---

## 5. 특히 주목할 인사이트

### 5-1. "도구 풀 조립 순서가 비용에 영향"

```
Claude Code: 도구 등록 순서가 바뀌면 API 프롬프트 캐시 무효화 → 비용 증가!
팀 제이: 우리도 llm-model-selector에서 도구 목록 전달 시 순서 고정 필요!
→ 스킬 순서를 알파벳순으로 정렬하여 캐시 안정성 확보!
```

### 5-2. "대형 결과 디스크 저장"

```
Claude Code: 도구 결과가 maxResultSizeChars 초과 → 디스크에 저장, 참조만 전달
팀 제이: 다윈팀 논문 스캔 결과, 루나팀 시장 데이터 등 대형 결과 있음
→ 대형 결과 자동 디스크 저장 + 참조 패턴 도입!
→ LLM 토큰 절약 + 컨텍스트 윈도우 효율!
```

### 5-3. "비용 추적 세분화"

```
Claude Code: 모델별 입력/출력/캐시 토큰 실시간 추적 + 세션별 누적
팀 제이: llm-logger.js 있지만 통합 대시보드 없음
→ 시그마팀 canvas가 비용 대시보드 자동 생성!
→ P2-11 코스트 추적 대시보드와 연계!
```

### 5-4. "서킷 브레이커 패턴"

```
Claude Code: 자동 압축 3연속 실패 → 시도 중단 (무한 루프 방지!)
팀 제이: CC P0에서 연속 실패 제한 (MAX=5) 이미 구현!
→ 다른 영역에도 서킷 브레이커 확대:
   닥터 복구 한도 (canRecover) ✅ 이미 있음!
   LLM fallback 한도 추가 필요!
```

### 5-5. "Bash 보안: 기본 거부(fail-closed)"

```
Claude Code: Tree-sitter AST 분석, 허용 목록에 있는 구문만 통과
팀 제이: 닥터가 ai.* 접두사 + 블랙리스트로 안전장치
→ 추가: BashTool 같은 위험한 도구 실행 시
   AI가 생성한 명령어를 파싱하여 안전성 검증!
```

---

## 6. Claude Code 아키텍처에서 배울 핵심 원칙

```
① 안전성 + 성능 + 확장성 — 모든 설계 결정의 3원칙
② 핵심 엔진은 하나, 입출력만 다르게 — 멀티 모드 지원
③ 에러를 사용자에게 바로 보여주지 마라 — 먼저 자동 복구!
④ 도구는 원자적, 스킬은 복합적, 플러그인은 패키지 — 3계층
⑤ 상태 변경에 부수효과 자동 발생 — 리액티브 아키텍처
⑥ 권한은 다층 규칙 + AI 분류기 — 사람과 AI 협업 판단
⑦ 메모리는 "무엇"이 아니라 "왜" + "어떻게" — 의사결정 근거
⑧ 병렬은 안전한 것만, 위험한 건 순차 — 속도와 안전의 균형
```
