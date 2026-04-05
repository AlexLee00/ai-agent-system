# ECC(Everything Claude Code) 분석 → 팀 제이 시스템 보완점

> 작성: 메티 (Claude Opus 4.6)
> 작성일: 2026-04-06
> 출처: 갓대희 블로그 "하네스 엔지니어링 — Everything Claude Code 리뷰"
> ECC: 133K⭐, 36에이전트, 151스킬, 68커맨드, 25+훅, MIT
> 분류: 연구 문서

---

## 1. ECC 핵심 구조 요약

```
36 전문 에이전트 (YAML frontmatter + Markdown)
151 워크플로우 스킬 (도메인별 SKILL.md)
68 레거시 슬래시 커맨드
25+ 훅 (7개 이벤트 타입)
12 언어/생태계 규칙
AgentShield 보안 스캐너
Continuous Learning v2 (자가 학습)
크로스 플랫폼 (Claude Code/Codex/Cursor/OpenCode)
```

---

## 2. ECC vs 팀 제이 대조 분석

### 2-1. 에이전트 구조

```
ECC (36에이전트):
  기획: planner(opus), architect(opus)
  품질: code-reviewer(opus), 언어별 리뷰어 8개
  빌드: build-error-resolver, 언어별 6개
  보안: security-reviewer
  운영: loop-operator, harness-optimizer, chief-of-staff
  = "역할 특화 + 모델 라우팅" 패턴

팀 제이 (121에이전트):
  10팀 구조 (루나/블로/다윈/클로드/스카/워커/저스틴/에디/시그마/제이)
  ✅ ECC보다 3.4배 많은 에이전트!
  ✅ 10팀 구조 = 더 넓은 도메인 커버!
  ❌ 언어별 전문 리뷰어 없음 (Node.js 단일 스택이라 당장 불필요)
  ❌ harness-optimizer 같은 메타 에이전트 없음

개선점 ECC-1: 메타 에이전트 개념!
  시그마팀이 이미 이 역할! (hawk/dove/owl = harness-optimizer 역할)
  → 확인: 시그마팀 설계가 ECC의 메타 에이전트 패턴과 일치!
```

### 2-2. 스킬 시스템

```
ECC (151스킬):
  핵심: tdd-workflow, security-review, verification-loop
  코딩전리서치: search-first (5단계 워크플로우!)
  AI/ML: cost-aware-llm-pipeline, prompt-optimizer
  비즈니스: market-research, investor-materials
  = "스킬 = 재사용 가능한 복합 워크플로우"

팀 제이 (31스킬):
  공용16 + 다윈5 + 저스틴5 + 시그마5 + 블로2
  ✅ 팀별 특화 스킬 존재!
  ❌ 151 vs 31 = 스킬 수 5배 차이!
  ❌ search-first 같은 "코딩 전 리서치" 스킬 없음
  ❌ verification-loop 같은 "자동 검증 루프" 스킬 없음

개선점 ECC-2: 핵심 스킬 추가!
  search-first: 코딩 전 기존 패키지/MCP 조사
  verification-loop: 구현 후 자동 테스트 + 재시도
  cost-aware-pipeline: LLM 호출 비용 최적화 스킬
  → packages/core/lib/skills/에 추가!
```

### 2-3. 훅 시스템

```
ECC (25+훅, 7이벤트):
  PreToolUse: block-no-verify, config-protection, mcp-health-check
  PostToolUse: post-edit-format, post-edit-typecheck
  Stop: evaluate-session (세션에서 학습 패턴 추출!)
  SessionStart: 이전 세션 컨텍스트 로딩
  프로파일: minimal/standard/strict 3단계!

팀 제이:
  ❌ 훅 시스템 전무!!
  (Claude Code 분석에서도 CC-B로 식별됨)

개선점 ECC-3: 훅 시스템 — CC-B와 통합!
  ECC의 프로파일 개념 채택!
    minimal: 기본 로깅만
    standard: 포맷 + 타입체크 + 로깅
    strict: 보안 검증 + 설정 보호 + 전체 로깅
  핵심 훅:
    PostTaskRun → 시그마팀 데이터 자동 수집!
    OnError → error-recovery.js 자동 복구!
    SessionEnd → evaluate-session (학습 패턴 추출!)
```

### 2-4. Continuous Learning (자가 학습)

```
ECC:
  /learn 커맨드 → 세션에서 패턴 자동 추출
  /evolve → 추출된 패턴을 스킬로 진화!
  /instinct-status → 학습 상태 확인
  Instinct 시스템 → "직감"을 코드로!
  = 세션 → 패턴 발견 → 스킬 생성 → 다음 세션에 적용

팀 제이:
  ✅ 3중 피드백 루프 (L1/L2/L3) — ECC보다 구조적!
  ✅ Standing Orders 자동 승격 — 반복 패턴 3회 → 규칙!
  ✅ 키워드 진화 (keyword-evolver) — 다윈팀!
  ❌ 세션 종료 시 자동 패턴 추출 없음!
  ❌ "학습 → 스킬 자동 생성" 파이프라인 없음!

개선점 ECC-4: 세션 종료 시 자동 패턴 추출!
  스튜어드 session 모드에 통합!
  현재: 인수인계 문서 생성
  추가: 이번 세션에서 반복된 패턴 자동 식별
  → Standing Orders 후보로 시그마팀에 전달!
  → 시그마팀 curator가 검증 후 승격!
```

### 2-5. 보안

```
ECC:
  AgentShield 보안 스캐너 내장!
  Security Guide (실제 CVE 분석!)
  Snyk ToxicSkills: 공개 스킬 36%에서 인젝션 발견!
  보안 철학: "악의적 입력을 전제하고 만들어라"
  8개 최소 보안 체크리스트

팀 제이:
  ✅ DEV/OPS 4중 안전장치
  ✅ 닥터 블랙리스트 + 자율 헬스체크
  ✅ pre-commit secrets 차단
  ❌ 스킬/프롬프트 보안 스캔 없음!
  ❌ 보안 가이드 문서 없음!
  ❌ 에이전트 ID 분리 없음 (모든 에이전트가 동일 권한)

개선점 ECC-5: 보안 강화!
  스킬 보안 스캔: 새 스킬 추가 시 인젝션 패턴 검사
  보안 가이드: docs/security/SECURITY_GUIDE.md 작성
  P0-3 에이전트 권한 scope와 연계!
```

### 2-6. 모델 라우팅

```
ECC:
  탐색/검색 → Haiku (빠르고 저렴)
  일반 코딩 (90%) → Sonnet (비용 대비 최적)
  아키텍처/보안 → Opus (깊은 추론)
  문서 작성 → Haiku
  복잡한 디버깅 → Opus
  = "작업 유형별 최적 모델 자동 라우팅"

팀 제이:
  ✅ llm-model-selector 있음!
  ✅ qwen2.5-7b(로컬)/groq(무료)/claude 3계층
  ✅ 에이전트별 LLM 매핑 (seed에서 llm_model 지정)
  ✅ 단순 평가=qwen, 복잡 생성=groq 분리 (applicator!)
  = 이미 ECC 수준의 모델 라우팅 구현!
```

### 2-7. 동적 시스템 프롬프트

```
ECC:
  CLAUDE.md에 모든 것 넣기 ❌
  상황별 컨텍스트 파일 분리 (dev.md/review.md/research.md)
  --system-prompt 플래그로 동적 주입
  alias claude-dev='claude --system-prompt "$(cat ~/.claude/contexts/dev.md)"'

팀 제이:
  ✅ Hub runtime-profiles로 팀별 설정 분리!
  ✅ 팀별 CLAUDE.md 존재!
  ❌ 작업 유형별 동적 컨텍스트 주입은 없음

개선점 ECC-6: 작업 유형별 컨텍스트!
  contexts/trade.md → 매매 분석 시 주입
  contexts/publish.md → 블로그 발행 시 주입
  contexts/research.md → 연구 스캔 시 주입
  → 불필요한 컨텍스트 로딩 방지 = 토큰 절약!
```

---

## 3. 통합 보완점 (ECC + Claude Code + OpenHarness)

```
이번 주 (즉시):
  ECC-4  세션 종료 시 자동 패턴 추출 (스튜어드 통합)
  CC-F   experience_record "why" 필드
  CC-G   에러 보류+복구 패턴

이번 달:
  ECC-3  훅 시스템 (CC-B 통합!) — 3단계 프로파일
  ECC-2  핵심 스킬 추가 (search-first, verification-loop)
  ECC-5  보안 가이드 + 스킬 보안 스캔
  CC-D   에이전트 권한 scope

분기:
  ECC-6  작업 유형별 동적 컨텍스트
  ECC-1  메타 에이전트 강화 (시그마팀 확인)
  CC-A   통합 에이전트 루프 엔진
  CC-H   리더-워커 4단계
```

---

## 4. 우리가 ECC보다 앞서는 점

```
✅ 에이전트 수: 121 vs 36 (3.4배!)
✅ 실전 운영: 24/7 프로덕션 5개월+ (ECC는 설정 시스템)
✅ 3중 피드백 루프 (ECC는 Continuous Learning v2 단일)
✅ 자율 연구 (Darwin — arXiv/HF 자동 스캔→적용)
✅ 자율 고용 (ε-greedy 에이전트 동적 선택)
✅ 데이터 자산화 (5대 라벨 + 거래 준비)
✅ $0 비용 (로컬 LLM, ECC는 API 비용 발생)
✅ 경쟁 시스템 (에이전트 간 경쟁, 승자 우선 고용)
✅ 동적 편성 (hawk/dove/owl 매일 다른 분석)
```

---

## 5. 리서치 출처

```
[10] 갓대희 블로그 "하네스 엔지니어링 — Everything Claude Code 리뷰" (2026-04)
     ECC 133K⭐, Anthropic 해커톤 우승, AgentShield 보안 스캐너
     36에이전트/151스킬/68커맨드/25+훅/12언어 규칙
```
