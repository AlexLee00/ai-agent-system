# 스킬/MCP 공용 레이어 전략 — 멀티 자율 에이전트의 핵심

> 작성: 메티 (Claude Opus 4.6)
> 작성일: 2026-04-06
> 참조: ECC (151스킬, 68커맨드, 25+훅) 깃헙 분석
> 참조: docs/research/RESEARCH_ECC_ANALYSIS.md
> 참조: docs/research/RESEARCH_CLAUDE_CODE_ANALYSIS.md
> 목표: 공용 레이어에 스킬/MCP 구현 → 전 팀이 사용!

---

## 1. 현재 vs 목표

```
현재:
  스킬: 31개 (공용14 + 다윈5 + 저스틴5 + 시그마5 + 블로2)
  커맨드: 0개
  MCP 클라이언트: 2개 (team-skill-mcp-pipeline, free-registry)
  = 에이전트가 "할 수 있는 것"이 제한적!

ECC (벤치마크):
  스킬: 151개 (search-first, verification-loop, autonomous-loops...)
  커맨드: 68개
  훅: 25+ (PreToolUse, PostToolUse, 3단계 프로파일)

목표:
  공용 스킬: 14 → 30+개 (전 팀 공유!)
  팀별 스킬: 17 → 40+개
  MCP 클라이언트: 2 → 6+개
  = 에이전트의 능력 2배 이상 확대!
```

---

## 2. ECC 분석에서 추출한 핵심 스킬 (우리에게 필요한 것)

### 카테고리 A: 자율 운영 핵심 (즉시 필요!)

```
① search-first (ECC 원본: search-first)
   "코드 작성 전 기존 솔루션 검색"
   우리 적용: 에이전트가 구현 전 npm/GitHub/스킬 검색!
   사용 팀: 전 팀 (공용)

② verification-loop (ECC 원본: verification-loop)
   "구현 후 6단계 자동 검증"
   Build → Type → Lint → Test → Security → Diff
   우리 적용: edison 구현 후 proof-r이 사용!
   사용 팀: 다윈, 코덱스

③ autonomous-loop (ECC 원본: autonomous-loops, 24KB!)
   "자율 루프 패턴 5가지"
   Sequential Pipeline / Infinite Loop / PR Loop / De-Sloppify / DAG
   우리 적용: Sprint 4 자율 파이프라인의 이론적 기반!
   핵심 인사이트:
     - SHARED_TASK_NOTES.md로 반복 간 컨텍스트 연결!
     - De-Sloppify: 구현 → 정리 2단계 분리!
     - 복잡도별 파이프라인 깊이 조절 (trivial→large)
     - "리뷰어는 절대 작성자가 되면 안 된다" (Author-Bias 제거!)
   사용 팀: 다윈, 연구

④ github-analysis (우리 신규!)
   "외부 GitHub 레포 소스 코드 분석"
   우리 적용: 다윈팀이 Freqtrade 등 외부 소스 직접 분석!
   사용 팀: 다윈 (코덱스 작성 완료!)
```

### 카테고리 B: 품질/보안 (이번 달)

```
⑤ security-scan (ECC 원본: security-scan + security-review)
   "하드코딩 시크릿, 위험 패턴 자동 탐지"
   우리 적용: 전 팀 코드에 자동 보안 스캔!
   사용 팀: 전 팀 (공용)

⑥ coding-standards (ECC 원본: coding-standards)
   "팀 제이 코딩 규칙 자동 검증"
   CommonJS / JSDoc / 에러 핸들링 / 네이밍
   우리 적용: 코덱스/edison 구현 시 자동 적용!
   사용 팀: 전 팀 (공용)

⑦ agent-eval (ECC 원본: agent-eval + eval-harness)
   "에이전트 성과 평가 프레임워크"
   우리 적용: 시그마팀 피드백 + 경쟁 시스템 연동!
   사용 팀: 시그마, 클로드
```

### 카테고리 C: 팀별 전문 스킬 (다음 달)

```
⑧ deep-research (ECC 원본: deep-research)
   "심층 연구 + 출처 추적"
   우리 적용: scholar의 논문 분석 품질 향상!
   사용 팀: 다윈

⑨ content-engine (ECC 원본: content-engine + seo)
   "콘텐츠 생성 + SEO 최적화"
   우리 적용: 블로팀 게시물 품질 자동 검증!
   사용 팀: 블로

⑩ mcp-server-patterns (ECC 원본: mcp-server-patterns)
   "MCP 서버 설계/구현 패턴"
   우리 적용: Hub MCP 서버 구현 가이드!
   사용 팀: 전 팀 (공용)
```

---

## 3. MCP 클라이언트 공용 레이어 계획

```
현재 MCP:
  packages/core/lib/team-skill-mcp-pipeline.js (스킬 선택)
  packages/core/lib/free-registry.js (무료 MCP 레지스트리)

추가 구현할 MCP 클라이언트:

① github-client.js (코덱스 작성 완료!)
   GitHub REST API 클라이언트
   레포 정보/디렉토리/파일 읽기/트리
   사용: 다윈팀 외부 소스 분석

② telegram-mcp.js (신규!)
   텔레그램 인라인 키보드 + 콜백 처리
   Sprint 4 승인 버튼 기반!
   사용: 전 팀 알림 + 인터랙션

③ pg-mcp.js (기존 pg-pool.js 확장!)
   PostgreSQL 쿼리 + LISTEN/NOTIFY
   에이전트 간 실시간 통신!
   사용: 전 팀 (P0-2 과제)

④ hub-mcp.js (기존 hub-client.js 확장!)
   Hub Secrets + 런타임 설정 + 에러 조회
   에이전트가 Hub를 통해 시스템 상태 파악!
   사용: 클로드팀, 다윈팀

⑤ llm-mcp.js (기존 llm-fallback.js 통합!)
   LLM 호출 통합 인터페이스
   로컬/Groq/OAuth 자동 선택!
   사용: 전 팀

⑥ rag-mcp.js (기존 rag.js 확장!)
   RAG 검색 + 경험 저장 통합
   에이전트 학습 데이터 접근!
   사용: 전 팀
```

---

## 4. 공용 레이어 아키텍처

```
packages/core/lib/
├── skills/
│   ├── index.js                    ← 스킬 레지스트리 + 3계층 선택기
│   ├── shared/                     ← 전 팀 공용 스킬!
│   │   ├── search-first.js         ← "기존 솔루션 먼저 검색"
│   │   ├── verification-loop.js    ← "6단계 자동 검증"
│   │   ├── security-scan.js        ← "보안 자동 스캔"
│   │   ├── coding-standards.js     ← "코딩 규칙 검증"
│   │   ├── autonomous-loop.js      ← "자율 루프 패턴"
│   │   └── mcp-patterns.js         ← "MCP 서버 설계 패턴"
│   ├── darwin/                     ← 다윈팀 전용
│   │   ├── github-analysis.js      ← (구현 예정!)
│   │   ├── deep-research.js        ← 심층 연구
│   │   ├── synthesis.js            ← 기존
│   │   └── ...
│   ├── blog/                       ← 블로팀 전용
│   │   ├── content-engine.js       ← 콘텐츠 + SEO
│   │   └── ...
│   ├── sigma/                      ← 시그마팀 전용
│   │   ├── agent-eval.js           ← 에이전트 평가
│   │   └── ...
│   └── luna/                       ← 루나팀 전용 (신규!)
│       ├── backtest-metrics.js     ← Sharpe/MDD 계산
│       └── risk-calculator.js      ← 리스크 계산
│
├── github-client.js                ← GitHub REST API (신규!)
├── pg-pool.js                      ← PostgreSQL (기존)
├── telegram-sender.js              ← 텔레그램 (기존)
├── hub-client.js                   ← Hub API (기존)
├── llm-fallback.js                 ← LLM 통합 (기존)
├── rag.js                          ← RAG (기존)
└── skill-selector.js               ← 3계층 동적 선택 (기존)
```

---

## 5. 스킬 표준 인터페이스

```
ECC SKILL.md 포맷에서 착안:

모든 스킬은 다음 인터페이스 준수:
  - 순수 함수 (LLM 호출 없음! I/O 없음!)
  - 입력: { ... } 객체
  - 출력: { ... } 객체
  - JSDoc 주석
  - node --check 통과

SKILL.md 메타데이터:
  ---
  name: skill-name
  description: "한 줄 설명"
  category: shared | darwin | blog | sigma | luna
  teams: [all] 또는 [darwin, sigma]
  trigger: "이 스킬을 언제 사용하는가"
  ---

스킬 파일 구조:
  packages/core/lib/skills/{category}/{name}.js
  packages/core/lib/skills/{category}/{name}.md  ← 사용 가이드
```

---

## 6. ECC에서 배운 핵심 인사이트

```
① "리뷰어는 절대 작성자가 되면 안 된다" (Author-Bias 제거!)
   → graft(설계) + edison(구현) + proof-r(검증) = 우리 3역할과 일치!
   → 시그마팀 크로스 검증도 이 원칙!

② "부정 지시보다 별도 정리 단계" (De-Sloppify 패턴!)
   → "하지 마" 대신 "구현 → 정리" 2단계 분리!
   → edison 구현 → proof-r 검증 → 정리 단계 추가!

③ "SHARED_TASK_NOTES.md로 반복 간 컨텍스트" 
   → 우리 proposal-store.json이 이 역할!
   → experience_record가 장기 컨텍스트!

④ "복잡도별 파이프라인 깊이 조절"
   → trivial: 구현→테스트
   → small: 구현→테스트→리뷰
   → medium: 연구→설계→구현→테스트→리뷰
   → large: 연구→설계→구현→테스트→리뷰→수정→최종리뷰
   → 다윈팀 자율 레벨과 유사!

⑤ "스킬은 순수 함수, MCP는 I/O 담당"
   → 스킬: 데이터 변환/분석 (LLM 없음!)
   → MCP 클라이언트: 외부 서비스 연동 (GitHub/텔레그램/DB)
   → 명확한 분리!

⑥ "search-first: 구현 전 반드시 기존 솔루션 검색!"
   → 바퀴 재발명 방지!
   → npm/GitHub/기존 스킬에서 먼저 찾기!
   → 다윈팀 GitHub 클라이언트로 실현!
```

---

## 7. 구현 로드맵

```
Phase 1: 즉시 (이번 주) — Sprint 4와 함께!
━━━━━━━━━━━━━━━━━━━━━━━

  ✅ github-client.js (코덱스 작성 완료!)
  ✅ github-analysis.js 스킬 (코덱스 작성 완료!)
  📋 verification-loop.js → proof-r이 사용!
     Build/Lint/Test/Security/Diff 6단계
  📋 coding-standards.js → edison 구현 시 자동 적용!

Phase 2: 이번 달 — 공용 스킬 확대!
━━━━━━━━━━━━━━━━━━━━━━━

  📋 search-first.js → 전 팀 구현 전 검색!
  📋 security-scan.js → 전 팀 보안 자동 스캔!
  📋 agent-eval.js → 시그마팀 에이전트 평가!
  📋 telegram-mcp.js → 인라인 키보드 통합!
  📋 skills/shared/ 디렉토리 생성 + index.js 업데이트!

Phase 3: 다음 달 — 팀별 전문 스킬!
━━━━━━━━━━━━━━━━━━━━━━━

  📋 deep-research.js → 다윈팀 심층 연구!
  📋 content-engine.js → 블로팀 콘텐츠 품질!
  📋 backtest-metrics.js → 루나팀 성과 지표!
  📋 mcp-patterns.js → MCP 서버 설계 가이드!
  📋 pg-mcp.js → LISTEN/NOTIFY 실시간 통신!

Phase 4: 분기 — 자율 스킬 생성!
━━━━━━━━━━━━━━━━━━━━━━━

  📋 다윈팀이 새 스킬을 자율 생성!
     논문에서 발견한 패턴 → 스킬로 자동 변환!
     Sprint 4 파이프라인으로 자동 구현+검증!
  📋 시그마팀이 스킬 효과 분석!
     "어떤 스킬이 에이전트 성과를 높이는가?"
  = Self-Evolving Skill System!
```

---

## 8. 각 팀이 공용 스킬을 사용하는 흐름

```
루나팀 (투자):
  search-first → "이 전략 이미 구현되어 있나?" 
  verification-loop → 전략 코드 품질 검증
  backtest-metrics → Sharpe/MDD 표준 계산
  security-scan → API 키 하드코딩 방지

블로팀 (블로그):
  search-first → "이 주제 이미 게시했나?"
  content-engine → SEO 최적화 + 품질 검증
  coding-standards → 코드 스니펫 품질
  verification-loop → 발행 전 최종 검증

다윈팀 (연구):
  search-first → "이 논문 이미 분석했나?"
  github-analysis → 외부 레포 소스 분석
  deep-research → 심층 논문 분석
  verification-loop → edison 구현 검증!
  autonomous-loop → Sprint 4 자율 파이프라인!

시그마팀 (피드백):
  agent-eval → 에이전트 성과 평가 프레임워크
  verification-loop → 피드백 적용 후 검증

클로드팀 (모니터링):
  security-scan → 시스템 보안 자동 스캔
  verification-loop → 배포 전 검증
```

---

## 9. 핵심 원칙

```
① 공용 우선! — 2팀 이상 사용 가능하면 shared/에!
② 순수 함수! — 스킬은 LLM/I/O 없이 동작!
③ MCP는 I/O! — 외부 연동은 MCP 클라이언트가 담당!
④ ECC에서 학습! — 151스킬의 패턴을 흡수, 그대로 복사 아님!
⑤ 프레임워크 독립! — Node.js CommonJS, 외부 의존 최소!
⑥ 자율 생성! — 다윈팀이 새 스킬을 자율 생성하는 구조!
⑦ 데이터 기반! — 시그마팀이 스킬 효과를 측정하고 피드백!
```
