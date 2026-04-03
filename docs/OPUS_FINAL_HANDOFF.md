# Opus 세션 인수인계 (2026-04-03 세션 14 최종)

> 작성일: 2026-04-03 | 모델: Claude Opus 4.6 (메티)
> 오늘 커밋: 69건 | 변경: 158파일, +13,510줄, -1,220줄
> 신규 81파일, 수정 76파일, 삭제 1파일

---

## 이번 세션 전체 성과

### 1. Phase 2C UI 강화 ✅ (0a23b65)
- DotCharacter.js SVG (9악세서리+상태별 애니메이션)
- 에이전트 오피스 90에이전트 대시보드 확인

### 2. Phase 3 경쟁 활성화 ✅ (9abbfa5)
- COMPETITION_ENABLED=true, 월/수/금 경쟁, 폴백 안전

### 3. Phase 0.5 + 보강 ✅ (+53에이전트, 37→90!)
- 3팀 신설: 연구15+감정10+데이터6
- 루나 보강 12: 성향변형6(에코/헤라/이지스/하운드/스위프트/미다스)+신규전문6(펀더/바이브/불리쉬/베어리쉬/체인아이/매크로)
- 블로 보강 10: 작가변형2+편집변형2+수집변형1+신규전문5

### 4. P1 수정 전부 완료 ✅
- hermes→swift 이름 변경 + DB UPDATE 완료
- role 정규화 7건 (analyst_short/long/watcher/... → analyst) + DB UPDATE 완료
- selectBestAgent 팀 격리 (a4ec4ce) — team 주어지면 팀 내에서만!
- 블로팀 동적 선택: hire('pos')→selectBestAgent('writer','blog') (5fea345)
- 루나팀 고용 연결: hireAnalystForSignal + evaluateAnalystContract (5fea345)
- 전 팀 테스트 통과: blog/luna/research/data/legal 5팀 격리 확인

### 5. Phase B JSONB 전환 ✅
- B-1: JSONB 비파괴적 추가 (analyst_signals/strategy_config/debate_log/analyst_accuracy/team_score)
- B-2: JSONB 읽기 전환 (4cb12ac) + Registry 기반 동적 로드 (a376761)
- 하드 테스트 통과 (analyze-rr.js)
- 런타임 이슈 수정 (calcKellyPosition → budget.js)

### 6. Phase 6 스킬/MCP/도구 시스템 ✅ (코덱스 구현!)
구현된 파일 (코덱스 69커밋 중 핵심):

**스킬 시스템 (31파일, 4,198줄):**
- packages/core/lib/skills/index.js — 전체 스킬 통합 내보내기
- packages/core/lib/skills/loader.js — config.json/yaml에서 스킬 로드
- packages/core/lib/skill-selector.js — selectBestSkill (hiring-contract 패턴!)
- packages/core/lib/tool-selector.js — selectBestTool (159줄)
- packages/core/lib/team-skill-mcp-pipeline.js — 팀장 오케스트레이션 파이프라인 (118줄)
- 공용 스킬 16개: code-review, verify-loop, plan, security-pipeline, tdd 등
- 다윈(연구) 전용 5개: source-ranking, counterexample, replicator, synthesis, source-auditor
- 저스틴(감정) 전용 5개: citation-audit, evidence-map, judge-simulator, precedent-comparer, damages-analyst
- 시그마(데이터) 전용 5개: data-quality-guard, experiment-design, causal-check, feature-planner, observability-planner
- 블로그 전용 2개: book-review-book, book-source-verify

**MCP 레이어 (4파일):**
- packages/core/lib/mcp/index.js — MCP 통합 내보내기
- packages/core/lib/mcp/free-registry.js — 무료 MCP 서버 레지스트리
- packages/core/lib/mcp/loader.js — MCP 서버 동적 로드
- packages/core/lib/mcp/team-router.js — 팀별 MCP 라우팅

**워크플로우 엔진 (5파일):**
- packages/core/lib/workflows/index.js
- qa-workflow.js, retro-workflow.js, review-workflow.js, ship-workflow.js

**CLI 도구 (4파일):**
- team-skill-cli.js, team-mcp-cli.js, team-pipeline-cli.js, workflow-cli.js

**DB 마이그레이션:**
- 009-skill-tool-registry.sql — agent.skills + agent.tools 테이블 (55줄)
- seed-skills-tools.js — 스킬/도구 시딩 (88줄)

### 7. 팀 런타임 셀렉터 ✅ (코덱스 구현!)
- bots/hub/lib/runtime-profiles.js (360줄) — 전 팀 런타임 프로필 정의
- packages/core/lib/runtime-selector.js — 팀별 런타임 선택
- 루나팀: investment 에이전트 런타임 분리 (c30c6d7)
- 블로팀: writer 런타임 분리 (9315871)
- 비디오팀: critic/refiner/subtitle/scene 런타임 분리 (6커밋)
- 클로드/스카/워커팀: 각각 런타임 분리 + launchd env 커플링 제거

### 8. 블로그 댓글 자동화 ✅ (코덱스 구현!)
- bots/blog/lib/commenter.js (859줄!) — 댓글 자동화 전체 구현
- bots/blog/migrations/006-comments.sql — 댓글 DB 스키마
- bots/blog/launchd/ai.blog.commenter.plist — launchd 서비스
- bots/blog/scripts/run-commenter.js — 실행 스크립트

### 9. LLM 모델 정규화 ✅ (코덱스 구현!)
- 전체 에이전트 llm_model 재편성 (8d2e924, 178a3df, df1b74d)
- 블로+루나 LLM 정책 정렬

### 10. 블로그 책 리뷰 + 이미지 파이프라인 ✅
- book-research.js 삭제 → book-review-book.js + book-source-verify.js (신규)
- local-image-client.js — 로컬 이미지 생성 (ComfyUI 워크플로우)
- gems-writer.js 확장 (+159줄)

### 11. 기타
- .gitignore 대폭 보강 (+43줄)
- CI: OPS deploy checkout 수정 (b358d77)
- RAG: 레거시 임베딩 마이그레이션 스크립트 (169줄)
- RAG: 벡터 차원 불일치 시 백오프 (d9e2243)
- 에이전트 오피스 UI 업데이트 (page.js +30줄)

---

## 핵심 결정

```
[DECISION] hermes→swift 이름 변경 (기존 뉴스분석가 5곳 충돌)
[DECISION] 7개 role → analyst 정규화 (specialty로 구분)
[DECISION] selectBestAgent 팀 격리 (team 주어지면 팀 내에서만)
[DECISION] 3계층 동적 선택: Agent → Skill → Tool (hiring-contract 패턴 확장)
[DECISION] DB: 에이전트 이름 컬럼 → JSONB 동적 구조
[DECISION] MCP: 무료 MCP 먼저, 유료는 추후 (비용 $0 우선)
[DECISION] 런타임: 팀별 런타임 프로필 분리 (Hub 중앙 관리)
```

---

## 다음 세션 우선순위

```
검증 필요:
  📋 스킬/도구 시딩 실행 확인 (agent.skills + agent.tools)
  📋 selectBestSkill / selectBestTool E2E 테스트
  📋 team-skill-mcp-pipeline.js 실전 동작 확인
  📋 런타임 셀렉터 OPS 동작 확인
  📋 블로그 댓글 자동화 실전 확인

후속:
  📋 Phase B-4: 기존 컬럼 DROP (2주 후 마스터 승인)
  📋 전략 조합별 승률 대시보드 (strategy_config JSONB)
  📋 MCP 외부 연결 실전: Alpha Vantage, 네이버 검색광고, GitHub
  📋 워크플로우 엔진 실전 적용 (qa/retro/review/ship)
  📋 비디오팀 Phase 3 (CapCut MCP 연동)
```

---

## 핵심 파일 (신규)

```
스킬/도구 시스템:
  packages/core/lib/skill-selector.js — selectBestSkill
  packages/core/lib/tool-selector.js — selectBestTool
  packages/core/lib/team-skill-mcp-pipeline.js — 팀장 오케스트레이션
  packages/core/lib/skills/ — 31파일 (공용+다윈+저스틴+시그마+블로그)
  packages/core/lib/mcp/ — 4파일 (registry+loader+router+index)
  packages/core/lib/workflows/ — 5파일 (qa/retro/review/ship+index)

런타임:
  bots/hub/lib/runtime-profiles.js — 360줄 전 팀 프로필
  packages/core/lib/runtime-selector.js — 팀별 런타임 선택

블로그:
  bots/blog/lib/commenter.js — 859줄 댓글 자동화
  bots/blog/migrations/006-comments.sql

DB:
  bots/orchestrator/migrations/009-skill-tool-registry.sql
  bots/orchestrator/scripts/seed-skills-tools.js

CLI:
  bots/orchestrator/scripts/team-skill-cli.js
  bots/orchestrator/scripts/team-mcp-cli.js
  bots/orchestrator/scripts/team-pipeline-cli.js
  bots/orchestrator/scripts/workflow-cli.js

설계:
  docs/design/DESIGN_SKILL_TOOL_SELECTOR.md (283줄)
  docs/design/DESIGN_SKILLS_MCP.md
  docs/design/DESIGN_TEAM_TRACKING.md (242줄)
  docs/design/DESIGN_TEAM_RUNTIME_SELECTOR.md

코덱스 (Phase 6):
  CODEX_PHASE06_1~11 (11개 프롬프트!)
  CODEX_SKILL_TOOL_SELECTOR.md (305줄)
```
