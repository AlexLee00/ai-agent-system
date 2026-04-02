# 동적 스킬/도구 선택 시스템 설계 — 팀장이 에이전트+스킬+MCP를 동적 선택

> 작성: 메티 (Claude Opus 4.6) + 마스터 (Jay)
> 작성일: 2026-04-03
> 커뮤니티 검증: Microsoft Azure AI Foundry, mcp-agent, Oracle Enterprise, Cirrius Solutions, MCP vs A2A (AAIF)

---

## 1. 비전

```
현재 (하드코딩):
  블로팀 → pos-writer.js 항상 호출
  루나팀 → aria.js 항상 호출
  에이전트는 동적 선택 가능 (✅ 구현 완료)
  스킬/도구는 하드코딩 (❌)

목표 (3계층 동적 선택):
  팀장 → selectBestAgent(role, team) → 누가? (✅ 구현 완료)
  팀장 → selectBestSkill(task, team) → 무엇으로? (신규!)
  팀장 → selectBestTool(need, team) → 어떤 도구로? (신규!)

  "팀장이 팀원을 고용계약하는 것처럼
   팀장이 최적의 스킬과 MCP를 동적으로 선택하여 적용"
```

---

## 2. 업계 패턴 근거

```
Microsoft Azure AI Foundry:
  "MCP는 에이전트가 런타임에 도구를 동적으로 발견하고 사용하는 구조화된 방법"
  → 도구 레지스트리에 등록 → 에이전트가 쿼리 → 자동 발견

Oracle Enterprise Platform:
  "에이전트 등록만으로 오케스트레이터가 자동 발견. 재배선 불필요"
  → Agent Card 패턴 = 우리의 Registry 패턴

Cirrius Solutions — Agent vs MCP vs Skills:
  Agent = 추론+계획+실행하는 자율 시스템
  MCP = 도구/데이터/API를 표준화하는 인프라 레이어
  Skills = MCP 도구 위에 지능을 입힌 레이어
  → 3계층: Agent → Skills → MCP (Tools)

mcp-agent (lastmile-ai):
  "구성 가능한 패턴: router, orchestrator, evaluator-optimizer"
  → 에이전트를 MCP 서버로 노출 가능
```


---

## 3. DB 설계

### 3-1. agent.skills 테이블

```sql
CREATE TABLE IF NOT EXISTS agent.skills (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  team VARCHAR(50),              -- null = 공용, 'luna' = 루나 전용
  category VARCHAR(50) NOT NULL, -- 'analysis', 'generation', 'validation', 'search', 'transform'
  code_path VARCHAR(255),        -- 'packages/core/lib/skills/darwin/source-ranking.js'
  description TEXT,
  input_schema JSONB DEFAULT '{}',
  output_schema JSONB DEFAULT '{}',
  score NUMERIC(4,2) DEFAULT 5.00,
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  avg_latency_ms INTEGER,
  status VARCHAR(20) DEFAULT 'active',  -- active, deprecated, experimental
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_skills_team ON agent.skills(team);
CREATE INDEX idx_skills_category ON agent.skills(category);
CREATE INDEX idx_skills_score ON agent.skills(score DESC);
```

### 3-2. agent.tools 테이블

```sql
CREATE TABLE IF NOT EXISTS agent.tools (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL,      -- 'mcp', 'api', 'internal', 'cli'
  team VARCHAR(50),               -- null = 공용
  endpoint VARCHAR(500),          -- MCP 서버 URL 또는 API endpoint
  capabilities JSONB DEFAULT '[]', -- ["search", "trade", "analyze", "generate"]
  auth_config JSONB DEFAULT '{}', -- {type: 'bearer', env_var: 'ALPHA_VANTAGE_KEY'}
  score NUMERIC(4,2) DEFAULT 5.00,
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  avg_latency_ms INTEGER,
  cost_per_call NUMERIC(10,6) DEFAULT 0, -- 호출당 비용 ($)
  status VARCHAR(20) DEFAULT 'active',
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tools_team ON agent.tools(team);
CREATE INDEX idx_tools_type ON agent.tools(type);
CREATE INDEX idx_tools_capabilities ON agent.tools USING GIN(capabilities);
```


---

## 4. 선택 알고리즘 (hiring-contract 패턴 확장)

### 4-1. selectBestSkill

```js
// skill-selector.js — hiring-contract.selectBestAgent와 동일 패턴!
async function selectBestSkill(category, team = null, requirements = {}) {
  let candidates;
  if (team) {
    // 팀 전용 + 공용 스킬 모두 후보
    candidates = await getSkillsByTeamAndCategory(team, category);
  } else {
    candidates = await getSkillsByCategory(category);
  }
  if (!candidates.length) return null;

  const ranked = candidates.map(skill => {
    const successRate = skill.usage_count > 0
      ? skill.success_count / skill.usage_count : 0.5;
    const latencyPenalty = (skill.avg_latency_ms || 0) > 5000 ? -0.5 : 0;
    const costPenalty = (skill.cost_per_call || 0) > 0 ? -0.3 : 0;
    const adjustedScore = Number(skill.score) + (successRate * 2) + latencyPenalty + costPenalty;
    return { skill, adjustedScore };
  });

  ranked.sort((a, b) => b.adjustedScore - a.adjustedScore);
  return ranked[0]?.skill || null;
}
```

### 4-2. selectBestTool

```js
// tool-selector.js — 동일 패턴!
async function selectBestTool(capability, team = null, requirements = {}) {
  let candidates;
  if (team) {
    candidates = await getToolsByTeamAndCapability(team, capability);
  } else {
    candidates = await getToolsByCapability(capability);
  }
  if (!candidates.length) return null;

  const ranked = candidates.map(tool => {
    const successRate = tool.usage_count > 0
      ? tool.success_count / tool.usage_count : 0.5;
    const latencyPenalty = (tool.avg_latency_ms || 0) > 10000 ? -1.0 : 0;
    const costBonus = (tool.cost_per_call || 0) === 0 ? 0.5 : 0; // 무료 도구 보너스!
    const adjustedScore = Number(tool.score) + (successRate * 2) + latencyPenalty + costBonus;
    return { tool, adjustedScore };
  });

  ranked.sort((a, b) => b.adjustedScore - a.adjustedScore);
  return ranked[0]?.tool || null;
}
```


---

## 5. 팀장 오케스트레이션 플로우

```
팀장(루나)이 투자 분석을 실행할 때:

[1단계] 에이전트 선택
  analyst = selectBestAgent('analyst', 'luna')
  → aria (5.55) 선택!

[2단계] 스킬 선택
  skill = selectBestSkill('analysis', 'luna')
  → darwin/source-ranking (7.2) 선택! (성과 좋은 스킬)

[3단계] 도구 선택
  tool = selectBestTool('market_data', 'luna')
  → alpha-vantage-mcp (6.8) 선택! (무료+빠른 도구)

[4단계] 실행
  result = analyst.execute(skill, tool, task)

[5단계] 평가 (성공/실패 피드백)
  evaluateAgent(analyst, result)    → 에이전트 점수 변동
  evaluateSkill(skill, result)      → 스킬 점수 변동
  evaluateTool(tool, result)        → 도구 점수 변동

→ 다음 번에는 성과 좋은 조합이 자동으로 우선 선택!
→ 시간이 지나면 최적 조합이 자연스럽게 수렴!
```

---

## 6. 초기 시딩 데이터

### 6-1. 스킬 시딩 (기존 구현 31개 + 팀 매핑)

```
공용 스킬 (team=null):
  code-review, verify-loop, plan, security-pipeline,
  eval-harness, session-wrap, build-system,
  instinct-learning, pattern-to-skill, skill-explorer,
  session-analyzer, tdd, handoff-verify

다윈(연구) 전용 (team='darwin'):
  source-ranking, counterexample, replicator, synthesis, source-auditor

저스틴(감정) 전용 (team='justin'):
  citation-audit, evidence-map, judge-simulator, precedent-comparer, damages-analyst

시그마(데이터) 전용 (team='sigma'):
  data-quality-guard, experiment-design, causal-check, feature-planner, observability-planner
```

### 6-2. 도구 시딩 (MCP + 내부)

```
루나팀:
  alpha-vantage-mcp  type=mcp  endpoint=https://mcp.alphavantage.co/mcp  cost=$0
  altfins-mcp        type=mcp  endpoint=(유료, 추후)  cost=$
  binance-api        type=api  endpoint=내부  cost=$0
  kis-api            type=api  endpoint=내부  cost=$0

블로팀:
  naver-searchad-mcp type=mcp  endpoint=로컬  cost=$0
  frase-mcp          type=mcp  endpoint=(유료, 추후)  cost=$
  naver-blog-api     type=api  endpoint=내부  cost=$0

연구팀:
  github-mcp         type=mcp  endpoint=공식  cost=$0
  context7-mcp       type=mcp  endpoint=공식  cost=$0

에디팀:
  capcut-mcp         type=mcp  endpoint=로컬(VectCutAPI)  cost=$0
  elevenlabs-mcp     type=mcp  endpoint=(유료, 추후)  cost=$

클로드팀:
  desktop-commander  type=mcp  endpoint=로컬  cost=$0
  postgresql-mcp     type=mcp  endpoint=로컬  cost=$0

공용:
  mlx-local-llm      type=internal  endpoint=localhost:8000  cost=$0
  pgvector-rag       type=internal  endpoint=내부  cost=$0
```

---

## 7. 기대 효과

```
자기 최적화 루프:
  실행 → 평가 → 점수 변동 → 다음 선택에 반영
  → 에이전트+스킬+도구 3축 최적화!
  → "어떤 에이전트가 어떤 스킬+도구로 할 때 최고 성과?" 데이터 축적

전략 조합 추적 (JSONB):
  strategy_config: {
    agent: "echo",
    skill: "source-ranking",
    tool: "alpha-vantage-mcp",
    team_score: 8.5
  }
  → 조합별 승률 쿼리 가능!

확장성:
  스킬 추가 → DB INSERT만 (코드 변경 불필요!)
  MCP 도구 추가 → DB INSERT만 (코드 변경 불필요!)
  Oracle 패턴: "등록만으로 자동 발견"
```
