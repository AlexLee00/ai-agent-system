# 에이전트 하네스 & 에이전틱 AI 심층 연구

> 작성: 메티 (Claude Opus 4.6)
> 작성일: 2026-04-04
> 상태: 🔬 연구 문서 (지속 업데이트)
> 출처: CC 유출 분석 + 커뮤니티 + 발표 + 연구
> 관련: docs/research/RESEARCH_CLAUDE_CODE_LEAK.md

---

## 1. 핵심 정의

### 1-1. 에이전트 하네스란?

```
"모델 주변의 완전한 시스템. 모델이 유용한 작업을 신뢰성 있게 수행하게 만드는 것"
  — Anup Jadhav, Harness Engineering

"2025년은 에이전트의 해. 2026년은 에이전트 하네스의 해."
  — Aakash Gupta, Medium

"모델은 상품(commodity). 하네스가 해자(moat)."
  — 업계 합의

"에이전트 루프는 20줄. 하네스는 512,000줄."
  — CC 유출에서 증명됨
```

### 1-2. 하네스 6대 구성요소

```
┌──────────────────────────────────────────────┐
│                에이전트 하네스                 │
│                                              │
│  ① 프롬프트 — 시스템 프롬프트, 페르소나       │
│  ② 메모리 — 단기(세션)/장기(RAG)/작업(파일)   │
│  ③ 도구 — 권한 게이팅된 기능 모듈             │
│  ④ 오케스트레이션 — 계획+실행+검증 루프       │
│  ⑤ 가드레일 — 권한, 격리, 복구              │
│  ⑥ 관측성 — 로그, 트레이스, 디버그           │
│                                              │
│  ┌──────────┐                                │
│  │ LLM 모델  │ ← 20줄 루프                   │
│  │ (두뇌)    │                                │
│  └──────────┘                                │
│                                              │
│  나머지 512,000줄 = 하네스!                   │
└──────────────────────────────────────────────┘
```

---

## 2. 5대 난제 — 제이가 겪었던 것들

### 2-1. 권한 시스템 (Permission)

```
난제: "에이전트가 뭘 해도 되고, 뭘 하면 안 되는가?"

CC 해법 — 4티어 권한:
  Trust: 프로젝트 로드 시 신뢰 수준 설정
  Check: 각 도구 실행 전 권한 체크
  Approve: 고위험 작업은 사용자 확인
  Bypass: 내부 전용 (개발 속도)

핵심 원칙:
  "모델이 시도를 결정하고, 도구 시스템이 허용을 결정" — 분리!
  → stutter-step 문제: 매번 승인 요구 = 생산성 저하
  → 해법: 읽기/테스트는 자동 승인, 쓰기는 경로별 승인, 삭제는 차단

우리 현황:
  ✅ DEV/OPS 분리 (4중 안전장치)
  ✅ mode-guard.js (DEV_HUB_READONLY)
  ✅ file-guard.js, billing-guard.js
  ❌ 도구별 세밀 권한 없음
  ❌ "시도 vs 허용" 분리 미흡

적용 방안:
  단기: 도구(스킬) 실행 전 권한 체크 레이어 추가
    skill-selector.js에 permission 필드 추가
    { name: 'order-execute', permission: 'approve' }  // 마스터 승인 필요
    { name: 'news-search', permission: 'auto' }       // 자동 승인
  중기: 팀별 권한 프로필 (루나=투자 높은 권한, 블로=낮은 권한)
```

### 2-2. 도구/툴 시스템 (Tool)

```
난제: "도구를 많이 주면 혼란, 적게 주면 무력"

CC 해법:
  ~40 빌트인 도구, 플러그인 아키텍처
  도구 정의: 29,000줄 (스키마+검증+에러처리)
  AgentTool: 서브에이전트 스폰도 "도구 호출"로 통일

Vercel 교훈 ★:
  "80% 도구를 제거했더니 결과가 좋아졌다"
  → 도구가 적을수록: 단계 ↓, 토큰 ↓, 속도 ↑, 정확도 ↑
  → "모델은 충분히 똑똑하다. 도구를 단순하게 만들어라"

Phil Schmid (HuggingFace):
  "견고한 원자적(atomic) 도구를 제공하라"
  "모델이 계획을 세우게 하라"
  "가드레일, 재시도, 검증을 구현하라"
  "삭제할 수 있도록 만들어라" (Build to Delete)

우리 현황:
  ✅ 33 스킬 + 4 MCP — 풍부한 도구 생태계
  ✅ skill-selector + tool-selector — 3계층 동적 선택
  ❌ 도구 수가 많아지면 혼란 가능 (33개+)
  ❌ "Build to Delete" 원칙 미적용

적용 방안:
  단기: 팀별 도구 서브셋 제한
    루나팀: 투자 관련 5개 도구만 활성화
    블로팀: 블로그 관련 4개 도구만 활성화
  중기: 도구 사용 빈도 추적 → 미사용 도구 비활성화
  장기: Progressive Disclosure — 기본 도구만 주고, 필요 시 추가 도구 로드
```

### 2-3. 서브에이전트 관리 (Sub-agent)

```
난제: "에이전트 간 컨텍스트 오염, 비용 폭발"

CC 해법 — 3가지 실행 모델:
  ① 격리 워크트리: 각 서브에이전트가 자체 git 복사본에서 작업
  ② 메일박스 패턴: 위험 작업은 코디네이터 승인 대기열
  ③ 프롬프트 캐시 공유: 서브에이전트가 컨텍스트 비용 공유

핵심 인사이트:
  "서브에이전트가 캐시를 공유하지 않으면, 병렬화에 엄청난 토큰 세금"
  "3개 모듈을 동시에 리팩토링할 때, 1에이전트 = 3모듈 컨텍스트 오염"
  "3개 서브에이전트 = 각자 깨끗한 컨텍스트"

우리 현황:
  ✅ 9팀 격리 — 팀 간 컨텍스트 분리
  ✅ hiring-contract.js — 팀 내 에이전트 격리
  ❌ 에이전트 간 병렬 실행 없음
  ❌ 프롬프트 캐시 공유 없음
  ❌ 메일박스 패턴 (위험 작업 대기열) 없음

적용 방안:
  단기: 블로팀 분할 생성 시 Promise.allSettled 병렬화
  중기: AgentTool 패턴 — 에이전트가 다른 에이전트를 도구로 호출
  장기: 코디네이터 → 워커 패턴 (루나팀 Bull/Bear 토론 확장)
```

### 2-4. 메모리 관리 (Memory)

```
난제: "뭘 기억하고, 뭘 잊어야 하는가? 잘못된 기억은?"

CC 해법 — 3계층 메모리:
  Layer 1: MEMORY.md — 포인터 인덱스 (~150자/항목), 항상 로드
  Layer 2: 토픽 파일 — 실제 지식, 온디맨드 로드
  Layer 3: 로우 트랜스크립트 — 전체 읽기 없음, grep만

CC 핵심 규율:
  "Strict Write Discipline" — 파일 쓰기 성공 후에만 메모리 업데이트
  "메모리는 힌트, 실제 코드베이스로 검증" — 메모리 맹신 금지
  "autoDream" — 유휴 시 메모리 정리, 모순 해결, 관찰→사실 전환

Neo4j 연구:
  "지식 그래프가 벡터 검색보다 정확한 관계 탐색 가능"
  "에이전트는 유사 단어가 아니라 연결된 엔티티를 따라가야"

우리 현황:
  ✅ ~/self-improving/ (memory.md HOT + corrections.md + domains/)
  ✅ pgvector RAG — 벡터 검색
  ✅ Standing Orders — 검증된 규칙 승격
  ❌ Strict Write Discipline 없음 (실패 시에도 기록 가능)
  ❌ autoDream (야간 메모리 증류) 없음
  ❌ "메모리는 힌트" 검증 패턴 없음
  ❌ Progressive Disclosure 미적용 (전체 메모리 로드)

적용 방안:
  P0: Strict Write Discipline
    → 성공 확인 후에만 memory.md 갱신
    → corrections.md에 실패 이유도 기록
  P1: autoDream (야간 메모리 증류)
    → nightly-distill.js — 하루 로그 분석 → 패턴 추출
    → 모순 탐지: "어제는 A가 좋다고 했는데 오늘은 B?"
    → 관찰 → 사실 전환: "3회 성공 → Standing Orders"
  P2: Progressive Disclosure
    → memory.md를 "핫 메모리"(항상 로드)와 "콜드 메모리"(온디맨드)로 분리
    → 팀별 도메인 메모리 온디맨드 로드
```

### 2-5. 컨텍스트/상태 관리 (Context)

```
난제: "대화가 길어지면 LLM이 '피로'해진다"

CC 해법 — 4단계 컨텍스트 압축:
  ① MicroCompact — 로컬 편집, API 0, 도구 출력 트리밍
  ② AutoCompact — 컨텍스트 상한 시 13K버퍼+20K요약 생성
  ③ FullCompact — 전체 압축 + 선택적 파일 재주입
  ④ Time-based — 오래된 도구 결과 자동 제거
  + MAX_CONSECUTIVE_FAILURES = 3 (25만 호출/일 절약!)

업계 용어:
  "컨텍스트 엔트로피" — 세션이 길어지면서 환각+품질 저하
  "컨텍스트 내구성(durability)" — 하네스의 핵심 과제
  "모델 드리프트" — 100번째 스텝에서 모델이 지시를 잊음

우리 현황:
  ✅ 로그 로테이션
  ❌ 4단계 압축 전체 없음 ← 가장 큰 Gap!
  ❌ 장시간 에이전트 품질 관리 없음
  ❌ 연속 실패 제한 없음

적용 방안:
  P0: MAX_CONSECUTIVE_FAILURES = 5 (즉시 3줄 추가)
  P1: MicroCompact — 도구 결과 트리밍 (오래된 것 제거)
  P2: AutoCompact — 컨텍스트 상한 시 LLM 요약 생성
  P3: FullCompact — 전체 세션 압축 + 핵심 파일 재주입
```

---

## 3. 에이전틱 AI 7대 패턴

```
① Plan-Act-Verify (계획-실행-검증) ★ 가장 기본!
  모델이 답만 생성하는 게 아니라:
  계획 분해 → 행동 → 결과 확인 → 계속
  우리: maestro.js 파이프라인 ≈ 이 패턴!

② Progressive Disclosure (점진적 공개)
  처음에 모든 것을 로드하지 않음
  최소 지시 → 필요 시 추가 컨텍스트/스킬/문서 로드
  우리: ❌ 전체 프롬프트 한 번에 로드

③ Red-Green Testing (실패 테스트 → 통과)
  Simon Willison: "실패하는 테스트 작성 → 에이전트가 통과시킴"
  타이트한 피드백 루프!
  우리: quality-checker ≈ 이 패턴 (품질 실패 → 재시도)

④ Coordinator-Worker (코디네이터-워커) ★ CC 핵심!
  코디네이터: 태스크 분해 + 결과 종합 + 품질 게이트
  워커: 격리 컨텍스트에서 전문 작업
  우리: 블로팀 blo.js(코디네이터) + gems/pos(워커) ≈ 유사!

⑤ Mailbox Pattern (메일박스)
  워커가 위험 작업 → 코디네이터 대기열에 요청
  코디네이터가 승인/거부
  우리: ❌ 없음 (모든 작업 자동 실행)

⑥ Consensus Validation (합의 검증)
  여러 에이전트가 독립적으로 판단 → 다수결/합의
  우리: 루나팀 Bull/Bear 토론 ≈ 이 패턴!

⑦ Build to Delete (삭제 가능 설계)
  "어제의 스마트 로직을 오늘 뜯어낼 수 있게"
  모델이 좋아지면 하네스 로직 제거
  우리: ❌ 코드에 로직 하드코딩 (제거 어려움)
```

---

## 4. 우리 시스템 적용 로드맵

### 4-1. 즉시 적용 (P0)

```
① MAX_CONSECUTIVE_FAILURES = 5
  파일: packages/core/lib/llm-fallback.js
  방법: 세션당 연속 실패 카운터, 5회 시 중단+알림
  효과: 불필요한 호출 방지 (CC에서 25만/일 절약)
  난이도: ★☆☆ (3줄 추가)

② Strict Write Discipline
  파일: ~/self-improving/ 갱신 로직
  방법: 작업 성공 확인 후에만 memory.md 갱신
  효과: 잘못된 학습 방지
  난이도: ★☆☆
```

### 4-2. 단기 (P1, 1~2주)

```
③ 도구별 권한 레이어
  파일: skill-selector.js, tool-selector.js
  방법: 각 스킬/도구에 permission 필드 추가
    { name: 'order-execute', permission: 'approve' }
    { name: 'blog-write', permission: 'auto' }
  효과: "시도 vs 허용" 분리, 보안 강화
  난이도: ★★☆

④ 야간 메모리 증류 (autoDream)
  파일: scripts/nightly-distill.js (신규)
  방법:
    23:00 cron → 하루 로그 수집
    → LLM(로컬 gemma4)으로 패턴 추출
    → 모순 탐지 + 관찰→사실 전환
    → memory.md 업데이트 + corrections.md 기록
  효과: 매일 학습 품질 자동 향상
  난이도: ★★☆

⑤ Progressive Disclosure (도구 서브셋)
  파일: runtime-profiles.js
  방법: 팀별 활성 도구 목록 제한
    blog: ['blog-write', 'seo-check', 'image-gen', 'publish']
    luna: ['ta-analysis', 'news-search', 'order-execute', 'portfolio']
  효과: 도구 혼란 방지, 정확도 향상
  난이도: ★★☆
```

### 4-3. 중기 (P2, 2~4주)

```
⑥ 컨텍스트 압축 1단계 (MicroCompact)
  파일: packages/core/lib/context-compactor.js (신규)
  방법: 오래된 도구 결과 자동 트리밍
  효과: 장시간 에이전트 컨텍스트 유지
  난이도: ★★☆

⑦ 메일박스 패턴 (위험 작업 대기열)
  파일: packages/core/lib/approval-queue.js (신규)
  방법:
    고위험 작업(투자 실행, 데이터 삭제) → 대기열
    → 텔레그램으로 마스터 승인 요청
    → 승인 시 실행, 거부 시 취소
  효과: 자율성 + 안전성 균형
  난이도: ★★★

⑧ AgentTool 패턴 (서브에이전트 스폰)
  파일: packages/core/lib/agent-tool.js (신규)
  방법: 에이전트가 다른 에이전트를 도구로 호출
    await callAgent('research', { topic: 'Node.js 최신 트렌드' })
  효과: 병렬 실행 + 복잡 태스크 분해
  난이도: ★★★
```

### 4-4. 장기 (P3, 1~2개월)

```
⑨ 컨텍스트 압축 2~3단계 (AutoCompact + FullCompact)
  방법: LLM으로 세션 요약 생성 + 전체 압축
  효과: 무한 대화 가능 (컨텍스트 엔트로피 해소)
  난이도: ★★★

⑩ 프롬프트 기반 오케스트레이션
  방법: blo.js 판단 로직 일부를 시스템 프롬프트로 전환
  효과: 배포 없이 행동 변경 (CC 패턴)
  난이도: ★★★

⑪ Build to Delete 아키텍처
  방법: 하네스 로직을 모듈화, 모델 향상 시 제거 가능
  효과: 미래 모델 업그레이드에 유연 대응
  난이도: ★★☆ (설계 원칙)
```

---

## 5. 핵심 인사이트 요약

```
"에이전트 루프는 20줄. 하네스는 512,000줄."
  → 우리가 겪었던 난제(권한, 도구, 서브에이전트, 메모리)는
    바로 이 "하네스"의 핵심 구성요소!
  → 모델을 바꾸는 것보다 하네스를 개선하는 것이 효과적

"도구를 줄이면 결과가 좋아진다." (Vercel)
  → 33개 스킬이 모든 에이전트에 열려있을 필요 없음
  → 팀별 서브셋 제한이 정확도 향상

"모델이 시도를 결정하고, 시스템이 허용을 결정한다." (CC)
  → 현재: LLM 호출 → 바로 실행
  → 개선: LLM 호출 → 권한 체크 → 실행 (분리!)

"메모리는 힌트, 코드베이스로 검증한다." (CC)
  → 현재: memory.md를 신뢰하고 바로 사용
  → 개선: memory.md는 참조, 실제 파일/DB로 검증

"삭제할 수 있도록 만들어라." (Phil Schmid)
  → 모델이 좋아지면 하네스 로직 제거 가능해야
  → Standing Orders가 이 원칙에 가까움!

"2025년은 에이전트, 2026년은 하네스."
  → 우리는 이미 90에이전트 + 9팀 하네스를 구축함
  → CC 패턴을 흡수하면 프로덕션급 하네스 완성
```

---

## 6. 출처

```
[1] CC 유출 분석: alex000kim.com/posts/2026-03-31-claude-code-source-leak
[2] 에이전트 하네스 2026: philschmid.de/agent-harness-2026
[3] 하네스 엔지니어링: anup.io/harness-engineering
[4] 에이전트 아키텍처: morphllm.com/agent-engineering
[5] CC 하네스 아키텍처: wavespeed.ai/blog/posts/claude-code-agent-harness-architecture
[6] 7 아키텍처 레슨: particula.tech/blog/claude-code-source-leak-agent-architecture-lessons
[7] 2026 에이전트 트렌드: machinelearningmastery.com/7-agentic-ai-trends-to-watch-in-2026
[8] 에이전틱 아키텍처: neo4j.com/blog/agentic-ai/agentic-architecture
[9] 2025→2026: aakashgupta.medium.com/2025-was-agents-2026-is-agent-harnesses
[10] CC 분석 (Medium): medium.com/@marc.bara.iniesta/what-claude-codes-source-leak-actually-reveals
```

---

## 추가 연구 과제

```
□ CC coordinatorMode 프롬프트 원문 → 블로팀 오케스트레이터에 적용
□ CC 3-tier 메모리 Strict Write Discipline → self-improving 강화
□ CC AgentTool 스폰 패턴 → 에이전트 간 위임 설계
□ CC promptCacheBreakDetection 14벡터 → 캐시 최적화
□ Vercel "도구 80% 제거" 패턴 → 팀별 도구 서브셋 실험
□ Phil Schmid "Build to Delete" → 아키텍처 모듈화 원칙 적용
□ Neo4j 지식 그래프 → pgvector + 관계 그래프 하이브리드 검토
□ KAIROS /dream + autoDream → 야간 증류 상세 설계
□ Manus 5회 재작성 교훈 → 우리 하네스 리팩토링 전략
```


---

## 7. 서브에이전트 감독 패턴 — 심층 연구

### 7-1. 왜 감독이 핵심인가?

```
"에이전트를 만들면서 가장 어려웠던 것:
  권한, 도구, 서브에이전트, 메모리 관리" — 제이

이 모든 난제의 공통 뿌리:
  "누가 무엇을 감독하고, 어디까지 자율 행동을 허용하는가?"

Cursor의 교훈 ★:
  시도1: 동등 지위 에이전트 + 락킹 → 20개 에이전트가 2~3개 수준으로 저하!
  시도2: 낙관적 동시성 → 에이전트가 위험 회피적으로 변함!
  시도3 (성공): 3역할 계층 (Planner-Worker-Judge)
    Planner: 코드베이스 탐색 + 태스크 생성
    Worker: 할당된 태스크만 실행 (서로 조율 않함!) + 완료 시 푸시
    Judge: 각 사이클 끝에서 계속 여부 결정

핵심:
  "동등 에이전트는 확장 안 됨. 계층이 확장됨."
  "워커는 서로 조율하지 않는다. 코디네이터만 전체 그림을 본다."
```

### 7-2. 감독 패턴 5가지 ★

```
━━━ 패턴 1: Supervisor (감독자) ━━━

  ┌──────────────┐
  │  Supervisor   │ → 태스크 분해, 에이전트 선택, 결과 종합
  └──┬───┬───┬───┘
     │   │   │
  ┌──┴┐ ┌┴──┐ ┌┴──┐
  │W-1│ │W-2│ │W-3│ → 전문 에이전트, 제한된 도구, 좁은 역할
  └───┘ └───┘ └───┘

  특징:
    - 감독자가 목표를 보유, 워커는 서브태스크만 수행
    - 워커 실패 시 감독자가 감지+대응
    - "약한 작업을 승인하지 마라" (CC)
  우리 적용: 블로팀 blo.js = Supervisor, gems/pos = Worker

━━━ 패턴 2: Planner-Worker-Judge (계획-실행-심판) ━━━

  ┌──────────┐    ┌──────────┐    ┌──────────┐
  │ Planner  │ →  │ Workers  │ →  │  Judge   │
  │태스크 생성│    │병렬 실행  │    │계속 여부  │
  └──────────┘    └──────────┘    └──────────┘
       ↑                               │
       └───────────────────────────────┘
                  (반복)

  특징:
    - Cursor가 검증한 확장 가능 패턴!
    - 워커 간 조율 없음 (각자 독립 실행)
    - Judge가 품질 게이트 역할
  우리 적용: 루나팀 DAG + Bull/Bear + final-decision ≈ 유사

━━━ 패턴 3: Sparse Supervision (희소 감독) ━━━

  사람: "핵심 결정 10%만 감독"
  에이전트: "루틴 90%는 자율 처리"

  특징:
    - 루틴 작업 = 자동 실행
    - 엣지 케이스 = 사람에게 에스컬레이션
    - 사람의 희소 피드백을 에이전트가 학습!
  우리 적용: Standing Orders = 이 패턴! (3회 성공 → 자동 규칙)

━━━ 패턴 4: Mailbox (메일함) ━━━

  워커 → [위험 작업 요청] → Mailbox → 코디네이터 승인/거부

  특징:
    - 위험한 작업을 비동기 대기열에 넣음
    - 코디네이터(또는 사람)가 검토 후 승인
    - CC의 위험 도구 호출 패턴
  우리 적용: ❌ 없음 → 감정팀/루나팀에 필요!

━━━ 패턴 5: Consensus/Debate (합의/토론) ━━━

  Agent-A ──┐
  Agent-B ──┼→ 독립 판단 → 다수결/합의 → 최종 결정
  Agent-C ──┘

  특징:
    - 다양한 관점으로 편향 감소
    - 토론을 통한 품질 향상
    - 비용: N배 LLM 호출
  우리 적용: 루나팀 Bull/Bear 토론 = 이 패턴! ★
```

### 7-3. 하네스 엔지니어링 — 2026년 핵심 규율

```
정의:
  "AI 에이전트가 안전하고 확장 가능한 소프트웨어를 생산하도록
   제약조건, 도구, 피드백 루프, 문서, 검증 시스템을 설계하는 규율"

6대 원칙 (2026 업계 합의):

① Start Simple — 복잡한 제어 흐름 만들지 마라
   "견고한 원자적 도구를 제공하라. 모델이 계획을 세우게 하라."
   우리: ✅ 개별 스킬/도구가 단순 → 좋은 출발!

② Build to Delete — 어제의 스마트 로직을 오늘 뜯어낼 수 있게
   "모델이 좋아지면 하네스 로직을 제거할 수 있어야"
   우리: ❌ 코드에 판단 로직 하드코딩 → 제거 어려움

③ Engineer Corrections Permanently — 일회성 수정을 영구 제약으로
   "에이전트 실수 → 출력만 수정하지 말고, 시스템이 재발 방지하도록 설계"
   우리: ✅ Standing Orders = 이 원칙! (3회 반복 → 규칙 승격)

④ Minimal Necessary Intervention — 모델이 자기교정 못할 때만 개입
   "비가역적 행동이나 보안 경계에서만 개입"
   우리: ❌ 과도한 코드 제어 (if/else) vs ✅ DEV/OPS 분리

⑤ Monitor Entropy — 장기 프로젝트에서 드리프트 감시
   "리팩터 에이전트를 정기 실행하여 일관성 유지"
   우리: ❌ 없음 → Doctor가 이 역할 확장 가능!

⑥ Instrument for Traceability — 모든 에이전트 스텝 로깅
   "비결정적 멀티스텝 흐름에서 전통 로깅은 실패"
   우리: ✅ traceCollector + llm-logger (기본 존재)
```

### 7-4. 감독 깊이 — 3단계 모델

```
┌─────────────────────────────────────────┐
│ Level 3: 전략적 감독 (마스터)            │
│   "무엇을 왜 해야 하는가?"              │
│   빈도: 일 1회, 핵심 결정만              │
│   → 제이의 역할                         │
├─────────────────────────────────────────┤
│ Level 2: 전술적 감독 (코디네이터)        │
│   "이 작업이 기준에 맞는가?"             │
│   빈도: 태스크마다, 자동화 가능           │
│   → blo.js, l13-final-decision          │
│   → quality-checker, Doctor             │
├─────────────────────────────────────────┤
│ Level 1: 실행 (워커)                     │
│   "할당된 태스크를 실행한다"              │
│   빈도: 항상 자동                        │
│   → gems-writer, pos-writer, 각 노드    │
└─────────────────────────────────────────┘

핵심: Level 2를 얼마나 자동화하느냐가 시스템 성숙도!
  초기: Level 2 = 코드 (if/else)
  중기: Level 2 = 프롬프트 (CC 패턴)
  고급: Level 2 = 학습된 규칙 (Standing Orders + RAG)
```

---

## 8. 우리 시스템 적용 — 서브에이전트 감독 로드맵

```
즉시 (P0):
  ① 연속 실패 제한 — 감독 없이 무한 실행 방지
  ② Strict Write — 실패 결과가 학습에 오염 방지

단기 (P1):
  ③ 루나팀 독립 노드 병렬화 + Judge 패턴 추가
     l03+l04+l05 병렬 → l10에서 Judge 역할 (결과 품질 확인)
  ④ Doctor "예방적 스캔" = Planner 역할 확장
     현재: 문제 감지 후 복구
     개선: 문제 징후 탐지 → 선제 조치
  ⑤ 야간 메모리 증류 = "Engineer Corrections Permanently"
     매일 실수 패턴 수집 → 영구 규칙화

중기 (P2):
  ⑥ Mailbox 패턴 도입 (감정팀/루나팀)
     고위험 작업 → 텔레그램 승인 대기열
  ⑦ 에이전트 오피스에 감독 대시보드
     워커별 성공률, 실패 유형, 비용, 응답시간
  ⑧ quality-checker를 프롬프트 기반 Judge로 전환

장기 (P3):
  ⑨ Planner-Worker-Judge 완전 구현
     코디네이터가 계획 → 워커 병렬 실행 → Judge 평가 → 반복
  ⑩ Sparse Supervision 학습 루프
     마스터의 승인/거부 패턴 → RAG → 자동 판단 점진 확대
  ⑪ Monitor Entropy — 드리프트 감시 에이전트
     코드베이스 일관성 정기 점검 → 자동 리팩토링 제안
```
