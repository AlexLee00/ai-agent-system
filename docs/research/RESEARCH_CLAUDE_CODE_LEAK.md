# 클로드 코드 유출 vs 팀 제이 ai-agent-system — 전체 아키텍처 비교 분석

> 작성: 메티 (Claude Opus 4.6)
> 작성일: 2026-04-04
> 상태: 🔬 연구 (심층 분석 필요)
> 범위: ai-agent-system 전체 (9팀, 90에이전트, 1,781 JS파일, 62모듈)

---

## 1. 규모 비교

```
                        클로드 코드              팀 제이
파일 수                 1,906 TS파일            1,781 JS파일
총 줄수                 512,000줄               ~80,000줄+ (추정)
에이전트 수             1 (+ 서브에이전트)      90 에이전트 / 9팀
도구(Tool) 수           ~40개 빌트인            33 스킬 + 4 MCP + 62 코어모듈
코어 모듈               QueryEngine 46,000줄    코어 63파일 / 13,973줄
가장 큰 파일            QueryEngine 46,000줄    blo.js 991줄
                        print.ts 5,594줄        gems-writer.js 1,099줄
```

---

## 2. 에이전트 아키텍처 비교

### 2-1. 클로드 코드 패턴

```
Coordinator Mode (프로덕션급 멀티에이전트):
  ┌─────────────────────────┐
  │  Coordinator Agent      │ ← 프롬프트 기반 오케스트레이션!
  │  "약한 작업을 승인하지마"│    (코드가 아니라 시스템 프롬프트)
  │  "이해 전에 넘기지 마라" │
  └─────┬───┬───┬───────────┘
        │   │   │
  ┌─────┴┐ ┌┴───┴┐ ┌────────┐
  │Worker│ │Worker│ │Worker  │ ← 격리된 컨텍스트
  │파일편집│ │검색분석│ │테스트실행│   제한된 도구 권한
  └──────┘ └─────┘ └────────┘   프롬프트 캐시 공유!

핵심 특징:
  ① AgentTool — 서브에이전트를 "도구 호출"로 스폰
  ② 프롬프트 기반 오케스트레이션 — 배포 없이 행동 변경 가능
  ③ 프롬프트 캐시 공유 — 서브에이전트가 컨텍스트 비용 공유
  ④ 격리 — 워커가 메인 에이전트 추론을 오염시키지 않음
  ⑤ 승인 게이트 — 위험한 작업은 코디네이터 승인 필요
```

### 2-2. 팀 제이 패턴

```
현재 구조 (9팀 × 멀티에이전트):
  ┌─────────────────────────┐
  │  마스터 (제이)           │ ← 최종 승인
  └─────┬───────────────────┘
  ┌─────┴───────────────────┐
  │  메티 (Claude Opus)      │ ← 기획+설계+검증
  └─────┬───────────────────┘
  ┌─────┴───────────────────┐
  │  코덱스 (Claude Sonnet)  │ ← 구현+커밋+푸시
  └─────────────────────────┘
        │
  ┌─────┴──────────────────────────────────┐
  │  9팀 × 각 팀별 에이전트들              │
  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐  │
  │  │루나10│ │블로26│ │클로5 │ │스카8 │  │
  │  │워커7 │ │에디5 │ │연구15│ │감정10│  │
  │  │데이터6│                             │
  │  └──────┘ └──────┘ └──────┘ └──────┘  │
  └────────────────────────────────────────┘

핵심 특징:
  ① hiring-contract.js — 동적 에이전트 선택 (ε-greedy!)
  ② 코드 기반 오케스트레이션 — blo.js 등이 if/else로 판단
  ③ 경쟁 시스템 — 에이전트 간 성과 경쟁 (월/수/금)
  ④ 팀 격리 — 팀 내에서만 에이전트 선택
  ⑤ Standing Orders — 반복 패턴 자동 규칙화
```

### 2-3. Gap 분석 ★

```
클로드 코드에 있고 우리에게 없는 것:
━━━━━━━━━━━━━━━━━━━━━━

Gap 1: 프롬프트 기반 오케스트레이션
  CC: 코디네이터 행동이 시스템 프롬프트 → 배포 없이 변경 가능
  TJ: blo.js/maestro.js가 코드로 판단 → 변경하려면 코드 수정+배포
  영향: ★★★ (유연성, 반복 속도)
  대안: Standing Orders가 일부 역할. 하지만 오케스트레이션 레벨은 아님

Gap 2: 서브에이전트 스폰 (AgentTool)
  CC: 도구 호출로 서브에이전트 스폰 → 병렬 실행 + 격리
  TJ: 에이전트가 순차 실행 → 병렬 처리 없음
  영향: ★★☆ (성능, 복잡 태스크)
  대안: Node.js Promise.allSettled로 병렬화 가능 (일부 구현됨)

Gap 3: 프롬프트 캐시 공유
  CC: 서브에이전트가 캐시 공유 → 비용 대폭 절감
  TJ: 각 LLM 호출이 독립적 → 중복 컨텍스트 비용
  영향: ★★★ (비용)
  대안: 로컬 LLM 사용으로 비용 $0 (이미 해결!)

Gap 4: 3단계 컨텍스트 압축
  CC: MicroCompact(로컬) → AutoCompact(요약) → FullCompact(전체)
  TJ: 없음. 대화가 길어지면 단순 잘림
  영향: ★★☆ (장시간 작업 품질)
  대안: 로컬 LLM 컨텍스트가 짧아서 당장 필요성 낮음

Gap 5: 4티어 권한 시스템 (도구별)
  CC: 도구마다 독립 권한 (read/write/execute/admin)
  TJ: DEV/OPS 2분리 + 모드가드. 도구별 세밀 권한 없음
  영향: ★☆☆ (보안, 현재 규모에서는 충분)

우리에게 있고 클로드 코드에 없는 것:
━━━━━━━━━━━━━━━━━━━━━━

강점 1: 멀티팀 경쟁 시스템!
  CC: 에이전트 간 경쟁 없음 (단일 에이전트 패턴)
  TJ: 90에이전트 × 9팀 × ε-greedy 경쟁 → 자연 수렴!

강점 2: 도메인 특화 에이전트!
  CC: 범용 코딩 에이전트 1개
  TJ: 루나(투자) + 블로(블로그) + 스카(스터디카페) + 에디(영상) 등

강점 3: 로컬 LLM 비용 $0!
  CC: Anthropic API 의존 (비용 발생)
  TJ: MLX qwen2.5-7b + deepseek-r1-32b → 비용 $0

강점 4: Standing Orders 자동 규칙화!
  CC: 없음 (프롬프트 수동 관리)
  TJ: 3회 반복 → 자동 Standing Orders 승격
```

---

## 3. 메모리 시스템 비교

```
클로드 코드 3계층 메모리:
  Layer 1: MEMORY.md — 포인터 인덱스 (~150자/항목), 항상 컨텍스트에 로드
  Layer 2: 토픽 파일 — 실제 프로젝트 지식, 온디맨드 로드
  Layer 3: 로우 트랜스크립트 — 전체 읽기 없음, grep만

  핵심 원칙:
    "Strict Write Discipline" — 파일 쓰기 성공 후에만 메모리 업데이트
    "메모리는 힌트, 실제 코드베이스로 검증"
    autoDream — 유휴 시 메모리 정리, 모순 해결, 관찰→사실 전환

팀 제이 메모리:
  Layer 1: ~/self-improving/memory.md HOT — 핫 메모리
  Layer 2: ~/self-improving/corrections.md — 수정 이력
  Layer 3: ~/self-improving/domains/ — 도메인별 지식
  Layer 4: pgvector RAG — 벡터 검색 (경험 저장)

  Gap:
    ❌ "Strict Write Discipline" 없음 → 실패 시에도 메모리 갱신될 수 있음
    ❌ autoDream (야간 메모리 증류) 없음
    ❌ 메모리를 "힌트"로 취급하는 검증 패턴 없음
    ✅ RAG 벡터 검색은 CC보다 발전된 부분!
```

---

## 4. 도구/스킬 시스템 비교

```
클로드 코드:
  ~40 빌트인 도구 — 플러그인 아키텍처
  도구 정의: 29,000줄 TypeScript
  모델이 시도 결정 → 도구 시스템이 허용 결정 (분리!)
  3단계 승인: 프로젝트 로드 → 실행 전 체크 → 고위험 사용자 확인

팀 제이:
  33 스킬 + 4 MCP + 62 코어모듈
  skill-selector.js + tool-selector.js — 3계층 동적 선택
  hiring-contract.js — 에이전트 선택 (별도 관심사)

  Gap:
    ❌ "모델 시도 vs 도구 허용" 분리가 명확하지 않음
      → LLM이 호출하면 바로 실행되는 구조
    ❌ 도구별 독립 권한 체계 없음
    ✅ 3계층 동적 선택(Agent→Skill→Tool)은 CC보다 풍부!
    ✅ 에이전트×스킬×도구 조합 = CC에 없는 유연성
```

---

## 5. 컨텍스트 관리 비교

```
클로드 코드 4단계 압축:
  ① MicroCompact — 로컬 편집, API 호출 0, 도구 출력 트리밍
  ② AutoCompact — 컨텍스트 상한 접근 시, 13,000토큰 버퍼 예약, 20,000토큰 요약 생성
  ③ FullCompact — 전체 대화 압축 + 선택적 파일 재주입
  ④ Time-based — 오래된 도구 결과 자동 제거
  + MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3 (실패 제한)

팀 제이:
  ① 없음 — 로컬 트리밍 없음
  ② 없음 — 자동 압축 없음
  ③ 없음 — 전체 압축 없음
  ④ 부분 — 로그 로테이션만

  Gap: ★★★ 가장 큰 Gap!
    장시간 실행 에이전트(루나 실시간, 블로그 일일)에서
    컨텍스트 엔트로피 관리가 전혀 없음
    → 긴 실행 시 LLM 품질 저하 가능

  적용 방안:
    단기: LLM 호출 시 이전 대화 요약 전달 패턴 추가
    중기: autoCompact 유사 시스템 구현
    장기: KAIROS의 autoDream 패턴 적용
```

---

## 6. 보안 비교

```
클로드 코드:
  bashSecurity.ts — 23개 보안 검사
  18개 Zsh 빌트인 차단
  4티어 권한 (read → write → execute → admin)
  유니코드 zero-width 주입 방어
  IFS null-byte 방어
  네이티브 클라이언트 어테스테이션 (Zig 레벨)

팀 제이:
  DEV/OPS 분리 — 4중 안전장치 (.zprofile+config.yaml+hostname+applyDevSafetyOverrides)
  mode-guard.js — DEV_HUB_READONLY
  file-guard.js — 파일 접근 제한
  billing-guard.js — API 비용 제한
  pre-commit hooks — secrets-store.json 차단

  Gap:
    ❌ LLM 출력에 대한 보안 검증 없음 (프롬프트 인젝션 방어)
    ❌ 도구별 세밀 권한 없음
    ✅ DEV/OPS 분리는 CC보다 체계적!
    ✅ secrets-store.json 커밋 차단은 CC에 없음
```

---

## 7. 실패 처리 비교

```
클로드 코드:
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3 → 세션 비활성화
  서킷 브레이커 패턴
  재시도 로직 + 지수 백오프
  감정 감지 정규식 → 사용자 좌절 시 행동 변경

팀 제이:
  llm-fallback.js — 4단계 폴백 체인 (로컬→Groq→OpenAI→Anthropic)
  smart-restart — launchd 자동 재시작
  hub-client — 연결 실패 시 로컬 폴백
  scanAndRecover() — Doctor 자율 복구

  Gap:
    ❌ 세션 레벨 연속 실패 제한 없음
    ❌ 사용자 감정/좌절 감지 없음
    ✅ 4단계 LLM 폴백은 CC보다 풍부!
    ✅ Doctor 자율 복구 패턴은 CC에 없음
```

---

## 8. 종합 개선 제안 (우선순위)

### P0 — 즉시 적용 가능

```
1. 연속 실패 제한 (autoCompact 패턴)
   파일: llm-client.js / llm-fallback.js
   방법: 세션당 MAX_CONSECUTIVE_FAILURES = 5
   효과: 불필요한 API/LLM 호출 방지
   난이도: ★☆☆

2. Strict Write Discipline (메모리 검증)
   파일: self-improving/memory.md 갱신 로직
   방법: 성공 확인 후에만 메모리 업데이트
   효과: 잘못된 학습 방지
   난이도: ★☆☆
```

### P1 — 단기 (1~2주)

```
3. 야간 메모리 증류 (autoDream 패턴)
   신규: scripts/nightly-distill.js
   방법: 하루 로그 분석 → 패턴 추출 → memory.md 정리
   효과: 메모리 품질 지속 향상
   난이도: ★★☆

4. 프롬프트 기반 오케스트레이션 일부 전환
   파일: quality-checker.js (1차 대상)
   방법: AI탐지 리스크 판단을 LLM 프롬프트로 전환
   효과: 유연성 향상, 배포 없이 행동 변경
   난이도: ★★☆

5. 감정 감지 정규식 (댓글 분석)
   파일: commenter.js
   방법: 긍정/부정 정규식 1차 분류 → 부정만 LLM 분석
   효과: LLM 호출 50%+ 절감
   난이도: ★☆☆
```

### P2 — 중기 (2~4주)

```
6. 컨텍스트 압축 시스템
   신규: packages/core/lib/context-compactor.js
   방법: MicroCompact(로컬 트리밍) + AutoCompact(요약) 2단계
   효과: 장시간 에이전트 품질 유지
   난이도: ★★★

7. 도구-에이전트 권한 분리
   파일: skill-selector.js, tool-selector.js
   방법: "모델이 시도 결정 vs 시스템이 허용 결정" 분리
   효과: 보안 + 예측 가능성
   난이도: ★★☆

8. 프롬프트 캐시 최적화
   파일: gems-writer.js, pos-writer.js
   방법: 시스템 프롬프트 "불변+가변" 분리 → Anthropic 캐싱 활용
   효과: 외부 API 호출 시 비용 절감
   난이도: ★★☆
```

### P3 — 장기 (1~2개월)

```
9. KAIROS 유사 자율 데몬
   신규: packages/core/lib/kairos-daemon.js
   방법: 5분 cron → 환경 모니터링 → 자율 대응
   효과: 완전 자율 운영 (deploy.sh 강화)
   난이도: ★★★

10. 피처 플래그 체계화
    방법: Standing Orders + config.yaml → GrowthBook 유사 시스템
    효과: 코드 변경 없이 기능 토글
    난이도: ★★☆

11. AgentTool 패턴 (서브에이전트 스폰)
    방법: 에이전트가 다른 에이전트를 도구로 호출
    효과: 병렬 실행 + 복잡 태스크 분해
    난이도: ★★★
```

---

## 9. 핵심 인사이트 요약

```
클로드 코드에서 배울 것:
  ① 프롬프트 기반 오케스트레이션 — 코드보다 유연
  ② 3계층 메모리 + Strict Write Discipline — 메모리 품질 보장
  ③ 컨텍스트 압축 — 장시간 실행의 핵심 과제
  ④ 연속 실패 제한 — 3줄로 25만 호출/일 절약
  ⑤ autoDream 야간 증류 — 매일 학습 정제

우리가 이미 앞서가는 것:
  ① 멀티팀 경쟁 시스템 — CC에 없음!
  ② 도메인 특화 90에이전트 — CC는 범용 1개
  ③ 로컬 LLM 비용 $0 — CC는 API 의존
  ④ Standing Orders — CC에 없음!
  ⑤ 4단계 LLM 폴백 — CC보다 풍부
  ⑥ Doctor 자율 복구 — CC에 없음!

한 줄 결론:
  "클로드 코드는 단일 에이전트의 극한을 보여줬고,
   팀 제이는 멀티에이전트 생태계의 가능성을 보여주고 있다.
   CC의 컨텍스트 관리 + 메모리 패턴을 흡수하면
   우리 시스템이 한 단계 더 진화한다."
```

---

## 추가 연구 과제

```
□ coordinatorMode 프롬프트 원문 분석 → 오케스트레이터 프롬프트 설계 참조
□ QueryEngine 46,000줄 구조 분석 → llm-client 리팩토링 참조
□ promptCacheBreakDetection 14벡터 분석 → 캐시 최적화 적용
□ bashSecurity 23항목 상세 분석 → Hub 보안 강화
□ KAIROS /dream + autoDream 상세 분석 → 야간 증류 설계
□ AgentTool 스폰 패턴 → 에이전트 간 위임 설계
□ 3계층 메모리 Strict Write Discipline → self-improving 강화
```
