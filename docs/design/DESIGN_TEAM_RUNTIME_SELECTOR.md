# 팀 런타임 셀렉터 설계 — Hub가 팀별 OpenClaw/Claude 런타임을 중앙 선택

> 작성: Codex
> 작성일: 2026-04-03
> 대상: blog, luna, darwin, justin, sigma, claude, orchestrator, ska, video, worker

> 운영 메모 (2026-04-17):
> - 현재 배포 local fast route는 `local/qwen2.5-7b`
> - 현재 배포 local deep route는 `local/deepseek-r1-32b`
> - 현재 배포 embedding route는 `qwen3-embed-0.6b`
> - 차기 업그레이드 후보는 `Qwen3 fast 계열`이지만, 이 문서의 예시는 "현재 배포 기준"으로 읽는다

---

## 1. 비전

```
현재:
  각 봇 launchd/plist/env가 직접
    OPENCLAW_AGENT
    CLAUDE_CODE_NAME
    CLAUDE_CODE_SETTINGS
  를 알고 있어야 함

문제:
  - 팀별 설정이 launchd와 코드에 흩어짐
  - 모델 체인 수정 시 변경점이 많음
  - trace에 "왜 이 runtime이 선택됐는지" 남기기 어려움
  - 팀 추가 시 운영 비용이 커짐

목표:
  Hub → selectRuntime(team, purpose)
      → openclaw_agent
      → claude_code_name
      → claude_code_settings
      → llm route chain
      → local llm base url

  각 봇은 "나는 어느 팀이고 무슨 목적의 호출인가"만 전달
  실제 runtime 선택과 배포는 Hub가 중앙 관리
```

---

## 2. 핵심 원칙

```
1. 팀별 세션/큐는 계속 분리한다
2. 선택 로직은 Hub 하나로 모은다
3. launchd env는 점진적으로 최소화한다
4. 기존 런타임 이름(blog-writer, luna-ops 등)은 그대로 재사용한다
5. 비파괴적으로 시작한다
   - 우선 "Hub가 내려주고, 클라이언트가 우선 사용"
   - 이후 launchd 하드코딩을 줄인다
```

---

## 3. 중앙화 대상

### 3-1. 팀 런타임 프로필

```json
{
  "team": "blog",
  "purpose": "writer",
  "openclaw_agent": "blog-writer",
  "claude_code_name": "blog-writer",
  "claude_code_settings": "/Users/alexlee/.openclaw/.claude/blog-writer.settings.json",
  "local_llm_base_url": "http://127.0.0.1:11434",
  "primary_routes": [
    "claude-code/sonnet",
    "openai-oauth/gpt-5.4"
  ],
  "fallback_routes": [
    "local/qwen2.5-7b",
    "google-gemini-cli/gemini-2.5-flash"
  ],
  "status": "active"
}
```

### 3-2. Hub가 내려줘야 할 것

```
누가?
  team=blog, purpose=writer

무엇을?
  runtime profile

왜?
  trace에 selection reason 남김

어디에?
  llm-fallback.js
  chunked-llm.js
  investment/shared/llm-client.js
  향후 team-pipeline / workflow 계열
```

---

## 4. 저장 방식

### 옵션 A. agent.runtime_profiles 테이블

```sql
CREATE TABLE IF NOT EXISTS agent.runtime_profiles (
  id SERIAL PRIMARY KEY,
  team VARCHAR(50) NOT NULL,
  purpose VARCHAR(50) NOT NULL DEFAULT 'default',
  openclaw_agent VARCHAR(100),
  claude_code_name VARCHAR(100),
  claude_code_settings VARCHAR(255),
  local_llm_base_url VARCHAR(255),
  primary_routes JSONB DEFAULT '[]',
  fallback_routes JSONB DEFAULT '[]',
  config JSONB DEFAULT '{}',
  score NUMERIC(4,2) DEFAULT 5.00,
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  avg_latency_ms INTEGER,
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(team, purpose)
);

CREATE INDEX idx_runtime_profiles_team ON agent.runtime_profiles(team);
CREATE INDEX idx_runtime_profiles_status ON agent.runtime_profiles(status);
```

### 옵션 B. Hub 내부 JSON 설정

```
초기 구현은 JSON/JS 상수로 시작 가능
장점:
  - 빠르게 적용 가능
  - OPS 리스크 낮음

중장기:
  DB 테이블로 올려 score/trace/evaluate까지 연결
```

권장:

```
Phase 1:
  Hub 내부 상수 + API

Phase 2:
  agent.runtime_profiles DB 이관
```

---

## 5. API 설계

### 5-1. Hub 엔드포인트

```
GET /hub/runtime/select?team=blog&purpose=writer

응답:
{
  "ok": true,
  "profile": {
    "team": "blog",
    "purpose": "writer",
    "openclaw_agent": "blog-writer",
    "claude_code_name": "blog-writer",
    "claude_code_settings": "/Users/alexlee/.openclaw/.claude/blog-writer.settings.json",
    "local_llm_base_url": "http://127.0.0.1:11434",
    "primary_routes": ["claude-code/sonnet", "openai-oauth/gpt-5.4"],
    "fallback_routes": ["local/qwen2.5-7b", "google-gemini-cli/gemini-2.5-flash"],
    "selection_reason": "team-runtime-profile"
  }
}
```

### 5-2. 목적별 purpose 예시

```
blog:
  writer, social, curriculum

luna:
  analyst, validator, commander

darwin:
  research, synthesis, review

justin:
  citation, analysis, opinion

sigma:
  quality, experiment, analysis

claude:
  reporting, triage, lead

orchestrator:
  intent, fallback
```

---

## 6. 클라이언트 적용 방식

### 6-1. llm-fallback.js

```
현재:
  process.env.OPENCLAW_AGENT
  process.env.CLAUDE_CODE_NAME
  process.env.CLAUDE_CODE_SETTINGS
  를 직접 읽음

목표:
  1) selectRuntime(team, purpose) 호출
  2) 응답값 우선 사용
  3) env는 최후 fallback
```

우선순위:

```
runtime profile from hub
  > explicit opts
  > process.env
  > code default
```

### 6-2. investment/shared/llm-client.js

```
selector는 이미 공용화 시작
다음 단계:
  agent_policy + runtime profile 같이 사용

즉,
  어떤 route를 탈지
  어떤 team runtime을 쓸지
둘 다 공용 선택으로 수렴
```

---

## 7. trace/evaluate 연결

추적값:

```json
{
  "team": "blog",
  "purpose": "writer",
  "selected_runtime": {
    "openclaw_agent": "blog-writer",
    "claude_code_name": "blog-writer"
  },
  "selected_routes": [
    "claude-code/sonnet",
    "openai-oauth/gpt-5.4"
  ],
  "selection_reason": "team-runtime-profile"
}
```

의미:

```
나중에
  blog writer는 왜 blog-writer를 탔는지
  luna validator는 왜 luna-ops를 탔는지
  어떤 runtime이 실제 성공률이 높은지
를 수치로 볼 수 있음
```

---

## 8. 단계별 적용 순서

### Phase A. 중앙 셀렉터 추가

```
Hub:
  runtime profile 상수/엔드포인트 추가

Core:
  runtime-selector.js 추가
  llm-fallback.js 연동
```

### Phase B. 팀별 적용

```
blog
luna
darwin
justin
sigma
claude
orchestrator
ska
video
worker
```

### Phase C. launchd 단순화

```
현재:
  launchd가 team runtime env를 직접 품음

이후:
  최소 env만 두고
  실제 runtime은 Hub 셀렉터가 반환
```

---

## 9. 기대효과

```
운영:
  팀별 런타임 설정이 한곳에 모임

개발:
  봇은 team/purpose만 넘기면 됨

관측:
  runtime 선택 근거를 trace로 남길 수 있음

튜닝:
  팀별 runtime profile score/evaluate 가능

확장:
  새 팀 추가 시 Hub profile만 추가하면 됨
```

---

## 10. 결론

```
지금까지 한 "팀별 runtime 분리"는 맞는 1차 작업이다.

하지만 장기적으로는
  launchd/plist가 runtime을 직접 품는 구조보다
  Hub가 team runtime profile을 중앙에서 선택하고
  각 봇은 team/purpose만 전달하는 구조가 더 낫다.

즉 다음 단계는
  "분리된 runtime들을 Hub selector로 수렴"
이다.
```
