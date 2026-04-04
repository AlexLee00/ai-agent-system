# 클로드 코드 유출 종합 연구 — 에이전트 하네스 · 아키텍처 · 팀별 분석

> 작성: 메티 (Claude Opus 4.6)
> 작성일: 2026-04-04
> 범위: CC 유출 분석 + 에이전트 하네스 + 9팀 딥 분석 + 개선 로드맵
> 통합: RESEARCH_CLAUDE_CODE_LEAK + TEAM_ARCHITECTURE_REVIEW + AGENT_HARNESS + TEAM_DEEP_ANALYSIS

---

## 1. 사건 개요

2026-03-31, npm 소스맵 실수로 클로드 코드 512,000줄 TypeScript 유출.
1,906파일, 44 피처 플래그, 전체 에이전트 하네스 아키텍처 노출.
핵심: 모델 가중치가 아닌 "하네스" — 도구/메모리/권한/오케스트레이션 체계.

---

## 2. 에이전트 하네스 — 정의 + 구성 + 원칙

"모델은 상품. 하네스가 해자." "루프는 20줄. 하네스는 512,000줄."

### 6대 구성요소
① 프롬프트 — CC: 프롬프트 기반 오케스트레이션 (배포 없이 변경)
② 메모리 — CC: 3계층(MEMORY.md→토픽→트랜스크립트)+Strict Write+autoDream
③ 도구 — CC: ~40도구, 29K줄, "시도 vs 허용" 분리
④ 오케스트레이션 — CC: Coordinator-Worker, 프롬프트 기반 위임
⑤ 가드레일 — CC: 4티어 권한, bashSecurity 23항목, mailbox
⑥ 관측성 — CC: 14 캐시파괴벡터, frustration 정규식

### 6대 원칙 (2026 업계 합의)
① Start Simple — 원자적 도구 + 모델이 계획
② Build to Delete — 모델 향상 시 제거 가능하게
③ Engineer Corrections Permanently — 일회성→영구 제약 (≈ Standing Orders!)
④ Minimal Necessary Intervention — 비가역적 행동/보안 경계에서만 개입
⑤ Monitor Entropy — 드리프트 감시, 리팩터 에이전트 정기 실행
⑥ Instrument for Traceability — 모든 에이전트 스텝 로깅

---

## 3. 5대 난제 + CC 해법 + 우리 현황

### 권한 (Permission)
CC: 4티어(Trust→Check→Approve→Bypass), "시도 vs 허용" 분리
TJ: DEV/OPS 4중 안전장치 ✅ / 도구별 세밀 권한 ❌
적용: skill-selector permission 필드 (auto/approve/block)

### 도구 (Tool)
CC: ~40도구. Vercel: "80% 제거하니 결과 좋아짐!"
TJ: 33스킬+4MCP ✅ / 팀별 서브셋 ❌ / Build to Delete ❌
적용: 팀별 도구 서브셋, 미사용 도구 비활성화, Progressive Disclosure

### 서브에이전트 (Sub-agent)
CC: 격리 워크트리+메일박스+캐시 공유. Cursor: 동등에이전트 실패→3역할(P-W-J) 성공!
TJ: 9팀 격리 ✅ / hiring-contract ✅ / 병렬 ❌ / 메일박스 ❌
적용: Promise.allSettled 병렬화, AgentTool 패턴, 코디네이터→워커 확장

### 메모리 (Memory)
CC: 3계층+Strict Write+autoDream. "메모리는 힌트, 코드베이스로 검증"
TJ: pgvector RAG ✅ / StrictWrite ❌ / autoDream ❌
적용: P0 성공시만 기록, P1 nightly-distill.js, P2 핫/콜드 분리

### 컨텍스트 (Context) ★ 가장 큰 Gap!
CC: 4단계 압축(Micro→Auto→Full→Time). MAX_FAILURES=3(25만/일 절약!)
TJ: 로그 로테이션만 ✅ / 4단계 압축 전체 ❌
적용: P0 연속실패제한, P1 MicroCompact, P2 AutoCompact

---

## 4. 감독 패턴 5가지

① Supervisor — 감독자가 분해+위임+종합. TJ: blo.js ≈ 유사
② Planner-Worker-Judge — Cursor 검증! 계획→병렬→품질판단→반복. TJ: 루나 DAG ≈ 유사
③ Sparse Supervision — 루틴 90% 자율, 핵심 10% 감독. TJ: Standing Orders = 이 패턴!
④ Mailbox — 위험 작업 비동기 승인 대기열. TJ: ❌ 없음
⑤ Consensus/Debate — 다자간 독립 판단. TJ: Bull/Bear ✅

감독 깊이: Level 3 전략(마스터) → Level 2 전술(코디네이터, 자동화 핵심!) → Level 1 실행(워커)

## 5. 에이전틱 AI 7대 패턴

① Plan-Act-Verify ② Progressive Disclosure ③ Red-Green Testing
④ Coordinator-Worker ⑤ Mailbox ⑥ Consensus ⑦ Build to Delete

---

## 6. 팀별 심층 분석

### 코어 (13,973줄/63파일)
- llm-fallback: 4단계폴백 ✅ / 연속실패제한 ❌ / 서킷브레이커 ❌
- hiring-contract: ε-greedy ★CC없음 / competition-engine ★CC없음
- rag.js: pgvector ✅ / StrictWrite ❌ / shadow-mode A/B ★CC없음

### 오케스트레이터 (10,146줄)
- intent-parser: 3단계파싱 ✅ / night-handler ≈ KAIROS ✅ / 프롬프트오케스트레이션 ❌

### 루나 (28,363줄)
- 15노드DAG ✅>CC / Bull/Bear토론 ✅ / 병렬 ❌ / 피드백루프 ❌

### 클로드 (12,345줄)
- Doctor scanAndRecover ✅>CC / autofix reportInsteadOfFix ✅ / 예방스캔 ❌

### 워커 (36,094줄)
- chat-agent 876줄 리팩토링! / approval ≈ mailbox / 에이전트오피스 ✅

### 스카 (58,238줄)
- forecast.py 2,047줄 최대 안티패턴! / Python↔Node 혼합

### 비디오 (11,652줄)
- critic/refiner ≈ CC Coordinator-Worker / edl-builder 971줄

### 신규팀
- 연구: KAIROS적합 / 감정: 4티어권한+Mailbox / 데이터: MicroCompact

---

## 7. 우리만의 강점 (CC에 없음!)

★ ε-greedy 동적 고용 / ★ 에이전트 경쟁 (월수금)
★ Shadow Mode A/B / ★ Doctor 자율 복구 (KAIROS 미출시, 우리는 운영중!)
★ Standing Orders ≈ Engineer Corrections Permanently
★ 4단계 LLM 폴백 / ★ 로컬 LLM $0

## 8. 대규모 파일 안티패턴

forecast.py 2,047줄 / blo.js 991줄 / edl-builder 971줄 / rebecca.py 937줄 / chat-agent 876줄

---

## 9. 종합 개선 로드맵

### P0 즉시
1. **연속 실패 제한** — llm-fallback.js MAX_FAILURES=5 (3줄)
2. **Strict Write** — rag.js 성공 시에만 메모리 기록

### P1 단기 (1~2주)
3. 야간 메모리 증류 — nightly-distill.js (autoDream)
4. 도구별 권한 — skill-selector permission (auto/approve/block)
5. 대규모 파일 분리 — forecast.py, chat-agent.js
6. 루나 노드 병렬화 — l03+l04+l05 Promise.allSettled
7. Doctor 예방적 스캔 — Planner 확장

### P2 중기 (2~4주)
8. 컨텍스트 압축 — context-compactor.js (Micro+Auto)
9. Mailbox 패턴 — approval-queue.js
10. AgentTool — agent-tool.js (에이전트 간 위임)
11. 에이전트 오피스 CC 메트릭 대시보드

### P3 장기 (1~2개월)
12. KAIROS 자율 데몬 — 5분 주기 모니터링
13. 프롬프트 기반 오케스트레이션 — 코드→프롬프트
14. Build to Delete — 모듈화, 모델 향상 시 제거

---

---

## 10. 자율 고용 시스템 상세 (CC에 없는 우리 고유 강점!)

### 3단계 자율 고용 모델

```
Level 1: ε-greedy 탐색 (구현 완료 ✅)
  hiring-contract.js EPSILON=0.2
  80% 최고 점수 에이전트 선택 + 20% 랜덤 탐색
  taskHint → specialty 매칭 (crypto→chaineye, stock→funder)
  fatigue/confidence 감정 점수 반영
  adjustedScore = score - (fatigue×0.1) + (confidence×0.05) + roleBonus + specialtyBonus

Level 2: 태스크-스페셜티 매칭 (부분 구현)
  블로팀 적용 완료 / 루나팀 적용 완료 / 나머지 팀 미적용
  팀별 roleAlias 매핑 (analyst→다양한 역할)

Level 3: 팀장 LLM 판단 (미구현)
  팀장 에이전트가 LLM으로 최적 멤버 선택
  CrewAI 패턴 참조 → 프롬프트 기반 위임
```

### 경쟁 시스템 (competition-engine.js)

```
월/수/금 활성화 — formGroups → startCompetition → evaluateResults → completeCompetition
4축 평가: 글자수(10) + 섹션수(10) + AI리스크(10) + 코드블록(10) = 최대 40점
승자/패자 점수 반영 → 자연 수렴
JSONB 비파괴적 팀 추적 (Phase B-1 완료)
```

### CC 대비 분석

```
CC: 서브에이전트를 AgentTool로 스폰 (도구 호출로 통일)
  → 정적 선택, 경쟁 없음, 자율 성장 없음

TJ: hiring-contract + competition-engine
  → 동적 선택 (ε-greedy), 경쟁으로 품질 수렴, 자율 성장
  → "고용 조합 = 전략 선택" 핵심 인사이트!
  → CC에 없는 진화적 에이전트 선택 메커니즘

AgentOffice(커뮤니티) 비교:
  AgentOffice: hire_agent 도구로 LLM이 고용 결정 → 최대 7명
  TJ: ε-greedy+점수+감정+specialty → 113에이전트! 규모 차원 다름
```

---

## 11. 에이전트 픽셀 오피스 연구

### 커뮤니티 트렌드 (2026년 2~3월 동시 다발)

```
① Pixel Agents (pablodelucca) ★ VS Code 확장
  Claude Code JSONL 로그 모니터링 (비침투적)
  1에이전트=1캐릭터, 서브에이전트 스폰 시각화
  오피스 레이아웃 에디터, BFS 경로탐색
  로드맵: 토큰 헬스바, 에이전트 팀 조율, Git worktree

② AgentOffice (harishkotra) ★ 자율 성장팀
  Phaser.js+React+Colyseus+Ollama (100% 로컬!)
  15초 Think Loop: Perceive→Think→Act→Remember
  hire_agent 도구로 자율 고용 (우리 hiring-contract 유사!)
  SQLite+Ollama 임베딩 메모리

③ Star-Office-UI — OpenClaw AI팀용 픽셀 대시보드, Flask+Phaser
④ Pixel Agent Desk — Electron, Claude Code hooks, 활동 히트맵, 토큰 분석, PiP
⑤ Mission Control — Monitor Grid + Pixel Office + 실시간 시각화
```

### 우리 시스템과 비교

```
우리가 가진 것:
  ✅ DotCharacter SVG+애니메이션 (Phase 2C, 0a23b65)
  ✅ 에이전트 오피스 대시보드 (admin/agent-office)
  ✅ 113에이전트 × 9팀 = 커뮤니티 최대 규모!
  ✅ 경쟁 시스템+차트 (AgentCharts.js)

우리에게 없는 것 (적용 후보):
  ❌ 실시간 에이전트 활동 시각화 (타이핑/읽기/대기 애니메이션)
  ❌ 서브에이전트 스폰 시각화
  ❌ 오피스 레이아웃 에디터
  ❌ 토큰 헬스바 / 활동 히트맵
  ❌ PiP 모드 (항상 위에 떠있는 미니 오피스)

적용 로드맵:
  P1: DotCharacter에 실시간 상태 반영 (LLM호출중/대기/에러)
  P2: 토큰/비용 대시보드 (에이전트별 히트맵+차트)
  P2: 에이전트 오피스에 CC 메트릭 추가 (실패율/캐시히트)
  P3: 픽셀 오피스 풀 구현 (Phaser.js, 9개 오피스 방)
```

---

---


---

## 13. GStack + 하네스 엔지니어링 원류

### Garry Tan의 GStack (54.2K ★, github.com/garrytan/gstack)

```
YC CEO 직접 사용 Claude Code 세팅 — 38개 디렉토리!
"60일간 600,000줄+ 프로덕션 코드"

핵심 스킬 (역할 기반):
  /office-hours — YC 제품 대화 / /plan-ceo-review — CEO 전략 리뷰
  /plan-eng-review — 엔지니어링 리뷰 ★ 유일한 필수 게이트!
  /plan-design-review — 디자인 리뷰 / /design-shotgun — 여러 시안 동시
  /review — PR 코드 리뷰 / /investigate — "조사 없이 수정 없다"
  /qa — QA + 원자적 커밋 / /cso — 보안 감사 (OWASP+STRIDE)
  /browse — Playwright+CDP 브라우저 / /codex — 크로스 모델 리뷰
  /guard — 위험 명령 차단 / /ship + /land-and-deploy — 릴리스
  /canary — 카나리 배포 / /freeze — 코드 동결 / /retro — 회고
  AGENTS.md — 매 실수마다 줄 추가!

Scope 관리: SELECTIVE EXPANSION / HOLD SCOPE / SCOPE REDUCTION
```

### Mitchell Hashimoto의 하네스 엔지니어링 (mitchellh.com, 2026-02-05)

```
HashiCorp 공동 창립자, Terraform/Vagrant/Packer 제작자

3단계 진화:
  프롬프트 엔지니어링 (2022~24) → 컨텍스트 엔지니어링 (2025) → 하네스 엔지니어링 (2026)

핵심 정의:
  "에이전트가 실수할 때마다, 그 실수가 다시는 안 일어나게 시스템을 고쳐라"

6단계 여정:
  Step 1: 챗봇 버려라 → 에이전트 써라
  Step 2: 내 작업 재현 (이중 작업으로 학습!)
  Step 3: 퇴근 전 30분 에이전트 → "다음 날 워밍 스타트"
  Step 4: 확실한 것 위임 ★ "에이전트 알림을 끄라!"
  Step 5: 하네스 엔지니어링 ★★★ = ① AGENTS.md + ② 프로그래밍된 도구
  Step 6: 항상 에이전트 실행 (작업일 10~20%)

업계 영향:
  → OpenAI "하네스 엔지니어링" 발표 (3명, 0줄 수작업, 100만줄!)
  → 2026 업계 표준 용어 정착
```

### 업계 스킬팩 비교 + 우리 적용

```
GStack(54K): 역할 기반 38디렉토리, 팀 일관성
Superpowers(106K): 7단계 TDD, "1% Rule" 코드 품질
Hermes Agent(Nous): 자기 학습, 경험→스킬 ≈ Standing Orders!
업계 수렴: model → runtime → harness → agent (LAMP 모먼트)

Hashimoto 6단계 vs 팀 제이:
  Step 1~4: ✅ 전부 달성! / Step 5: 부분 (강화 필요!) / Step 6: ✅ 24/7!

GStack 흡수 대상:
  P1: /investigate "조사→진단→수정" + /plan-eng-review 필수 게이트
  P2: Scope 관리 + /codex 크로스 모델 → Shadow Mode 확장
```

## 14. Paperclip — "제로 휴먼 컴퍼니" 오케스트레이션

```
출시: 2026-03 초, 31K+ stars, MIT, 셀프호스트
핵심: "OpenClaw이 직원이라면, Paperclip은 회사"
스택: Node.js + 임베디드 PostgreSQL + React 대시보드

아키텍처:
  CEO 에이전트 → Manager 에이전트 → Worker 에이전트
  = 우리의 마스터 → 팀장 → 에이전트와 동일 구조!

핵심 기능:
  Bring Your Own Agent — 아무 에이전트나 "하트비트 보내면 고용"
  Goal Ancestry — 태스크→프로젝트→미션 추적 ("왜"를 항상 알고 있음)
  Budget — 에이전트별 월 예산, 80% 경고, 100% 자동 중지
  Atomic Execution — 이중 작업 없음, 비용 폭주 없음
  Persistent Agent State — 하트비트 간 컨텍스트 유지
  Governance — 승인 게이트 + 설정 버전관리 + 롤백
  Multi-Company — 한 배포로 여러 회사 격리
  Clipmart (예정) — 원클릭 회사 템플릿 설치
```

### 우리 워커웹 vs Paperclip UI

```
결론: 워커웹 유지! + Paperclip 거버넌스 패턴 흡수!

Paperclip은 범용 "회사 OS" — 도메인 기능 없음
워커웹은 도메인 특화 — 영상에디터, 매출관리, 출석관리 포함
36,094줄/288파일 + 21+ 마이그레이션 = 버리기엔 투자 큼

Paperclip에서 흡수할 패턴:
  ❌→P1: 에이전트별 토큰 예산 (billing-guard 세분화)
  ❌→P1: 조직도 트리 뷰 (에이전트 오피스에 추가)
  ❌→P2: Goal Ancestry (태스크에 "왜" 표시)
  ❌→P2: 승인 게이트 UI (Mailbox 패턴 시각화)
  ❌→P2: 태스크 티켓 시스템 (GitHub 이슈 스타일)
  ❌→P3: 감사 로그 뷰 (trace/llm-logger 시각화)
  ❌→P3: Persistent Agent State (실행 간 컨텍스트 유지)
  ❌→P3: 팀 템플릿 export/import (Clipmart 유사)
```

---

## 15. 출처

[1] CC 유출: alex000kim.com [2] Harness 2026: philschmid.de
[3] Harness Engineering: anup.io [4] Agent Engineering: morphllm.com
[5] CC Harness: wavespeed.ai [6] 7 Lessons: particula.tech
[7] Trends 2026: machinelearningmastery.com [8] Architecture: neo4j.com
[9] 2025→2026: aakashgupta.medium.com [10] CC Analysis: medium.com/@marc.bara
[11] Design Patterns: sitepoint.com [12] Supervisor: docs.kore.ai
[13] Coherence: mikemason.ca [14] Workflows: stackai.com
[15] Pixel Agents: github.com/pablodelucca/pixel-agents
[16] AgentOffice: github.com/harishkotra/agent-office
[17] Star-Office-UI: agentcrunch.ai/article/star-office-ai-crew
[18] Pixel Agent Desk: github.com/Mgpixelart/pixel-agent-desk
[19] GStack: github.com/garrytan/gstack (54.2K stars)
[20] GStack vs Superpowers: particula.tech/blog/superpowers-vs-gstack
[21] Agent Frameworks 2026: agentconn.com/blog/best-open-source-ai-agent-frameworks-2026
[22] GStack Guide: openclawapi.org/en/blog/2026-03-24-gstack-beginners-guide
[23] Paperclip: github.com/paperclipai/paperclip
[24] Paperclip Analysis: medium.com/@alexrozdolskiy (org chart for agents)
[25] Paperclip Tutorial: paperclipai.info
[26] Zero-Human Company: flowtivity.ai/blog/zero-human-company
[27] Mitchell Hashimoto: mitchellh.com/writing/my-ai-adoption-journey (2026-02-05)
[28] Harness Engineering Evolution: epsilla.com/blogs/harness-engineering-evolution
[29] Harness Engineering Explained: datasciencedojo.com/blog/harness-engineering
[30] Agent Harness Explained: firecrawl.dev/blog/what-is-an-agent-harness
