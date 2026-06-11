# Hub LLM 신뢰성 보강 설계서 (HUB_LLM_RELIABILITY_DESIGN)

작성: 메티(Meti) / 2026-06-11
상태: 설계 확정 대기 (마스터 결정 포인트 2건 포함)
추적: docs/hub/HUB_LLM_IMPROVEMENT_TRACKER.md
참고: bots/hub/docs/LLM_ROUTING.md (엔드포인트 가이드), 외부 사례(LiteLLM/TensorZero/OpenAI·Anthropic SDK 표준)

---

## 0. 요약 (TL;DR)

7일 6.5만 호출 중 최종 실패 64건(0.1%)이지만 실패의 80%가 darwin 한 팀에 집중되고,
실패까지 평균 97초를 끈다. 근본 구조는 ①darwin 폴백 체인의 이중 구조와 다양성 부족,
②rate-limit에 대한 provider 레벨 사전 스킵 부재, ③timeout/출력예산이 프로필 고정값,
④local(qwen2.5-7b)이 폴백·알람 경로에 박혀 메모리 제약(백테스팅 전용)과 충돌.
본 설계는 H1(오류 직격)~H5(스모크)로 단계화하고, H1+H2를 1차 CODEX로 묶는다.

## 1. 실측 현황 (public.llm_routing_log, 7일)

| 항목 | 값 | 함의 |
|---|---|---|
| 총 호출 / 최종 실패 | 64,858 / 64 (0.1%) | 총량 양호, 패턴 집중 |
| 실패 팀 분포 | darwin 51 (80%), claude 5, blog 6 | darwin이 진앙 |
| darwin 실패 체인 (attempted) | [openai/gpt-5.4 -> groq/llama-3.1-8b] 40건, [openai -> local] 15건 | 1차 openai 실패 선행 + 폴백 2종 공존 |
| 실패 원인 메시지 | Groq 풀고갈/429 = 48/64 | 마지막 에러가 Groq (선행 openai 실패 가려짐) |
| 실패까지 평균 | 97초 (avg_fb 1.91) | 고정 timeout(25-60s)+재시도 누적 |
| provider 평균 지연 | groq 0.86s / openai 4.9s / local 18.6s / claude-code 118s | provider별 속도 130배 차 — 단일 timeout 정책 부적합 |
| local 사용 | darwin.planner 62 (폴백 발동, avg_fb 0.98) + hub alarm 1 | 마스터 제약(백테스팅 전용) 충돌 + qwen on-demand 로드 트리거 |
| local-embedding | 32건 | 별도 provider — 유지 대상 |
| purpose 태깅 | darwin 'unknown' 44건 | audit 불가 상태 |

## 2. 코드 사실 지도 (심층분석 확정분)

호출 경로: 클라이언트 -> routes/llm.ts -> llm-selector(resolveHubLlmSelection)
  -> packages/core llm-model-selector(팀 프로필/체인) -> token-budget(예산/timeout)
  -> unified-caller(회로/폴백 실행) -> provider(openai-oauth/groq/claude-code/local/local-embedding)

| # | 사실 | 위치 |
|---|---|---|
| F1 | darwin/sigma agent_policy: gemini 대체는 openai로 강제(과거 groq 풀고갈 학습 주석 존재) | llm-model-selector.ts replacementForGemini (~500) |
| F2 | 동 경로 bounded 체인: groq 제거 + local 최종 폴백 push | ensureOpenAiPrimaryWithBoundedFallback (~545) |
| F3 | 단 DARWIN_ROUTES(agentName별 추상 라우트)에 groq_scout/qwen_deep 폴백 잔존 -> 체인 2종 공존(실측 40 vs 15) | 'darwin.agent_policy' 함수 내 (~1882) |
| F4 | HUB_DARWIN_SIGMA_GROQ_PRIMARY 미설정 (openai-primary 경로 활성) | env 확인 |
| F5 | local 명시 primary: hub alarm.interpreter.{work,report,error,critical} 4종, **폴백 없음** | llm-model-selector.ts ~1009 |
| F6 | groq: 키별 Retry-After 블랙리스트 구현됨, 풀 전체 고갈 시 즉시 에러 | groq-fallback.ts 66/254/343 |
| F7 | 429/풀고갈은 회로 실패로 기록 안 함(의도: 건강 문제 아님) -> **provider 레벨 쿨다운 부재**, 풀고갈 중에도 체인이 groq을 계속 시도 | unified-caller.ts ~700 |
| F8 | gemini 비활성은 사전 스킵 처리(시도 낭비 없음; 명목 체인 잔존은 위생 문제) | unified-caller.ts 419/498 |
| F9 | timeout: profile 고정 상한(25-60s, perAttempt 12-30s). inputTokens 계산하나 timeout 산출에 미사용 | token-budget.ts ~227 |
| F10 | 출력예산: 라우트 고정 maxTokens(1024/2048), taskType별 동적 cap 없음 | routeEntryFromAbstractRoute |

## 3. 개선 설계

### H1 — 오류 직격 (darwin 80% + 97초 견인 해소)

**H1-a. Provider 레벨 rate-limit 쿨다운 (사전 스킵)**
- 문제: F6은 키 레벨만. 풀 전체 고갈 시에도 다음 요청들이 groq을 다시 시도(F7) -> 폴백 깊이/시간 낭비.
- 설계: unified-caller에 rate-limit 쿨다운 레지스트리(in-memory) 신설. groq 응답이 풀고갈/429일 때
  `rateLimitCooldownUntil[provider] = now + max(Retry-After, 30s)` 기록. 체인 실행 시 F8(gemini 스킵)과
  동일 지점에서 `now < cooldownUntil`이면 해당 provider 엔트리 사전 스킵. 회로(F7 의도)와 분리 유지.
- 외부 정합: LiteLLM cooldown_time/allowed_fails, OpenAI·Anthropic SDK의 Retry-After 존중과 동일 사상.
- env: `HUB_LLM_RATELIMIT_COOLDOWN_ENABLED` (기본 true 제안, 보수적으로 false 시작 가능), `HUB_LLM_RATELIMIT_COOLDOWN_MIN_MS=30000`.

**H1-b. darwin 체인 단일화 + 출력 cap**
- 문제: F3 이중 체인(40 vs 15 실측). DARWIN_ROUTES의 groq 폴백과 bounded의 local 폴백이 경합.
- 설계: darwin/sigma 최종 체인을 명시 단일화 — openai(perf|mini) -> groq_scout(쿨다운 게이트 하) 순.
  local은 H2에서 제거. planner/evaluator류 maxTokens 2048->1024 (groq 토큰 소비 절감 = 429 빈도 절감).
- F1 주석의 학습(groq-primary 금지)은 유지 — groq은 폴백 위치만.

**H1-c. darwin purpose 태깅**: 호출부 runtime_purpose 전달 보강 (unknown 44 제거; audit 가능화).

### H2 — local(qwen2.5-7b) 백테스팅 전용화 (마스터 명시 제약)

**H2-a. 폴백에서 local 제거**: F2의 localFastEntry push 삭제.
  ⚠️ 결정 포인트 1: 제거 후 darwin 안전망 = (안1) groq_scout 폴백(H1-a 쿨다운과 결합) — 권장 / (안2) openai 단독 fail-fast.
**H2-b. 알람 해석기 4종 (F5) 교체**: local primary -> groq_scout primary + openai_mini 폴백.
  현재 **폴백 없음** = local 죽으면 알람 해석 사망(운영 리스크) — 교체와 동시에 폴백 신설. 알람은 실시간성 중요 -> groq(0.86s)가 적합.
**H2-c. 전역 가드**: applyProviderRuntimeGuards 확장 — taskType이 `backtest_*`가 아니면 provider 'local' 엔트리를 체인에서 제거.
  local-embedding은 별도 provider로 **유지**(pgvector/chronos embedding 경로 무관).
- 효과: qwen on-demand 로드 빈도 감소(메모리 4.9GB 보호), darwin/알람 지연 개선(18.6s -> 1-5s).
- env: `HUB_LLM_LOCAL_BACKTEST_ONLY` (기본 true 제안).

### H3 — 동적 timeout / 출력 예산 (2차)

- token-budget에 산출기 신설: `dynamicTimeout = clamp(base[provider] + maxOutputTokens × perTokenMs[provider] + inputPenalty, floor, profile.timeoutMs)`.
  base 시드(실측 p50): groq 2s / openai 8s / local 25s / claude-code 150s. perAttempt도 동일 원리.
- 출력 cap 계층: taskType 기반 — planner 1024 / evaluator 800 / judgment 1024 / synthesis 2048 / blog(장문) 8000. 요청 maxTokens와 min().
- env flag: `HUB_LLM_DYNAMIC_BUDGET_ENABLED` (기본 false, 섀도 로그로 검증 후 활성).
- 섀도 모드: 활성 전 1주간 "산출값 vs 실제 소요"를 routing_log에 병기해 캘리브레이션.

### H4 — 피드백 루프 (3차, 별도 설계)
llm_token_budget_usage + routing_log 기반: 최근 1h provider 실패율/timeout률 -> 체인 순서·cap 자동 조정. TensorZero metrics-feedback 사상. 본 설계서 범위 밖 — 스케치만 기록.

### H5 — 스모크 확장 (각 CODEX에 동반)
크기별(소/중/대/장문) × provider별 timeout/cap/쿨다운 시나리오 + darwin 체인 단일성 + local 가드(backtest_* 통과/그 외 차단) assert.

## 4. 롤아웃 순서

| 단계 | 내용 | 형태 |
|---|---|---|
| 0 | H2-b 알람 폴백 신설 (운영 리스크 — local 단일점) | CODEX-H의 일부, 우선 |
| 1 | CODEX-H: H1-a/b/c + H2 전체 + H5 해당분 | 1차 CODEX (flag 게이트) |
| 2 | CODEX-H3: 동적 예산 (섀도 -> 활성) | 2차 CODEX |
| 3 | H4 설계서 별도 작성 | 설계 후 결정 |

## 5. 검증 지표 (적용 후 7일)
- darwin 실패 51 -> 한 자릿수 / 실패까지 평균 97s -> <30s
- provider='local' 일반 호출 0건 (backtest_*만 허용) / mlx qwen 로드 빈도 감소 (grep mlx-server.log)
- groq 풀고갈 시 폴백 latency: 즉시 스킵으로 단축 (attempted_providers에서 groq 부재 확인)
- 알람 해석 폴백 동작: local 중단 시에도 성공

## 6. 리스크 / 마스터 결정 포인트
1. (결정 1) H2-a 후 darwin 안전망: groq_scout 재도입(권장, 쿨다운 게이트) vs openai 단독.
2. (결정 2) H1-a 쿨다운 기본 on/off — 보수적이면 shadow(로그만) 1주 후 활성.
3. 알람 해석기 provider 교체로 호출당 미세 비용 발생(현 local $0) — 빈도 낮아 영향 미미.
4. H3는 판정 아닌 운영 변경이나 장문(blog) timeout 보장 회귀 주의 — claude-code base 150s 보존.
