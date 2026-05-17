# Team Jay Symphony Orchestrator — SPEC v0.1

> Phase 1 초안 | 작성: 2026-05-17 | 메티 설계 → 코덱스 구현
> 참조: OpenAI Symphony (2026-04-27), 클로드팀 GAP 분석

---

## 0. Problem Definition

### 현재 상태
```
마스터(Alex)
  → 메티 (설계)
    → Codex 프롬프트 파일 작성 (수동!)
      → 클로드팀 auto-dev-pipeline이 docs/auto_dev/ 폴링
        → 구현
```

**병목**: 모든 ticket이 메티/마스터 수작업 → 6팀 병렬 처리 불가

### 목표 상태
```
마스터(Alex)
  → Notion/Telegram에 ticket 생성 (자동!)
    → Team Jay Symphony Orchestrator (클로드팀장!)
      → 각 팀 agent에 자동 dispatch
        → 격리된 workspace에서 실행
          → PR 자동 생성 → 마스터 review만!
```

**해소**: "human attention bottleneck" — 6팀 자동 ticket processing

### 핵심 지표 (8주 후 목표)
| 지표 | 현재 | 목표 |
|------|------|------|
| PR 자동화 | 수동 | +500% |
| 클로드팀 자율 학습 | 0 | ★★★ |
| A2A 통신 | 0 | ★★★★★ |
| 클로드팀 점수 | 4/10 | 10/10 |
| 메티 운영 부담 | 높음 | ↓↓↓ |

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Control Plane (다중 소스!)                                │
│  Notion / Telegram / GitHub Issues / Hub /tasks           │
└────────────────┬────────────────────────────────────────┘
                 │ poll (5분 간격)
                 ▼
┌─────────────────────────────────────────────────────────┐
│  Orchestrator (클로드팀장!)                               │
│  - 통합 task queue 관리                                   │
│  - 팀별 agent dispatch                                    │
│  - 상태 머신 (todo→in_progress→review→done)              │
│  - OTP supervision (crash recovery)                       │
└──────┬──────────┬─────────┬──────────┬───────┬──────────┘
       │          │         │          │       │
  루나팀     블로팀    스카팀    다윈팀  시그마팀   클로드팀
  Agent    Agent   Agent   Agent   Agent   Agent
       │          │         │          │       │
       └──────────┴─────────┴──────────┴───────┘
                            │
                   git worktree (격리!)
                            │
                     Hub LLM Gateway
                   (Codex/Claude/Groq/Local)
                            │
                      CI 통합 → PR
```

---

## 2. Components

### 2-1. Orchestrator

**역할**: 중앙 dispatch + 상태 관리

```typescript
// bots/claude/lib/symphony/orchestrator.ts (Phase 2 구현)
interface OrchestratorConfig {
  pollIntervalMs: number;      // 기본 300_000 (5분)
  maxConcurrentTasks: number;  // 기본 3 (팀별 1)
  controlPlanes: ControlPlane[];
  agentRegistry: AgentRegistry;
}

interface SymphonyTask {
  id: string;
  source: 'notion' | 'telegram' | 'github' | 'hub';
  targetTeam: TeamId;
  title: string;
  body: string;
  priority: 'low' | 'normal' | 'high';
  status: TaskStatus;
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
}

type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';
type TeamId = 'claude' | 'luna' | 'blog' | 'ska' | 'darwin' | 'sigma';
```

**동작 루프**:
1. 모든 Control Plane 폴링
2. 신규 ticket → SymphonyTask 변환
3. 팀 라우팅 (targetTeam 결정)
4. Agent Workspace 할당
5. Agent Runner 실행 (Hub LLM Gateway)
6. 상태 업데이트 (Notion + Telegram)
7. 완료 시 PR 생성 + 마스터 알림

### 2-2. Control Plane Integration

```
소스 1: Notion
  - `/hub/notion/tasks` 또는 MCP notion-fetch
  - DB: "Team Jay Tasks" 페이지
  - 필터: status=todo, assignee=claude-team

소스 2: Telegram
  - 12 topics 중 "task" prefix 메시지
  - /task @팀명 제목 형식
  - Bot webhook → Hub → Orchestrator

소스 3: GitHub Issues
  - bots/hub/src/routes/github.ts (Phase 2 추가)
  - label: symphony-task, 팀명 label
  - GitHub MCP 활용

소스 4: Hub /tasks (신규!)
  - POST /hub/tasks — ticket 생성
  - GET  /hub/tasks?status=todo&team=:teamId — 폴링
  - PATCH /hub/tasks/:id — 상태 업데이트
```

### 2-3. Agent Workspace

```
격리 원칙:
  각 ticket → 독립 git worktree
  /tmp/team-jay/<ticketId>/<teamId>/

branchName: codex/symphony-<ticketId>-<teamId>
  
완료 후:
  git push → PR 자동 생성
  worktree cleanup
```

기존 `lib/symphony/workspace-adapter.ts` 확장:
- `workspaceRoot`: `/tmp/team-jay/`로 변경
- `mutatesGit: true` (현재 `false` — Plan only)

### 2-4. Agent Runner (모델 agnostic!)

```
우선순위 (팀별):
  Claude Code CLI (claude --print)  → 복잡한 구현 ticket
  Hub LLM Gateway → groq qwen3-32b  → 단순 ticket
  Hub LLM Gateway → local deepseek  → 폴백
  Hub LLM Gateway → anthropic sonnet → 중요 판단

팀별 라우팅 (기존 35+ 매핑 활용):
  claude  → claude-code (구현) / local_fast (분석)
  luna    → groq_with_local (거래 판단)
  blog    → local_fast (콘텐츠 생성)
  ska     → local_fast (예약 처리)
  darwin  → local_deep (R&D 분석)
  sigma   → anthropic (법률 판단 — 정확성 최우선)
```

### 2-5. State Machine

```
DB: PostgreSQL (jay DB)

CREATE TABLE IF NOT EXISTS symphony_tasks (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,          -- notion/telegram/github/hub
  target_team  TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT,
  priority     TEXT DEFAULT 'normal',
  status       TEXT DEFAULT 'todo',    -- todo/in_progress/review/done/blocked
  workspace_id TEXT,
  source_ref   TEXT,                   -- 원본 ID (Notion page ID 등)
  pr_url       TEXT,
  error_msg    TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 3. 6팀 Ticket 유형 매핑

### 3-1. 클로드팀 (Claude)
| 유형 | 예시 | 실행봇 | 소요시간 |
|------|------|--------|----------|
| `code-patch` | 버그 수정, 신규 체크 추가 | Claude Code | 10-30분 |
| `config-update` | launchd/config.json 수정 | Doctor L2 | 5분 |
| `analysis` | 로그 분석, 패턴 리포트 | Claude Lead + Archer | 2-5분 |
| `auto-dev` | docs/auto_dev/ 문서 구현 | auto-dev-pipeline (기존!) | 30-60분 |

### 3-2. 루나팀 (Luna)
| 유형 | 예시 | 실행봇 | 소요시간 |
|------|------|--------|----------|
| `strategy-tune` | 파라미터 조정, 백테스트 | Luna Strategy | 10-20분 |
| `signal-add` | 신규 시그널 추가 | Luna Elixir Agent | 20-40분 |
| `risk-update` | TP/SL 임계값 변경 | Luna Risk Governor | 5분 |
| `research` | 새 코인/전략 분석 | local_deep LLM | 5-15분 |

**⚠️ 주의**: 실투자 영향 ticket → 반드시 Shadow Mode 먼저!

### 3-3. 블로팀 (Blog)
| 유형 | 예시 | 실행봇 | 소요시간 |
|------|------|--------|----------|
| `topic-gen` | 새 주제 발굴 | Blog Trend Agent | 5분 |
| `post-draft` | 포스트 초안 생성 | Blog Writer | 10분 |
| `seo-tune` | SEO 최적화 | Blog Editor | 5분 |
| `schedule-add` | 발행 스케줄 추가 | Blog Scheduler | 2분 |

### 3-4. 스카팀 (Ska)
| 유형 | 예시 | 실행봇 | 소요시간 |
|------|------|--------|----------|
| `reservation` | 새 예약 처리 | Ska Reservation | 2분 |
| `report-gen` | 매출 리포트 | Ska Reporter | 5분 |
| `promo-create` | 프로모션 설정 | Ska Promo | 3분 |

### 3-5. 다윈팀 (Darwin)
| 유형 | 예시 | 실행봇 | 소요시간 |
|------|------|--------|----------|
| `research` | 새 알고리즘 연구 | Darwin R&D | 15-30분 |
| `backtest` | 전략 백테스트 | Darwin Tester | 10-20분 |
| `upgrade` | 시스템 업그레이드 제안 | Darwin Sigma | 10분 |

**⚠️ 주의**: DARWIN_V2_ENABLED=true, DARWIN_TIER2_AUTO_APPLY=false 유지!

### 3-6. 시그마팀 (Sigma)
| 유형 | 예시 | 실행봇 | 소요시간 |
|------|------|--------|----------|
| `meta-audit` | 시스템 일관성 검증 | Sigma Auditor | 10분 |
| `optimization` | 메타 최적화 제안 | Sigma Optimizer | 15분 |
| `consistency-check` | 팀 간 정합성 확인 | Sigma Validator | 5분 |

---

## 4. Safety Constraints

### 4-1. PROTECTED launchd (절대 중단 금지!)
```
ai.ska.*          — 스카 매출 영향
ai.luna.*         — 루나 LIVE 거래 영향
ai.investment.*   — 실투자 영향
ai.claude.*       — 클로드 운영 영향
ai.elixir.*       — Elixir 감독 트리
ai.hub.*          — Hub 게이트웨이
```

Symphony가 ticket 처리 중 launchd를 **절대** 중단하지 않는다.
Doctor L1만 재시작 허용 (화이트리스트 기반).

### 4-2. Hub LLM Gateway 강제
모든 agent LLM 호출은 `/hub/llm/call` 경유 필수.
- BillingGuard: 월 비용 임계값 초과 시 자동 차단
- 직접 Anthropic/Groq API 호출 금지 (Hub 우회 금지!)

### 4-3. 실투자 보호
루나팀 ticket 중 `strategy-tune` / `signal-add`:
- Shadow Mode 강제 (LUNA_LIVE=false)
- 마스터 승인 없이 LIVE 전환 금지
- tp_sl_set 확인 전 포지션 활성화 금지

### 4-4. DEV/OPS 격리
- Symphony Orchestrator는 DEV에서만 실행 (라우팅 로직)
- OPS 데이터 직접 수정 금지 (Hub 경유)
- secrets-store.json 접근 금지 (Hub `/hub/secrets/:category` 경유)

### 4-5. Karpathy 4원칙 자동 적용
모든 agent runner가 Codex/Claude Code 실행 시:
- `--print` 모드: 구현 전 계획 출력
- 모호한 ticket → `blocked` 상태 + 마스터 질문
- 요청 범위만 변경 (인접 코드 금지)
- 검증 기준 명시 후 실행

---

## 5. 언어별 구현 경로

### 현재 기반 (TypeScript — 즉시 확장 가능!)
```
bots/claude/lib/symphony/
  index.ts           ✅ (기존)
  state-store.ts     ✅ (기존 — auto-dev 전용)
  task-adapter.ts    ✅ (기존 — auto-dev 전용)
  workspace-adapter.ts ✅ (기존 — plan_only)
  runner-adapter.ts  ✅ (기존 — plan_only)
  validation-adapter.ts ✅ (기존)
  
  [Phase 2 추가]
  orchestrator.ts    🔲 (신규!)
  control-plane.ts   🔲 (신규! — Notion/Telegram/GitHub/Hub)
  team-dispatcher.ts 🔲 (신규! — 6팀 라우팅)
  pr-publisher.ts    🔲 (신규! — PR 자동 생성)
```

### Elixir (선택적 업그레이드 — Phase 3+)
```
packages/elixir_core/lib/jay/symphony/
  orchestrator.ex    🔲 (GenServer + polling loop)
  supervisor.ex      🔲 (OTP supervision)
  task_store.ex      🔲 (Ecto → symphony_tasks)
  
이점: OTP crash recovery 자동, GenServer polling 간결
조건: elixir_core에 Phoenix PubSub 이미 있음 ✅
      Jido 이미 있음 ✅ (Luna에서 검증됨!)
시점: Phase 3에서 TS prototype 검증 후 결정
```

### Python (제한적 사용)
```
용도: 다윈팀 R&D agent (FinRL-X 등 ML 라이브러리)
범위: Darwin R&D agent 내부만
Orchestra: TypeScript (Python은 서브프로세스)
```

### 권장 순서
```
Phase 2: TypeScript orchestrator.ts (기존 코드 재사용!)
Phase 3: Elixir GenServer (검증 후 결정)
Python:  Darwin R&D 서브프로세스 유지 (현행)
```

---

## 6. Phase별 구현 계획

### Phase 1 (현재 — 2주) ✅ SPEC 정의
- [x] SPEC.md 작성
- [x] 6팀 ticket 유형 매핑
- [x] 언어별 구현 경로 검토
- [ ] 마스터 SPEC 승인

### Phase 2 (2-4주) — Orchestrator 구현
```
구현 목표:
  1. Hub /tasks API 추가 (bots/hub/src/routes/tasks.ts)
  2. Notion + Telegram Control Plane 연동
  3. orchestrator.ts (TypeScript, polling loop)
  4. team-dispatcher.ts (6팀 라우팅)
  5. workspace-adapter.ts 업그레이드 (mutatesGit: true)
  6. symphony_tasks DB 마이그레이션

검증: docs/auto_dev/ ticket 1개를 Symphony 경로로 처리
```

### Phase 3 (4-6주) — Agent Runtime
```
구현 목표:
  1. Claude Code CLI runner 통합 (격리 workspace)
  2. multi-turn 실행 (Hermes 4-Stage 학습)
  3. CI 통합 (빌드 + 테스트 확인)
  4. PR 자동 생성 (pr-publisher.ts)
  5. Elixir GenServer 전환 여부 결정

검증: 3개 팀 연속 ticket 처리 성공
```

### Phase 4 (6-8주) — 6팀 확장
```
구현 목표:
  1. 모든 6팀 agent 등록
  2. 루나 Shadow Mode 연동
  3. BillingGuard 통합
  4. 마스터 approval flow (Telegram)

검증: 클로드팀 점수 4/10 → 10/10
```

---

## 7. 기존 Symphony 레이어 재사용

현재 `lib/symphony/`는 **auto-dev-pipeline** 전용:
- `task-adapter.ts`: docs/auto_dev/ 문서 → SymphonyTask 변환
- `workspace-adapter.ts`: git worktree plan (아직 실행 X)
- `runner-adapter.ts`: Codex/Claude Code CLI plan (아직 실행 X)
- `state-store.ts`: auto-dev manifest 상태 요약

**Phase 2에서 확장 전략**:
- 기존 `source: 'docs_auto_dev'` 유지 (하위 호환)
- `source: 'notion' | 'telegram' | 'github' | 'hub'` 추가
- `workspace-adapter.ts`: `mutatesGit: false` → `true` 업그레이드
- `runner-adapter.ts`: plan → 실제 실행으로 업그레이드

---

## 8. 성공 기준 (Goal-Driven)

```
Phase 2 완료 기준:
  ✅ Hub /tasks API: POST/GET/PATCH 동작
  ✅ Notion ticket 1개 → symphony_tasks 자동 삽입
  ✅ Telegram /task 명령 → ticket 생성
  ✅ Orchestrator polling loop 5분 동작 (launchd)

Phase 3 완료 기준:
  ✅ ticket 1개 → 격리 workspace → Claude Code 실행 → PR
  ✅ PROTECTED launchd 중단 없음
  ✅ BillingGuard 비용 추적 동작

Phase 4 완료 기준:
  ✅ 6팀 각 1개 ticket 자동 처리
  ✅ 루나 Shadow Mode 강제 확인
  ✅ 마스터 승인 flow 동작
  ✅ 클로드팀 자율 학습 Hermes 연동
```

---

> **다음 단계**: 마스터 SPEC 승인 → Phase 2 Codex 프롬프트 작성 (메티)
> **위치**: bots/claude/SPEC.md (git 추적!)
> **태그**: `git tag claude-symphony-phase1-spec-$(date +%Y%m%d-%H%M)`
