# Opus 세션 인수인계 (2026-04-01 세션 6)

> 작성일: 2026-04-01 | 모델: Claude Opus 4.6 (메티)
> 이전 트랜스크립트: /mnt/transcripts/2026-04-01-02-25-05-ops-dev-openclaw-alarm-oauth-selector.txt

---

## 이번 세션 성과

### 1. OpenClaw Phase 1~3 알람 단일 경로 완성 ✅
- P1: hooks 활성화 + openclaw-client.js + Topic 라우팅
- P2: bots/ 19곳 postAlarm 전환
- P3: scripts/ 11곳 + telegram-sender OPS 프록시 (IS_OPS→postAlarm)
  - sender.send/sendCritical/sendBuffered 5개 함수에 IS_OPS 분기
  - sendCritical: emergency + 해당팀 이중 발송
  - sendDirect: OPS 비활성화 (양방향 미적용이라 현재 무해)

### 2. OpenAI OAuth → OpenClaw CLI 경유 ✅
- _callOpenAIOAuth: 직접 API(Bearer) → execFile('openclaw', ['agent', '--json'])
- OAuth 429 해결: OpenClaw 자체 토큰 관리
- 토큰 0→0 해결: agentMeta.lastCallUsage 반환

### 3. 팀별 Selector 공용화 ✅ (커밋 c580918)
- TEAM_SELECTOR_DEFAULTS: claude/blog/worker/core 4팀
- 에이전트별 primary + fallbacks 구조
- _resolveFromTeamDefault(): selector key에서 팀+에이전트 분리
- AGENT_MODEL_REGISTRY: 14배정 / 12미배정
- investment.agent_policy: openai → openai-oauth 교체

### 4. 에이전트별 모델 평가 시스템 ✅ (커밋 c580918)
- llm_model_eval 테이블 (claude 스키마, 자동 생성)
- _recordModelEval() fire-and-forget
- EVAL_EXCLUDED_PROVIDERS: openai-oauth, openai, anthropic 제외
- 폴백 모델(local, groq, gemini)만 기록

### 5. 덱스터 체크섬 자동추적 ✅ (커밋 859b974)
- _scanSkillFiles(): skills/*.js 자동 스캔
- _buildCriticalFiles(): 봇 + 스킬 합산 107개
- missingBaseline vs 불일치 분리 처리

### 6. CI Node.js 24 대응 ✅ (커밋 6109d6e + 2307c5f)
- actions/checkout@v5, setup-node@v5, node-version: '22'
- FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true

### 7. 전체 에이전트 LLM 분석 완료 (시각화 제공)
- 56 에이전트, 30개 LLM 사용, 26개 미사용
- 7일 35,000+ 호출 실측 기반 최적 모델 추천
- 코덱스 프롬프트: CODEX_LLM_MODEL_REORG.md (501줄, 커밋 f6812f1)

### 8. Phase 4 통합 분석 완료 (미구현)
- jay intent + mainbot + OpenClaw 합칠 수 있음!
- isPickkoAlertResolveCommand 하드코딩 12패턴 → LLM 자연어 이해로 대체 가능
- Phase 4A: mainbot.js 비활성화
- Phase 4B: alert resolve → OpenClaw 자연어 통합
- Phase 4C: intent 분류 → OpenClaw 점진적 흡수

---

## 다음 세션 우선순위

```
1순위: LLM 모델 재편성 (CODEX_LLM_MODEL_REORG.md, 501줄)
  - hermes/sophia 로컬 전환 (13,000회/주 → $0)
  - blog 전면 oauth/gpt-5.4 (social 28%→100%)
  - shadow_luna/ska fallback 추가
  - video/step-proposal selector 등록

2순위: Phase 4A — mainbot.js 비활성화
  - mainbot_queue 아카이브
  - filter.js 로직 → Standing Orders 확인

3순위: Phase 4B — alert resolve OpenClaw 통합 (연구)
  - isPickkoAlertResolveCommand → LLM 자연어 이해
  - booking_key 기반 안전 실행 설계

4순위: 블로팀 P1~P5 개선 구현
5순위: D 분해 (인프라+루나)
```

## 핵심 결정 (이번 세션)

```
[DECISION] 클로드팀=코드분야→OpenAI OAuth+GPT-5.4
[DECISION] 팀별 Selector 공용화: _default가 에이전트별 primary/fallback 지정
[DECISION] 모델 평가: openai-oauth/openai/anthropic 제외, 폴백만 평가
[DECISION] blog social/star → oauth/gpt-5.4 (마스터: 고성능 필요)
[DECISION] telegram-sender OPS 프록시: 모든 send 함수에 IS_OPS 분기
[DECISION] OpenClaw CLI 경유: execFile('openclaw', ['agent', '--json'])
[DECISION] Phase 4: jay intent + mainbot + OpenClaw 합칠 수 있고, 합쳐야 맞음
```

## 미커밋 코덱스 프롬프트

```
docs/codex/CODEX_LLM_MODEL_REORG.md (501줄) — 전체 에이전트 모델 재편성
  Task 1: 루나팀 hermes/sophia 로컬, luna 5.4, oracle scout
  Task 2: 블로팀 전면 oauth/gpt-5.4
  Task 3: investment local_primary 라우트
  Task 4: 워커+공용 local fallback
  Task 5: video selector 등록
  Task 6: 오케스트레이터 확인

docs/codex/CODEX_SKILL_PROCESS_CHECK.md (193줄) — 에러 5건 + 미배정 스킬
docs/codex/CODEX_CONFIG_YAML_AUDIT.md (222줄) — config.yaml 전수검사
docs/codex/CODEX_OPENCLAW_PHASE2.md (216줄) — Phase 2 직접발송 전환
docs/codex/CODEX_OPENAI_OAUTH_HUB.md (490줄) — OAuth+Selector+평가
```

## 검증 결과 요약

```
OpenClaw Phase 1~3:
  ✅ hooks 인증 / webhook / Topic 라우팅
  ✅ bots/ sender.send 잔존 0건
  ✅ scripts/ 11곳 직접 교체
  ✅ telegram-sender OPS 프록시

OAuth + Selector + 평가:
  ✅ openai-oauth PRIMARY 성공 (gpt-5.4, OpenClaw CLI)
  ✅ 토큰 기록: 226→24, 171→12 (0→0 해결)
  ✅ selector 상속: 22키, primary/fallbacks 정상
  ✅ llm_model_eval: 6건 축적, 제외 정상

덱스터:
  ✅ LLM 호출 성공 (local 폴백)
  ✅ Shadow 판단 일치
  ⚠️ exit 1 = 보안 경고(secrets.json/gitignore) 때문, LLM 무관

에러 프로세스 (미해결):
  ai.claude.dexter — exit 1 (보안 경고)
  ai.openclaw.model-sync — exit 1
  ai.ska.eve-crawl — exit 1
  ai.ops.platform.* — exit 78 ×2
```

## 핵심 파일

```
변경/신규:
  packages/core/lib/openclaw-client.js (138줄, webhook+topic)
  packages/core/lib/telegram-sender.js (+64줄, OPS 프록시)
  packages/core/lib/llm-fallback.js (+116줄, openai-oauth+평가)
  packages/core/lib/llm-model-selector.js (+353줄, 팀 selector)
  bots/claude/lib/ai-analyst.js (logMeta selectorKey)
  bots/claude/lib/archer/analyzer.js (logMeta selectorKey)
  bots/claude/lib/claude-lead-brain.js (logMeta selectorKey)
  bots/claude/lib/config.js (+30줄, 스킬 자동추적)
  bots/claude/lib/checks/code.js (+12줄, baseline 분리)
  bots/claude/lib/autofix.js (+28줄, 문법에러시 스킵)
  scripts/ 11곳 sender→openclawClient 직접 전환
```
