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
- 수정된 결정(2026-06-12): darwin/sigma 최종 체인은 기본 `openai(perf|mini) -> local/qwen2.5-7b`.
  Groq fallback은 반복 429/풀고갈로 인해 기본 차단하고, `HUB_DARWIN_SIGMA_GROQ_FALLBACK_ENABLED=true`에서만 opt-in.
  planner/evaluator류 cap/timeout 조정은 H3 동적 예산에서 별도 처리.
- F1 주석의 학습(groq-primary 금지)은 유지 — Groq는 기본 체인에서 제외한다.

**H1-c. darwin purpose 태깅**: 호출부 runtime_purpose 전달 보강 (unknown 44 제거; audit 가능화).

### H2 — local(qwen2.5-7b) 백테스팅 전용화 (마스터 명시 제약)

**H2-a. darwin/sigma Groq fallback 기본 차단**: 반복 429/풀고갈 알람을 줄이기 위해 darwin/sigma 체인의 Groq fallback을 기본 비활성화한다.
  local fallback은 운영 안전망으로 유지하고, Groq 재도입은 명시 env opt-in과 관측 게이트를 요구한다.
**H2-b. 알람 해석기 4종 (F5) 교체**: local primary -> groq_scout primary + openai_mini 폴백.
  현재 **폴백 없음** = local 죽으면 알람 해석 사망(운영 리스크) — 교체와 동시에 폴백 신설. 알람은 실시간성 중요 -> groq(0.86s)가 적합.
**H2-c. 전역 가드**: applyProviderRuntimeGuards 확장 — taskType이 `backtest_*`가 아니면 provider 'local' 엔트리를 체인에서 제거.
  local-embedding은 별도 provider로 **유지**(pgvector/chronos embedding 경로 무관).
- 효과: Groq 풀고갈이 darwin/sigma 기본 경로를 소진시키는 현상을 차단한다. qwen on-demand 로드 빈도와 지연은 H3/H4 관측으로 별도 최적화한다.
- env: `HUB_DARWIN_SIGMA_GROQ_FALLBACK_ENABLED` (기본 false), `HUB_LLM_LOCAL_BACKTEST_ONLY`는 전역 local 가드 실험 시 별도 사용.

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
- darwin/sigma 기본 체인에서 provider='groq' 0건 / local fallback 성공률과 mlx qwen 로드 빈도 관측
- groq 풀고갈 시 폴백 latency: 즉시 스킵으로 단축 (attempted_providers에서 groq 부재 확인)
- 알람 해석 폴백 동작: local 중단 시에도 성공

## 6. 리스크 / 마스터 결정 포인트
1. (결정 1) H2-a 후 darwin 안전망: 기본은 openai -> local fallback. Groq fallback은 env opt-in으로만 재도입.
2. (결정 2) H1-a 쿨다운 기본 on/off — 보수적이면 shadow(로그만) 1주 후 활성.
3. 알람 해석기 provider 교체로 호출당 미세 비용 발생(현 local $0) — 빈도 낮아 영향 미미.
4. H3는 판정 아닌 운영 변경이나 장문(blog) timeout 보장 회귀 주의 — claude-code base 150s 보존.

---

## 7. 확정 로드맵 (2026-06-11 마스터 결정 반영)

결정1 = 2026-06-12 갱신: H2-a 이후 darwin/sigma 안전망은 기본 openai-oauth -> local/qwen2.5-7b.
Groq fallback은 `HUB_DARWIN_SIGMA_GROQ_FALLBACK_ENABLED=true`에서만 opt-in.
결정2 = 즉시 활성: H1-a 쿨다운은 기본 ON (env 킬스위치로 즉시 복귀 가능).

| Phase | 내용 | 산출물 | 게이트(통과 기준) | 담당 |
|---|---|---|---|---|
| 0 | CODEX-H 프롬프트 (H1-a/b/c + H2-a/b/c + H5) | docs/codex/CODEX_HUB_H_RELIABILITY_2026-06-11.md | 메티 작성 완료 | 메티 |
| 1 | CODEX-H 구현 | selector/unified-caller/스모크 diff | 코덱스 자가검증 통과 | 코덱스 |
| 2 | 메티 독립 검증 | 스모크 재실행 + flag OFF 동일성 + 가드/쿨다운 직접 호출 | §5 사전 기준(스모크 레벨) 전부 통과 | 메티 |
| 3 | 마스터 적용 | 커밋 + ai.hub.resource-api 재기동 | 라이브 darwin 1사이클 정상 + 알람 해석 정상 | 마스터 |
| 4 | 7일 관측 | 트래커 §D 베이스라인 대비 측정 | darwin 실패 한 자릿수 / 실패평균 <30s / darwin·sigma Groq 기본 호출 0건 / qwen 로드 빈도 관측 | 메티 |
| 5 | CODEX-H3 (동적 예산, 섀도 1주 -> 활성) | token-budget 산출기 + 섀도 로그 | 캘리브레이션 오차 검토 + blog 장문 회귀 없음 | 메티->코덱스 |
| 6 | H4 피드백 루프 설계서 | 별도 설계 문서 | 마스터 승인 | 메티 |

롤백 계획: Phase 3 이후 이상 시 env로 즉시 복귀 — HUB_LLM_RATELIMIT_COOLDOWN_ENABLED=false,
HUB_DARWIN_SIGMA_GROQ_FALLBACK_ENABLED=true 또는 HUB_LLM_LOCAL_BACKTEST_ONLY=false (단 alarm.interpreter 교체는 selector 코드이므로
이상 시 git revert + 재기동).

---

## 8. 테스트 시나리오 (정식 원천 — CODEX-H 검증 기준)

형식: Given(전제) / When(행위) / Then(기대). 코덱스는 자가검증에서, 메티는 독립 검증에서
동일 TS-ID로 결과를 보고한다. 추적: TRACKER §F.

### H1-a 쿨다운 (unified-caller 단위)
| ID | Given | When | Then |
|---|---|---|---|
| TS-1 | groq 응답=풀고갈/429 | noteRateLimitCooldown 기록 직후 체인 재실행 | groq 사전 스킵, attempted_providers에 groq 부재 |
| TS-2 | Retry-After=120s 제공 / 미제공 | 쿨다운 기록 | 120s 적용 / 최소 30s 적용 |
| TS-3 | 체인의 모든 provider가 쿨다운 중 | 체인 실행 | 마지막 엔트리 1개는 시도 (완전 불능 방지) |
| TS-4 | HUB_LLM_RATELIMIT_COOLDOWN_ENABLED=false | 풀고갈 후 재실행 | 쿨다운 무시 — 현행 동일 동작 |

### H1-b / H2-a darwin·sigma 체인 (selector 해석)
| ID | Given | When | Then |
|---|---|---|---|
| TS-5 | darwin.planner 요청 | 체인 해석 | primary=openai-oauth, fallback=local/qwen2.5-7b, groq·gemini 부재 |
| TS-6 | planner/evaluator/scanner | 체인 해석 | H3 전에는 기존 cap 유지, H3 적용 후 taskType별 cap/timeout 산출 |
| TS-7 | edison/verifier/commander | 체인 해석 | anthropic 계열 비변경 (before와 동일) |
| TS-8 | sigma.agent_policy 요청 | 체인 해석 | darwin과 동일하게 groq 기본 부재, local fallback 허용 |

### H2-b 알람 해석기
| ID | Given | When | Then |
|---|---|---|---|
| TS-9 | alarm.interpreter.{work,report,error,critical} | 체인 해석 | primary=groq + 폴백>=1(openai), maxTokens 기존값 유지 |
| TS-10 | alarm.classifier | 체인 해석 | 비변경 (before와 동일) |

### H2-c local 가드
| ID | Given | When | Then |
|---|---|---|---|
| TS-11 | taskType 없음(일반 요청) | 체인 해석 | provider 'local' 엔트리 부재 |
| TS-12 | taskType=backtest_judgment | 체인 해석 | local 엔트리 허용(체인에 있던 경우 유지) |
| TS-13 | chronos backtest embedding 요청 | 체인 해석 | local-embedding 유지 (기존 chronos 매트릭스 embedding_provider=local-embedding 그대로) |
| TS-14 | HUB_LLM_LOCAL_BACKTEST_ONLY=false | 일반 요청 해석 | 가드 비활성 — local 잔존 허용(현행 동일) |

### H1-c / 회귀
| ID | Given | When | Then |
|---|---|---|---|
| TS-15 | darwin planner 호출부 | 페이로드 검사(grep/스모크) | runtimePurpose(또는 taskType) 존재 |
| TS-16 | 기존 스모크 일체 | 재실행 | chronos 매트릭스 5케이스·payload·direct-provider guard 전부 무변경 통과 |

### 라이브 단계 (코덱스 범위 밖 — Phase 3/4, 메티·마스터)
| ID | 시점 | 기준 |
|---|---|---|
| TS-L1 | 재기동 직후 | darwin 1사이클 attempted_providers에 groq 부재 + local fallback 또는 openai 성공 + 알람 해석 정상 |
| TS-L2 | 7일 후 | TRACKER §D 베이스라인 대비: darwin 실패 한 자릿수, 실패평균<30s, darwin·sigma groq 기본 호출 0건, qwen 로드 빈도 관측 |

---

## 9. H6 — Hub LLM Promotion Gate (루나 자동승급 패턴 이식, 2026-06-11 추가)

배경: 마스터는 shadow 항목의 승급(활성 전환)을 항목별로 수동 점검할 수 없다. 루나팀의
검증된 자동승급 메커니즘(`luna-hybrid-promotion-gate.ts` + runtime, Phase10)을 분석한 결과
Hub에 그대로 이식 가능한 패턴임을 확인했다.

### 9.1 루나 패턴 분석 (원본: bots/investment/shared/luna-hybrid-promotion-gate.ts)
| 요소 | 메커니즘 | Hub 이식 |
|---|---|---|
| 계약(Contract) | 컴포넌트별 5요소 명세(checkScript/runtime/skill/hook/evidence 테이블) — 체크리스트가 코드 | H 항목별: env flag 존재 + TS 스모크 통과 + 코드 마커 |
| 증거(Evidence) | 최근 168h DB에 shadow 데이터 실존 쿼리 — "실제로 돌고 있다" 증명 | public.llm_routing_log 지표 쿼리 (§9.3) |
| 상태 머신 | blocked -> contract_only -> shadow_ready_data_pending -> **ready_for_master_review** | 동일 명명 채택 |
| 안전 핵심 | `promotionReady: false` 하드코딩 + `--apply` 영구 차단 — 자동검증+후보제시까지만, 승급 실행은 마스터 | 동일 (env 전환은 마스터만) |

### 9.2 H6 구성
- `bots/hub/lib/hub-llm-promotion-gate.ts` — buildHubLlmPromotionGateReport(contract+evidence+상태)
- `bots/hub/scripts/runtime-hub-llm-promotion-gate.ts` — CLI(--json/--strict/--hours/--gate=<id>), `--apply` 영구 차단
- ready_for_master_review 도달 시 기존 알람 채널로 통지 -> 마스터는 env 1개 전환만 수행

### 9.3 게이트 정의 (evidence 판정 기준)
| Gate ID | 대상 | 계약 | 증거 기준 (기본 168h, §D 베이스라인 대비) |
|---|---|---|---|
| GATE-H | CODEX-H 적용 후 안정 (TS-L2 자동화) | TS-1~16 스모크 통과 + env 2종 존재 | darwin 실패<=9 AND 실패평균<30s AND local 일반 호출=0 AND darwin 전체 unknown purpose 비율<5% (주: 2026-06-12 보정 — §D의 44건은 실패-중-unknown이므로 evidence(전체 기준)와 지표 상이. H1-c 태깅 적용 시 0 수렴) |
| GATE-H3 | H3 동적예산 섀도->활성 | H3 flag(shadow) 존재 + 섀도 로그 스키마 | 섀도 표본>=1000 AND 산출timeout<실제소요 비율<1% AND blog 장문 회귀 0 |

### 9.4 로드맵 통합 (§7 갱신 해석)
- Phase 4(7일 관측)의 수동 측정 -> **GATE-H 자동 판정**으로 대체. 메티는 게이트 리포트 검증만.
- Phase 5(H3 섀도->활성)의 전환 판단 -> **GATE-H3 ready 신호** 기반.
- 실행 주기: launchd 일 1회(마스터 등록) 또는 메티 세션 시 수동 1회.

---

## 10. 로드맵 이관 공지 (2026-06-12)

본 문서 §7의 로드맵은 H 시리즈 완료(TS-L1 PASS)로 1차 목적을 다했다.
**전 시리즈(P/H/R/S) 통합 로드맵의 단일 원천은 HUB_SYSTEM_STABILITY_DESIGN_2026-06.md §5**로 이관한다.
이후 로드맵 갱신은 그 문서에서만 수행한다 (이중 관리 금지). H 잔여 항목(GATE-H ready, H3)도 통합 로드맵 순번 2·4에 반영됨.
