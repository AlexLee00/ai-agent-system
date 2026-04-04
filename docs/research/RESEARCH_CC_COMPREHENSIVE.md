# 클로드 코드 유출 종합 연구 — 에이전트 하네스 · 아키텍처 · 팀별 분석

> 작성: 메티 (Claude Opus 4.6)
> 작성일: 2026-04-04
> 범위: CC 유출 분석 + 에이전트 하네스 + 9팀 딥 분석 + 개선 로드맵
> 통합 대상: RESEARCH_CLAUDE_CODE_LEAK + TEAM_ARCHITECTURE_REVIEW + AGENT_HARNESS + TEAM_DEEP_ANALYSIS

---

## 1. 사건 개요

2026-03-31, npm 소스맵 실수로 클로드 코드 512,000줄 TypeScript 유출.
1,906파일, 44 피처 플래그, 전체 에이전트 하네스 아키텍처 노출.
핵심: 모델 가중치가 아닌 "하네스(harness)" — 도구/메모리/권한/오케스트레이션 체계.

---

## 2. 에이전트 하네스란?

"모델은 상품. 하네스가 해자." "루프는 20줄. 하네스는 512,000줄."

### 하네스 6대 구성요소

① 프롬프트 — 시스템 프롬프트, 페르소나. CC: 프롬프트 기반 오케스트레이션 (배포 없이 변경)
② 메모리 — 단기/장기/작업. CC: 3계층(MEMORY.md→토픽→트랜스크립트) + Strict Write + autoDream
③ 도구 — 권한 게이팅된 모듈. CC: ~40도구, 29,000줄 정의, "시도 vs 허용" 분리
④ 오케스트레이션 — 계획+실행+검증 루프. CC: Coordinator-Worker, 프롬프트 기반 위임
⑤ 가드레일 — 권한/격리/복구. CC: 4티어 권한, bashSecurity 23항목, mailbox 패턴
⑥ 관측성 — 로그/트레이스/디버그. CC: 14 캐시파괴벡터, frustration 정규식

### 하네스 엔지니어링 6대 원칙 (2026 업계 합의)

① Start Simple — 복잡한 제어 흐름 만들지 마라. 원자적 도구 + 모델이 계획
② Build to Delete — 모델 향상 시 하네스 로직 제거 가능하게
③ Engineer Corrections Permanently — 일회성 수정을 영구 제약으로 (≈ Standing Orders!)
④ Minimal Necessary Intervention — 비가역적 행동/보안 경계에서만 개입
⑤ Monitor Entropy — 리팩터 에이전트 정기 실행, 드리프트 감시
⑥ Instrument for Traceability — 모든 에이전트 스텝 로깅

---

## 3. 5대 난제 — CC 해법 + 우리 현황

### 3-1. 권한 (Permission)

CC: 4티어 (Trust→Check→Approve→Bypass). "시도 vs 허용" 분리.
TJ: DEV/OPS 4중 안전장치 ✅ / 도구별 세밀 권한 ❌ / "시도 vs 허용" 분리 ❌
적용: skill-selector에 permission 필드 (auto/approve/block). 팀별 권한 프로필.

### 3-2. 도구 (Tool)

CC: ~40도구, 플러그인 아키텍처. Vercel: "80% 제거하니 결과 좋아짐!"
TJ: 33스킬+4MCP+62코어 ✅ / 팀별 서브셋 제한 ❌ / Build to Delete ❌
적용: 팀별 도구 서브셋 (루나 5개, 블로 4개). 미사용 도구 비활성화. Progressive Disclosure.

### 3-3. 서브에이전트 (Sub-agent)

CC: 격리 워크트리 + 메일박스 + 캐시 공유. AgentTool로 스폰.
Cursor 교훈: 동등에이전트 실패 → 3역할계층(Planner-Worker-Judge) 성공!
TJ: 9팀 격리 ✅ / hiring-contract ✅ / 병렬 실행 ❌ / 메일박스 ❌ / 캐시 공유 ❌
적용: Promise.allSettled 병렬화, AgentTool 패턴, 코디네이터→워커 확장.

### 3-4. 메모리 (Memory)

CC: 3계층 + Strict Write Discipline + autoDream (야간 메모리 증류).
"메모리는 힌트. 코드베이스로 검증."
TJ: pgvector RAG ✅ / self-improving ✅ / StrictWrite ❌ / autoDream ❌
적용: P0 성공시만 기록, P1 nightly-distill.js, P2 핫/콜드 메모리 분리.

### 3-5. 컨텍스트 (Context)

CC: 4단계 압축 (MicroCompact→AutoCompact→FullCompact→Time-based).
MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3 (25만 호출/일 절약).
TJ: 로그 로테이션만 ✅ / 4단계 압축 전체 ❌ ← 가장 큰 Gap!
적용: P0 연속실패제한, P1 MicroCompact, P2 AutoCompact, P3 FullCompact.

---

## 4. 서브에이전트 감독 패턴 5가지

① Supervisor — 감독자가 분해+위임+종합. CC coordinatorMode. TJ: blo.js ≈ 유사.
② Planner-Worker-Judge — Cursor 검증. 계획→병렬실행→품질판단→반복. TJ: 루나 DAG ≈ 유사.
③ Sparse Supervision — 루틴 90% 자율, 핵심 10% 감독. TJ: Standing Orders = 이 패턴!
④ Mailbox — 위험 작업 비동기 승인 대기열. TJ: ❌ 없음 → 감정팀/루나팀 필요.
⑤ Consensus/Debate — 다자간 독립 판단 + 합의. TJ: Bull/Bear 토론 = 이 패턴!

감독 깊이 3단계:
  Level 3 전략 (마스터 제이): "무엇을 왜?" — 일 1회
  Level 2 전술 (코디네이터): "기준에 맞는가?" — 자동화 핵심!
  Level 1 실행 (워커): "할당 태스크 수행" — 항상 자동

---

## 5. 에이전틱 AI 7대 패턴

① Plan-Act-Verify — 계획 분해→행동→결과 확인→계속. TJ: 파이프라인 ≈ 유사.
② Progressive Disclosure — 최소 지시 → 필요 시 추가 로드. TJ: ❌ 전체 로드.
③ Red-Green Testing — 실패 테스트→에이전트 통과. TJ: quality-checker ≈ 유사.
④ Coordinator-Worker — 코디네이터 위임+품질게이트. TJ: 블로/루나 ≈ 유사.
⑤ Mailbox — 위험 작업 대기열. TJ: ❌ 없음.
⑥ Consensus — 다자간 판단. TJ: Bull/Bear ✅.
⑦ Build to Delete — 모듈화, 모델 향상 시 제거. TJ: ❌ 하드코딩.

---

## 6. 규모 비교

```
                   클로드 코드              팀 제이
파일 수            1,906 TS               1,781 JS
총 줄수            512,000줄              ~200,000줄
에이전트           1 (+서브에이전트)       90 / 9팀
도구               ~40 빌트인             33스킬+4MCP+62코어
코어               QueryEngine 46K줄      코어 63파일/14K줄
```

---

## 7. 팀별 심층 분석 + CC Gap

### 코어 모듈 (13,973줄/63파일)
- llm-fallback 687줄: 4단계폴백 ✅>CC / 연속실패제한 ❌ / 서킷브레이커 ❌
- hiring-contract 258줄: ε-greedy ★CC에 없음! / 도구서브셋 ❌
- competition-engine 162줄: 경쟁 ★CC에 없음! / 피드백루프 ❌
- shadow-mode 523줄: A/B검증 ★CC에 없음!
- rag.js 354줄: pgvector ✅ / StrictWrite ❌ / autoDream ❌

### 오케스트레이터 (10,146줄/48파일)
- intent-parser 698줄: 3단계파싱 ✅ / 프롬프트오케스트레이션 ❌
- night-handler 483줄: ≈KAIROS ✅ / 야간증류 ❌ / 5분주기 ❌

### 루나/투자 (28,363줄/101파일)
- 15노드 DAG: CC보다 정교 ✅ / Bull/Bear토론 ✅ / 병렬 ❌ / 피드백루프 ❌

### 클로드팀 (12,345줄/58파일)
- Doctor 458줄: scanAndRecover ✅>CC / getPastSuccessfulFix ✅ / 예방스캔 ❌
- autofix 296줄: reportInsteadOfFix ✅ / 3단계권한 ❌

### 워커팀 (36,094줄/288파일)
- chat-agent 876줄: 리팩토링 필요! / approval ≈ CC mailbox
- 에이전트 오피스: CC에 없는 시각적 관리 ✅ / CC메트릭 대시보드 ❌

### 스카팀 (58,238줄/294파일)
- forecast.py 2,047줄: 최대 안티패턴! 분리 시급
- Python↔Node 혼합: 통신 인터페이스 표준화 필요

### 비디오팀 (11,652줄/48파일)
- critic/refiner: CC Coordinator-Worker ≈ 유사 ✅
- edl-builder 971줄: 분리 후보

### 신규팀 (연구/감정/데이터)
- 연구: KAIROS/dream 적합, Coordinator-Worker
- 감정: 4티어 권한+StrictWrite 필수, Mailbox 패턴
- 데이터: MicroCompact 필수, Progressive Disclosure

---

## 8. CC 하네스 6구성요소 vs 우리 시스템

| 구성요소 | CC | TJ | Gap |
|---------|----|----|-----|
| 프롬프트 | 프롬프트 기반 오케스트레이션 | 코드 if/else | ★★★ |
| 메모리 | 3계층+StrictWrite+autoDream | pgvector+self-improving | ★★☆ |
| 도구 | 40도구+권한게이트+"시도vs허용" | 33스킬+4MCP+62코어 | ★☆☆ |
| 오케스트레이션 | Coordinator-Worker 병렬+캐시공유 | 9팀×에이전트, 병렬 약 | ★★☆ |
| 가드레일 | 4티어 권한+bashSecurity+mailbox | DEV/OPS 분리+guard 3종 | ★☆☆ |
| 관측성 | tracing+14캐시벡터 | traceCollector+llm-logger | ★☆☆ |

## 9. 우리만의 강점 (CC에 없음!)

- ★ hiring-contract ε-greedy 동적 고용
- ★ competition-engine 에이전트 경쟁 (월/수/금)
- ★ shadow-mode A/B 검증
- ★ Doctor scanAndRecover 자율 복구 (KAIROS 미출시, 우리는 운영 중!)
- ★ Standing Orders 자동 규칙화 ≈ "Engineer Corrections Permanently"
- ★ 4단계 LLM 폴백 (로컬→Groq→OpenAI→Anthropic)
- ★ 로컬 LLM 비용 $0 (MLX qwen2.5-7b + deepseek-r1-32b)

## 10. 대규모 파일 안티패턴 (CC print.ts 5,594줄 교훈)

| 파일 | 줄수 | 팀 | 상태 |
|------|------|------|------|
| forecast.py | 2,047 | 스카 | 최우선 분리! |
| blo.js | 991 | 블로 | A-3 진행중 |
| edl-builder.js | 971 | 비디오 | P1 분리 |
| rebecca.py | 937 | 스카 | P2 분리 |
| chat-agent.js | 876 | 워커 | P1 분리 |

---

## 11. 종합 개선 로드맵

### P0 즉시
1. **연속 실패 제한** — llm-fallback.js에 MAX_CONSECUTIVE_FAILURES=5 (3줄!)
2. **Strict Write Discipline** — rag.js 성공 시에만 메모리 기록

### P1 단기 (1~2주)
3. **야간 메모리 증류** — nightly-distill.js (autoDream 패턴)
4. **도구별 권한 레이어** — skill-selector permission 필드 (auto/approve/block)
5. **대규모 파일 분리** — forecast.py 2,047줄, chat-agent.js 876줄
6. **루나 독립 노드 병렬화** — l03+l04+l05 Promise.allSettled
7. **Doctor 예방적 스캔** — 경고 징후 탐지 (Planner 확장)

### P2 중기 (2~4주)
8. **컨텍스트 압축** — context-compactor.js (MicroCompact+AutoCompact)
9. **Mailbox 패턴** — approval-queue.js (위험 작업 승인 대기열)
10. **AgentTool 패턴** — agent-tool.js (에이전트 간 위임/스폰)
11. **에이전트 오피스 CC 메트릭** — 실패율/비용/캐시히트 대시보드

### P3 장기 (1~2개월)
12. **KAIROS 자율 데몬** — 5분 주기 환경 모니터링+자율 대응
13. **프롬프트 기반 오케스트레이션** — 코드→프롬프트 전환 (배포 없이 변경)
14. **Build to Delete 아키텍처** — 모듈화, 모델 향상 시 제거 가능

---

## 12. 핵심 인사이트

"클로드 코드는 512K줄의 단일 에이전트 하네스.
 팀 제이는 200K줄의 멀티팀 에이전트 생태계.
 CC의 컨텍스트 관리+메모리 패턴을 흡수하면
 어느 쪽도 단독으로 달성하지 못한
 '자율 진화하는 멀티도메인 에이전트 시스템'이 완성된다."

---

## 13. 출처

- [1] CC 유출 분석: alex000kim.com (2026-03-31)
- [2] Agent Harness 2026: philschmid.de
- [3] Harness Engineering: anup.io
- [4] Agent Engineering: morphllm.com
- [5] CC Harness Architecture: wavespeed.ai
- [6] 7 Architecture Lessons: particula.tech
- [7] 7 Agentic Trends 2026: machinelearningmastery.com
- [8] Agentic Architecture: neo4j.com
- [9] 2025→2026 Harness: aakashgupta.medium.com
- [10] CC Leak Analysis: medium.com/@marc.bara.iniesta
- [11] Agentic Design Patterns: sitepoint.com
- [12] Supervisor Pattern: docs.kore.ai
- [13] AI Coding Agents Coherence: mikemason.ca
- [14] Agentic Workflows: stackai.com
