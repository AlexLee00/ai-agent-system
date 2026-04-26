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

③ Star-Office-UI — legacy gateway AI팀용 픽셀 대시보드, Flask+Phaser
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
핵심: "legacy gateway가 직원이라면, Paperclip은 회사"
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
[22] GStack Guide: legacy gateway community guide
[23] Paperclip: github.com/paperclipai/paperclip
[24] Paperclip Analysis: medium.com/@alexrozdolskiy (org chart for agents)
[25] Paperclip Tutorial: paperclipai.info
[26] Zero-Human Company: flowtivity.ai/blog/zero-human-company
[27] Mitchell Hashimoto: mitchellh.com/writing/my-ai-adoption-journey (2026-02-05)
[28] Harness Engineering Evolution: epsilla.com/blogs/harness-engineering-evolution
[29] Harness Engineering Explained: datasciencedojo.com/blog/harness-engineering
[30] Agent Harness Explained: firecrawl.dev/blog/what-is-an-agent-harness


---

## §15. 워커웹 + Paperclip + 에이전트 픽셀 오피스 통합 설계

### 15-1. 커뮤니티 통합 사례

**Mission Control (jeturing/mission-control)** — 우리 워커웹과 80% 동일 스택!
Next.js + SQLite + legacy gateway. 칸반 보드(MissionQueue.tsx) + AI 계획(PlanningTab.tsx)
+ 에이전트 패널(AgentsSidebar.tsx) + 실시간 이벤트(LiveFeed.tsx) + 태스크 생성(TaskModal.tsx).
API: tasks(CRUD+계획+디스패치), agents(관리), legacy gateway proxy, webhooks(완료).

**AgentOffice** — Phaser.js(픽셀 렌더링) + React(UI 오버레이) 하이브리드.
Canvas 위에 React: Chat, TaskBoard, SystemLog, Inspector, Layout Editor.
Phaser→React 통신: Custom EventTarget (eventBus). Focus Mode: 에이전트 클릭 → 카메라 추적.
핵심 기술: Phaser keyboard 충돌 해결(input.keyboard.capture), TypeScript 클로저 내로잉 문제.

**Star-Office-UI** — "시각화 레이어는 오케스트레이션 위에 올리는 것" (AgentCrunch 평가).
AI 에이전트 상태(working/idle/error)를 읽어 픽셀 캐릭터로 표현. mco-org/mco 연동.
MIT 라이선스 코드, 아트 에셋은 비상업 학습용만.

**Pixel Agents (pablodelucca)** — VS Code 확장. Claude Code 터미널 = 캐릭터.
64×64 타일 그리드, 모듈러 에셋(furniture/manifest.json), 오픈소스 에셋.
실시간 활동 추적: 타이핑/읽기/명령실행. Sub-agent 시각화(Task tool 하위 에이전트).

### 15-2. 3계층 통합 설계안

```
Layer 3: 픽셀 오피스 (시각화) — Phaser.js Canvas
  10팀 = 10개 방, 113에이전트 픽셀 캐릭터
  상태 반영: 타이핑/읽기/대기/에러/수면
  DotCharacter SVG → Phaser 스프라이트 전환

Layer 2: Paperclip 거버넌스 — React 오버레이
  조직도 트리 뷰 (팀장→에이전트)
  에이전트별 예산 + Goal Ancestry
  승인 게이트 UI (Mailbox 패턴)

Layer 1: 워커웹 (기존) — Next.js 4001포트
  매출/출석/채팅/영상편집/설정
```

---

## §16. TradingView MCP 실시간 차트분석 + 자동매매

### 16-1. 접근법 A: 데이터 MCP (atilaahmettaner/tradingview-mcp)

Python + Yahoo Finance + MCP Protocol (218★). 멀티 에이전트 토론:
Technical Analyst(볼린저+RSI+MACD) + Sentiment Analyst(Reddit 감성+모멘텀)
+ Risk Manager(변동성+드로다운+평균회귀) → STRONG BUY~STRONG SELL + 신뢰도.
백테스팅: Supertrend +31.5%(Sharpe 2.1), Bollinger +18.3%(Sharpe 3.4).
legacy gateway 통합: Telegram→legacy gateway→trading.py→tradingview-mcp→Yahoo Finance.

### 16-2. 접근법 B: 차트 제어 MCP (tradesdontlie + ulianbass fork)

Node.js + Chrome DevTools Protocol + TradingView Desktop (78도구!).
Pine Script AI 작성+주입+컴파일+디버깅. 차트 탐색/인디케이터/그리기/알림.
리플레이 모드(히스토리 바 순회). 스크린샷→AI 시각 분석. JSONL 스트리밍.
Morning Brief 워크플로우(Jackson fork): 워치리스트 스캔→인디케이터 읽기→세션 바이어스.
Trading Rules Config: rules.json에 규칙 정의→AI가 규칙 기반 판단.

### 16-3. 루나팀 연동 방안

방안 1(추천 P1): 데이터 MCP 통합 — Python 서버 추가, 무료.
방안 2(P3): 차트 MCP 통합 — TradingView Desktop + 78도구, 유료.
방안 3(최종): 하이브리드 — 데이터(무료)+차트(유료) 통합.

---

## §17. 연구팀(다윈) 자율 연구 에이전트 개선

### 17-1. 핵심 논문/프레임워크

**VoltAgent/awesome-ai-agent-papers** — 2026 AI 에이전트 논문 큐레이션.
매주 arXiv 검색, 필터링, 카테고리화. 우리 다윈팀이 이 작업을 자동화해야!

**The AI Scientist** — 완전 자동 연구 파이프라인: 아이디어 생성→코드 작성→실행→논문 초안.
ML 하위 분야에 적용. 우리 다윈팀의 최종 목표와 동일!

**NovelSeek** — AI Scientist 확장: 참신성 검증 추가, 폐쇄 루프 연구 사이클.

**PaperQA / LitLLM** — RAG 기반 자동 문헌 리뷰. 우리 RAG(pgvector) + 다윈 searcher와 결합 가능.

**AAMAS 2026** — 자율 에이전트 멀티에이전트 시스템 학회 (2026 최신).
DyTopo(동적 토폴로지), MonoScale(안전한 에이전트 풀 확장), Agent Drift(행동 퇴화).

**"Multi-Agent Teams Hold Experts Back"** — 자기조직 LLM 에이전트 팀이 최고 멤버보다 나은가?
우리 경쟁 시스템(월수금 경쟁)과 직결되는 연구!

### 17-2. 다윈팀 개선 방안

현재: 22에이전트 (9 searcher + 4 builder/deployer + 4 reviewer + 5 기타)
문제: searcher가 수동 요청에만 반응, 자율 서칭 사이클 없음!

개선안:
```
Phase 1: 자율 arXiv 스캔 사이클 (매주 자동)
  neuron/gold-r/ink/gavel/matrix-r/frame/gear/pulse → arXiv API 자동 호출
  → 키워드별 최신 논문 수집 → 요약 생성 → pgvector 저장
  → weaver가 주간 리서치 리포트 자동 생성

Phase 2: 논문 → 적용 가능성 자동 평가
  proof-r + skeptic-r → 수집된 논문의 우리 시스템 적용 가능성 0~10점 평가
  → 7점 이상 → graft에게 자동 전달 → 적용 프로토타입

Phase 3: AI Scientist 패턴 도입
  scholar → 가설 생성 → edison → 코드 구현 → proof-r → 검증
  → mentor → 결과 반영 → medic → 실패 진단
  = 완전 자율 연구 사이클!
```

---

## 출처 (추가분)

[31] Pixel Agents: github.com/pablodelucca/pixel-agents
[32] AgentOffice: dev.to/harishkotra/agentoffice-self-growing-ai-teams
[33] Mission Control: github.com/jeturing/mission-control
[34] Star-Office-UI: agentcrunch.ai/article/star-office-ai-crew
[35] TradingView MCP (Data): github.com/atilaahmettaner/tradingview-mcp (218★)
[36] TradingView MCP (Chart): github.com/tradesdontlie/tradingview-mcp (78도구)
[37] TradingView MCP Jackson: github.com/LewisWJackson/tradingview-mcp-jackson
[38] TradingView MCP Guide: pineify.app/resources/blog/tradingview-mcp-complete-guide
[39] VoltAgent AI Agent Papers: github.com/VoltAgent/awesome-ai-agent-papers (2026)
[40] Agentic AI for Science: arxiv.org/html/2503.08979v1
[41] From AI for Science to Agentic Science: arxiv.org/html/2508.14111v1
[42] AAMAS 2026: arxiv.org/list/cs.MA/current
[43] AI Agent Papers Weekly: github.com/masamasa59/ai-agent-papers


---

## §17-2. 자율 연구 에이전트 심층 분석 (추가 연구)

### 핵심 프레임워크 7개 비교

**Agent Laboratory** — 3단계 파이프라인: 문헌 리뷰→실험→리포트 작성.
PhD/Postdoc 에이전트 역할 분리. mle-solver(실험자동화)+paper-solver(보고서생성).
o1-preview 구동 시 최고 품질. 비용 84% 절감 (vs 기존 자율 연구).
Co-pilot 모드: 사람 피드백을 단계별로 주입. 오픈소스.

**AgentRxiv** — 협력적 자율 연구. 여러 Agent Laboratory가 공유 arXiv에 논문 게시.
병렬 연구: wall-clock 시간 단축, 하지만 중복 실험으로 비용 증가.
핵심 통찰: 개별 연구실이 아닌 "연구 커뮤니티" 시뮬레이션.

**AI-Researcher** — 최소 입력(참조 논문 10~15개)으로 전체 파이프라인 자동화.
Knowledge Acquisition Agent: arXiv+GitHub 자동 탐색.
GitHub 저장소 5개+ 자동 선별 (최신성+스타수+코드품질 필터).
Docker 컨테이너화: 안전한 실험 환경, 자율 패키지 설치.

**STELLA** — 자기진화 바이오의학 에이전트. 도구+추론 템플릿 라이브러리 동적 확장.
운영 경험 증가 → 정확도 2배! 우리 Standing Orders/RAG 패턴과 동일!

**ResearchAgent** — 리뷰 에이전트 패널이 아이디어를 점진적 개선.
우리 다윈팀 proof-r+skeptic-r+skeptic-d 리뷰어 3중 구조와 유사!

**O-Researcher** — 멀티에이전트 딥 리서치. Planner+Tool-User+Summarizer.
쿼리 분해 → 서브쿼리별 병렬 에이전트 → 서브리포트 → 통합.
SFT+RL 학습으로 오픈소스 모델도 deep research 가능.

**Agentic Hybrid RAG** — arXiv/PubMed/Google Scholar API 자동 수집.
Neo4j 지식그래프 + FAISS 벡터스토어 하이브리드.
동적 검색 모드 선택 (GraphRAG vs VectorRAG). 우리 pgvector와 결합 가능!

### 우리 다윈팀 현재 vs 목표

현재 다윈팀 (22에이전트):
  searcher 9명: 도메인별 서칭 (AI/투자/콘텐츠/법률/데이터/영상/시스템/마케팅/최신성)
  builder 2명: edison(프로토타입), graft(적용)
  reviewer 3명: proof-r, skeptic-r, skeptic-d (3중 검증)
  기타: darwin(총괄), scholar(심층), mentor(교육), medic(진단), weaver(통합)
  
  문제: 모든 searcher가 수동 요청에만 반응!
  → 마스터/메티가 지시하지 않으면 아무것도 안 함!

목표: STELLA 패턴 — "운영 경험 → 자기진화 → 정확도 2배"

### 빠른 적용 타임라인 (2주 스프린트)

```
━━━ Sprint 1 (04-07 ~ 04-11, 5일) ━━━

Day 1-2: arXiv API 자동 스캔 구현
  대상: neuron(AI) + gold-r(투자) + ink(콘텐츠)
  구현: cron job (매일 06:00) → arXiv API 호출
    → 키워드별 최신 20건 수집
    → 제목+요약+URL을 pgvector에 저장
  키워드 예시:
    neuron: "multi-agent system", "LLM agent", "tool use"
    gold-r: "algorithmic trading", "portfolio optimization"
    ink: "content generation", "SEO optimization"
  난이도: ★★☆ (arXiv API는 무료+간단)

Day 3-4: 자동 요약 + 적합성 평가
  weaver가 수집된 논문 요약 자동 생성 (qwen2.5-7b)
  proof-r이 "우리 시스템 적용 가능성" 0~10점 자동 평가
  7점 이상 → 텔레그램 리포트로 마스터에게 알림

Day 5: 주간 리서치 리포트 자동 생성
  weaver가 1주간 수집 결과를 종합
  → docs/research/WEEKLY_RESEARCH_REPORT.md 자동 갱신
  → 텔레그램으로 주간 요약 발송

━━━ Sprint 2 (04-14 ~ 04-18, 5일) ━━━

Day 6-7: 적용 프로토타입 자동 생성
  graft가 7점+ 논문 중 "구현 가능" 판단 건에 대해
  → edison에게 프로토타입 코드 요청
  → 최소한 "이런 식으로 적용 가능" 스켈레톤

Day 8-9: RAG 경험 저장 연동
  수집→평가→적용 사이클의 결과를 pgvector에 저장
  → 성공 패턴 학습 (Strict Write: 성공만 저장!)
  → Standing Orders 자동 승격 (3회 반복 패턴)

Day 10: 자기진화 루프 완성
  STELLA 패턴: 경험 축적 → 검색 키워드 자동 개선
  → 다음 주 arXiv 스캔이 더 정확해짐!
```


### 적정성 판단 기준

```
Sprint 1 이후 적정성 판정 (04-11):
  ① arXiv API 호출 성공률 > 95%
  ② 일일 수집 논문 수: 20건+ / 에이전트
  ③ 적합성 평가 소요시간: < 30초/건 (qwen2.5-7b)
  ④ 7점+ 논문 발견율: 주당 3~5건 예상
  ⑤ 텔레그램 리포트 정상 발송

  GREEN → Sprint 2 진행
  YELLOW → 키워드 튜닝 후 1주 연장
  RED → 수동 모드로 전환
```

### 핵심 차별점: AI Scientist vs 우리

```
  AI Scientist: 범용 ML 연구 → 논문 작성까지
  우리 다윈팀: 우리 시스템 개선에 특화!

  AI Scientist가 못 하는 것:
    × 우리 113에이전트 구조를 모름
    × 우리 코드베이스에 적용할 수 없음
    × 우리 비즈니스 도메인(투자/블로그/스카/감정) 특화 불가

  우리만 할 수 있는 것:
    ✅ 논문에서 패턴 추출 → 우리 에이전트에 직접 적용
    ✅ 실험 결과를 실제 운영 데이터로 검증
    ✅ Standing Orders로 성공 패턴 영구화
    ✅ 10팀 9도메인 크로스 적용 (투자 패턴→블로그 적용 등)
```

### 다윈팀 역할 재정의

```
현재 (수동):
  마스터/메티 → "이것 좀 조사해줘" → searcher → 결과 반환

목표 (자율):
  cron 06:00 → searcher 9명 병렬 arXiv 스캔
  → weaver 요약 → proof-r 평가 (0~10점)
  → 7점+ → graft "적용 방안 초안" → edison "프로토타입"
  → mentor "에이전트 재교육" → medic "실패 진단"
  → pgvector 저장 → 다음 사이클 키워드 개선
  = 완전 자율 연구 루프!

마스터 역할: "이것 조사해" → "주간 리포트 확인 + 적용 승인"
```

---

## 출처 (추가분)

[44] Agent Laboratory: arxiv.org/pdf/2501.04227 (o1-preview, 84% 비용절감)
[45] AgentRxiv: arxiv.org/html/2503.18102v1 (협력적 자율 연구)
[46] AI-Researcher: arxiv.org/html/2505.18705v1 (10~15 참조논문→전체파이프라인)
[47] Deep Research Survey: arxiv.org/html/2508.12752v1 (planning→web→report)
[48] Agentic Hybrid RAG: arxiv.org/html/2508.05660v1 (Neo4j+FAISS+arXiv API)
[49] O-Researcher: arxiv.org/pdf/2601.03743 (멀티에이전트 딥리서치, SFT+RL)


---

## §18. Hugging Face 활용 — 다윈팀 연구 자원

### 18-1. HF에서 가져올 핵심 자원 5가지

**① huggingface.co/papers (Trending Papers)** — 매일 AI 논문 자동 수집 소스!
arXiv의 논문을 커뮤니티가 큐레이션+토론. Librarian Bot이 유사 논문 자동 추천.
우리 활용: 다윈팀 searcher가 HF Papers API를 arXiv API와 병렬 호출
→ 커뮤니티 관심도(upvotes) 기반 필터링 가능!

**② AI Scientist v2 (SakanaAI, 4.43k★)** — 최초 완전 AI 논문 피어리뷰 통과!
오픈소스: github.com/SakanaAI/AI-Scientist-v2
가설 생성 → 실험 설계/실행 → 데이터 분석 → 논문 작성 전 파이프라인.
Progressive agentic tree-search + 전용 experiment manager agent.
VLM 피드백 루프: 그래프/차트 반복 개선.
우리 활용: 코드 참조하여 다윈팀 scholar+edison+proof-r 파이프라인 구축.

**③ Hyperagents (2.08k★)** — 자기참조 시스템: task agent + meta agent가 서로 수정!
메타인지 자기개선 → 코딩 외 도메인에서도 성능 향상.
관련: Group-Evolving Agents(경험 공유), AgentFactory(서브에이전트 축적),
SAGE(멀티에이전트 자기진화), EvoSkill(자동 스킬 발견).
우리 활용: 다윈팀 mentor+medic이 다른 에이전트를 자동 개선하는 패턴!

**④ HF Paper Publisher Skill** — arXiv 논문을 HF Hub에 자동 게시/링크.
paper_manager.py: index(arXiv ID→HF), link(모델/데이터셋 연결), check(존재확인).
우리 활용: 다윈팀 연구 결과를 HF Hub에 자동 게시 → 커뮤니티 노출.

**⑤ Step-DeepResearch** — 원자적 능력 분해 + 프로그레시브 학습 파이프라인.
Deep Research를 원자 능력으로 분해: planning, information gathering, reflection, report writing.
각 능력별 합성 데이터 생성 → SFT → RL 강화.
우리 활용: 다윈팀 에이전트별 능력 분해 → 각자 특화 학습!

### 18-2. HF API 활용 설계

```
다윈팀 일일 수집 소스 (병렬):
  ① arXiv API → 키워드별 최신 논문 (무료, 무제한)
  ② HF Papers API → 트렌딩 논문 + 커뮤니티 점수 (무료)
  ③ HF Datasets 검색 → 관련 데이터셋 자동 발견

HF Papers API 예시:
  GET https://huggingface.co/api/papers?sort=trending
  → title, arxiv_id, upvotes, comments 반환
  → upvotes ≥ 50 → "핫 논문"으로 분류
  → Librarian Bot 추천 논문도 수집

적용 타임라인:
  Sprint 1 Day 1: arXiv API + HF Papers API 병렬 수집 구현
  → 수집량 2배! 커뮤니티 검증된 논문 우선순위 자동 부여
```

### 18-3. AI Scientist v2 → 다윈팀 매핑

```
AI Scientist v2 에이전트          →  다윈팀 에이전트
  Experiment Manager              →  darwin (총괄)
  Hypothesis Generator            →  scholar (심층연구)
  Code Writer + Executor          →  edison (프로토타입)
  Paper Writer                    →  weaver (통합) + quill (작성)
  AI Reviewer (VLM)               →  proof-r + skeptic-r (3중 검증)
  Tree Search Navigator           →  graft (적용 탐색)

차이점: AI Scientist v2는 "새 논문 생성"이 목표
       우리는 "기존 시스템 개선"이 목표
       → 코드 구조만 참조, 목표는 다름!
```

---

## 출처 (추가분)

[50] AI Scientist v2: huggingface.co/papers/2504.08066 (SakanaAI, 4.43k★)
[51] AI Scientist v1: huggingface.co/papers/2408.06292 (SakanaAI)
[52] Hyperagents: huggingface.co/papers/2603.19461 (자기참조 메타인지)
[53] AgentRxiv HF: huggingface.co/papers/2503.18102 (5.38k collections)
[54] HF Paper Publisher: agentskills.so/skills/hugging-face-paper-publisher
[55] HF Paper Explorer: huggingface-paper-explorer.vercel.app
[56] Step-DeepResearch: arxiv.org/html/2512.20491v1 (원자적 능력 분해)
[57] DeepScientist: HF Trending (베이지안 최적화 자율 과학 발견)
[58] SKILL0: HF Trending (제로샷 자율 행동, 동적 커리큘럼)
