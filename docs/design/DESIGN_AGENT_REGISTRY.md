# Agent Registry 설계서

> 작성: 메티 (Claude Opus 4.6) + 마스터 (Jay)
> 작성일: 2026-04-02
> 상태: 설계 단계
> Phase 1 첫 번째: 제이 랜드의 기반 — 모든 에이전트를 통합 관리하는 중앙 레지스트리

---

## 1. 개요

```
Agent Registry = 제이 랜드의 "주민등록부"

모든 에이전트의 정보를 중앙에서 관리:
  누가 있는지 (등록)
  뭘 하는지 (역할, 전문분야)
  얼마나 잘 하는지 (성과 점수)
  지금 뭐 하는지 (상태)
  어떤 LLM 쓰는지 (모델)
  내적 상태가 어떤지 (자신감, 피로도, 동기)

의존하는 시스템:
  고용 계약 → Registry에서 에이전트 조회 + 점수 기반 선택
  모니터링 대시보드 → Registry에서 상태/점수 실시간 표시
  민원게시판 → Registry에서 에이전트 정보 참조
  연구팀 메딕 → Registry에서 저성과 에이전트 감지
```

---

## 2. DB 스키마 (PostgreSQL, agent 스키마)

```sql
-- 에이전트 레지스트리 (핵심 테이블)
CREATE SCHEMA IF NOT EXISTS agent;

CREATE TABLE agent.registry (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,          -- 'pos', 'gems', 'luna', 'dexter' 등
  display_name TEXT NOT NULL,         -- '포스', '젬스', '루나', '덱스터'
  team TEXT NOT NULL,                 -- 'blog', 'luna', 'claude', 'research' 등
  role TEXT NOT NULL,                 -- 'writer', 'analyst', 'searcher', 'reviewer'
  specialty TEXT,                     -- 'IT기술작가', '커뮤니티감성', '국내판례'
  
  -- LLM 설정
  llm_model TEXT,                     -- 'local/qwen2.5-7b', 'anthropic', 'claude-code/sonnet'
  llm_fallback TEXT,                  -- 폴백 모델
  
  -- 성과
  score NUMERIC(4,2) DEFAULT 5.00,    -- 종합 점수 (0~10)
  total_tasks INTEGER DEFAULT 0,      -- 총 작업 수
  success_count INTEGER DEFAULT 0,    -- 성공 수
  fail_count INTEGER DEFAULT 0,       -- 실패 수
  success_rate NUMERIC(5,2) GENERATED ALWAYS AS (
    CASE WHEN total_tasks > 0 THEN (success_count::NUMERIC / total_tasks) * 100 ELSE 0 END
  ) STORED,                           -- 성공률 % (자동 계산)
  
  -- 내적 상태 (v2 모듈 10-1)
  emotion_state JSONB DEFAULT '{
    "confidence": 5,
    "fatigue": 0,
    "motivation": 5
  }'::JSONB,
  
  -- 상태
  status TEXT DEFAULT 'idle',         -- idle/active/learning/archived/deprecated
  is_always_on BOOLEAN DEFAULT FALSE, -- 상시 가동 에이전트 (dexter, andy 등)
  
  -- 도트 캐릭터
  dot_character JSONB,                -- { color: '#3b82f6', icon: 'glasses', ... }
  
  -- 메타
  code_path TEXT,                     -- 'bots/blog/lib/pos-writer.js'
  config JSONB DEFAULT '{}',          -- 추가 설정
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 성과 이력 (시계열)
CREATE TABLE agent.performance_history (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER REFERENCES agent.registry(id),
  score NUMERIC(4,2),
  task_description TEXT,
  result TEXT,                        -- 'success', 'fail', 'partial'
  confidence_reported NUMERIC(3,1),   -- 자가 확신도 (1~10)
  duration_ms INTEGER,
  tokens_used INTEGER,
  cost_usd NUMERIC(8,4),
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- 고용 계약 이력
CREATE TABLE agent.contracts (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER REFERENCES agent.registry(id),
  employer_team TEXT NOT NULL,        -- 고용한 팀
  task TEXT NOT NULL,                 -- 작업 내용
  requirements JSONB,                 -- 요구사항
  reward_config JSONB,                -- 보상 설정
  penalty_config JSONB,               -- 페널티 설정
  status TEXT DEFAULT 'active',       -- active/completed/terminated
  score_result NUMERIC(4,2),          -- 최종 점수
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- 인덱스
CREATE INDEX idx_agent_team ON agent.registry(team);
CREATE INDEX idx_agent_status ON agent.registry(status);
CREATE INDEX idx_agent_score ON agent.registry(score DESC);
CREATE INDEX idx_perf_agent_id ON agent.performance_history(agent_id);
CREATE INDEX idx_perf_recorded ON agent.performance_history(recorded_at DESC);
CREATE INDEX idx_contract_agent ON agent.contracts(agent_id);
CREATE INDEX idx_contract_status ON agent.contracts(status);
```

---

## 3. 초기 데이터 — 기존 에이전트 등록

```
현재 팀별 에이전트 (기존 7팀 + 신규 3팀):

블로팀 (blog): blo(팀장), pos, gems, richer, publ, maestro, star
루나팀 (luna): luna(팀장), aria, sophia→sentinel, hermes→sentinel,
  oracle, chronos, nemesis(→hard-rule+budget+adaptive-risk), zeus, athena
클로드팀 (claude): claude(팀장), dexter, doctor, archer, builder, guardian, reviewer
스카팀 (ska): ska(팀장), andy, jimmy, rebecca, eve
오케스트레이터 (jay): jay(팀장), mainbot, filter, write

은퇴팀 (2026-04-30): worker, video. 설계 기록은 `docs/archive/retired-teams/`에서만 보존한다.

신규 3팀 (Phase 0.5 설계):
연구팀 (research): 다윈(팀장), 뉴런, 골드, 잉크, 가벨, 매트릭스, 프레임, 기어,
  펄스, 에디슨, 프루프, 검증자, 그래프트, 메딕, 스칼라, 멘토
감정팀 (legal): 저스틴(팀장), 브리핑, 렌즈, 가람, 아틀라스,
  클레임, 디펜스, 퀼, 밸런스, 컨트로
데이터팀 (data): 시그마(팀장), 파이프, 피벗, 오라클DS, 캔버스,
  큐레이터, 블루프린트, 오토, 내러티브

상시 가동 (is_always_on=true):
  dexter, andy, eve, hub, doctor, archer, deploy, write
```

---

## 4. API (packages/core/lib/agent-registry.js)

```js
// 핵심 함수
getAgent(name)                    // 에이전트 조회
getAgentsByTeam(team)             // 팀별 에이전트 목록
getTopAgents(role, limit)         // 역할별 상위 에이전트 (고용 시)
getLowPerformers(threshold)       // 저성과 에이전트 (메딕 스캔)
getAlwaysOnStatus()               // 상시 에이전트 상태 (대시보드 상단)

updateScore(name, score, task)    // 성과 점수 갱신
updateStatus(name, status)        // 상태 변경
updateEmotion(name, emotionState) // 내적 상태 갱신

createContract(agentName, contract) // 고용 계약 생성
completeContract(contractId, result) // 계약 완료 + 점수 반영

registerAgent(agentData)          // 신규 에이전트 등록
archiveAgent(name)                // 에이전트 아카이브

// 대시보드용
getDashboardData()                // 전체 대시보드 데이터 (팀별 그룹)
getAgentCard(name)                // 개별 에이전트 카드 데이터
```

---

## 5. 구현 계획

```
Step 1: DB 스키마 생성
  → migrations/001-agent-registry.sql
  → OPS에서 마이그레이션 실행

Step 2: 핵심 라이브러리
  → packages/core/lib/agent-registry.js (CRUD + 쿼리)
  → Hub 엔드포인트 추가: /hub/agents/* (조회/갱신)

Step 3: 초기 데이터 시딩
  → scripts/seed-agent-registry.js
  → 기존 56+ 에이전트 자동 등록

Step 4: 기존 시스템 연동
  → llm-model-selector.js에서 Registry 참조
  → 덱스터 점검에 Registry 상태 포함

Step 5: 검증
  → DEV에서 CRUD 테스트
  → 대시보드 API 테스트
```

---

## 6. 안전 원칙

```
① Registry는 읽기 전용이 기본 (에이전트가 자기 점수 수정 불가)
② 점수 갱신은 평가 시스템만 가능 (evaluateAndUpdate 함수)
③ 아카이브는 가능하지만 삭제 불가 (이력 보존)
④ 상시 에이전트 상태 변경은 마스터 승인 필요
```
