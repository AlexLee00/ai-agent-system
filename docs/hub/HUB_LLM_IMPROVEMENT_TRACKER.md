# Hub LLM 개선 추적 문서 (HUB_LLM_IMPROVEMENT_TRACKER)

관리: 메티(Meti) | 갱신: 2026-06-11 (로드맵 확정 반영)
설계: docs/hub/HUB_LLM_RELIABILITY_DESIGN_2026-06.md (§7 로드맵)
규칙: 상태 변경 시 본 문서 갱신. 검증은 메티 독립 재검증 통과 기준.

## 상태 범례
`설계` 설계만 존재 / `프롬프트` CODEX 프롬프트 작성됨 / `구현` 코덱스 구현 완료 /
`검증` 메티 독립 검증 통과 / `적용` 마스터 커밋+재기동 라이브 / `관측` 7일 지표 측정 중 / `보류`

---

## A. 완료 (코드리뷰 시리즈 P1~P4, 2026-06-10)

| ID | 내용 | 상태 | 검증 근거 |
|---|---|---|---|
| P1 | chronos 게이트 대칭화 (taskType 조건부 우회 + 정책 복원) | 적용 | 라이브 luna표기 judgment 200 + DB success=t |
| P2 | hub-llm-client 관측 무음실패 카운터 | 적용 | 15곳 교체, 제외 2곳 보존, 스모크 통과 |
| P3 | routes/llm.ts 403 중복 6곳 -> 헬퍼 3개 (1279->1254줄) | 적용 | 98047b912, 응답 무변형, guard 스모크 |
| P4 | taskType alias 단일화 + callerTeam 기본값 명문화 | 검증 | 양표기 통과; 커밋+hub 재기동 대기 |

## B. H 시리즈 (설계서 §3, 로드맵 §7)

| ID | 내용 | 상태 | 다음 행동 | 검증 기준 |
|---|---|---|---|---|
| H1-a | provider rate-limit 쿨다운 (기본 ON + 킬스위치) | 프롬프트 | 코덱스 구현 | 풀고갈 시 attempted에 groq 부재, 실패평균 <30s |
| H1-b | darwin 체인 단일화(openai->local 기본 fallback, groq opt-in) + cap/timeout 후속 | 적용 | 2655e18af 반영, H3 후속 | darwin/sigma 체인에 groq 기본 부재 |
| H1-c | darwin purpose 태깅 | 프롬프트 | 코덱스 구현 | unknown 0건 |
| H2-a | darwin/sigma Groq fallback 기본 차단, local fallback 유지 | 적용 | 7일 관측 | Groq 풀고갈 시 darwin/sigma 기본 체인 영향 없음 |
| H2-b | 알람 해석기 4종 local->groq_scout primary + openai 폴백 신설 | 프롬프트 | 코덱스 구현 (최우선) | local 중단 시 알람 해석 생존 |
| H2-c | 전역 가드: backtest_* 외 local 차단 (local-embedding 제외) | 프롬프트 | 코덱스 구현 | 가드 스모크 통과/차단 assert |
| H3 | 동적 timeout/출력예산 (섀도->활성) | 설계 | Phase 5에서 CODEX-H3 | 캘리브레이션 + blog 장문 회귀 없음 |
| H4 | 피드백 루프 | 보류 | Phase 6 별도 설계 | - |
| H5 | 스모크 확장 (쿨다운/가드/체인 단일성) | 프롬프트 | CODEX-H에 동반 | 신규 assert 전부 통과 |

## C. 마스터 결정 (확정)

| # | 결정 | 확정 내용 | 일자 |
|---|---|---|---|
| 결정1 | H2-a 후 darwin 안전망 | 기본: openai-oauth -> local/qwen2.5-7b, Groq fallback은 `HUB_DARWIN_SIGMA_GROQ_FALLBACK_ENABLED=true`에서만 opt-in | 2026-06-12 |
| 결정2 | H1-a 시작 모드 | 즉시 활성 (기본 ON, env 킬스위치) | 2026-06-11 |

## D. 관측 베이스라인 (2026-06-11, 7일 창 — Phase 4 비교 기준)

darwin 실패 51/64 | 실패평균 97s | local 일반 62건 | unknown purpose 44건 |
groq 0.86s · openai 4.9s · local 18.6s · claude-code 118s (avg) | 풀고갈 메시지 48건

## E. 이력
- 2026-06-11: 문서 신설 (오류 실측 + 소스 심층분석, 메티)
- 2026-06-11: 결정1/2 확정, 로드맵(설계서 §7) 작성, CODEX-H 프롬프트 작성 -> H1/H2/H5 상태 '프롬프트' (메티)
- 2026-06-12: Groq 풀고갈 반복 알람 대응으로 darwin/sigma Groq fallback 기본 차단 및 local fallback 유지로 결정1 갱신 (코덱스, 2655e18af)

## F. 테스트 시나리오 통과 현황 (설계서 §8 — TS-ID 기준)

| TS | 영역 | 코덱스 자가 | 메티 독립 | 라이브 |
|---|---|---|---|---|
| TS-1~4 | H1-a 쿨다운 | - | - | - |
| TS-5~8 | H1-b/H2-a darwin·sigma 체인 | - | - | - |
| TS-9~10 | H2-b 알람 | - | - | - |
| TS-11~14 | H2-c local 가드 | - | - | - |
| TS-15 | H1-c purpose 태깅 | - | - | - |
| TS-16 | 회귀 (기존 스모크 일체) | - | - | - |
| TS-L1 | 재기동 직후 라이브 | n/a | PASS(06-12) | PASS(06-12, hub PID 378) |
| TS-L2 | 7일 관측 (§D 대비) | n/a | n/a | - |

기록 규칙: PASS(일자) / FAIL(사유) / '-' 미실시. 코덱스 자가 컬럼은 자기보고 표 기준,
메티 독립 컬럼은 메티 재검증 통과 시에만 기입.

## G. H6 추가 (2026-06-11 — 루나 자동승급 패턴 이식)

| ID | 내용 | 상태 | 다음 행동 | 검증 기준 |
|---|---|---|---|---|
| H6 | Hub LLM Promotion Gate (계약+증거+ready_for_master_review, --apply 영구차단) | 프롬프트 | CODEX-H 적용 후 코덱스 구현 | GATE-H/GATE-H3 판정이 §D 수동 측정과 일치 + apply 차단 assert |

이력 추가: 2026-06-11 루나 hybrid-promotion-gate 분석 -> H6 설계(설계서 §9) + CODEX-H6 프롬프트 작성 (메티)

## H. H6 검증 기록 (2026-06-12)

| TS | 코덱스 자가 | 메티 독립 | 비고 |
|---|---|---|---|
| TS-G1 (--apply 차단) | PASS | PASS(06-12, exit=2+apply_blocked) | |
| TS-G2~G4 (ready/pending/blocked) | PASS | PASS(06-12, 스모크 ok:true) | |
| TS-G5 (promotionReady 불변) | PASS | PASS(06-12, true 경로 grep 부재) | |
| TS-G6 (GATE-H3 비회귀, 코덱스 추가) | PASS | PASS(06-12) | 명세 외 보너스 |
| evidence 수치 == 수동 측정 | - | PASS(06-12, 224/154978/2568/9466 완전 재현) | 트래커 §G 기준 충족 |

H6 상태: 프롬프트 -> **검증** (커밋+launchd 등록은 마스터, GATE-H 활성 판정은 CODEX-H 적용 후).

### 검증 중 발견 (중요)
1. **진행형 인시던트**: 6/11부터 darwin 실패 193건/일 + local 호출 2,256건/일 폭증
   (6/10까지 ~0). openai 1차 실패 -> local 폴백 대량 발동 구조. qwen2.5-7b 상시 로드로
   on-demand 메모리 효과 상쇄 중. **CODEX-H 적용 긴급성 상승** — §D 베이스라인은 악화 시작
   시점 측정값이며, GATE-H evidence가 현 시점 정확값(168h: 실패 224 / 평균 154.9s / local 2,568).
2. 설계서 §9.3 unknown 임계 보정(2026-06-12): 실패-중-unknown(44) vs 전체-unknown(9,466)
   지표 혼동 — 전체 기준 비율<5%로 재정의 (메티 자기수정). 게이트 코드 상수는 CODEX-H 적용
   후 재조정 시 1줄 반영.

이력 추가: 2026-06-12 H6 메티 독립 검증 통과(TS-G1~G6 + evidence 재현) + §9.3 보정 + 인시던트 기록 (메티)

이력 추가: 2026-06-12 CODEX-H v2 갱신 (메티) — 6/11 인시던트 커밋 3건(50330d116/374cbc170/2655e18af)
분석 반영: local 폭증 직접 원인 = 2655e18af(groq 폴백 중단+local 폴백 도입) 확인,
HUB_DARWIN_SIGMA_GROQ_FALLBACK_ENABLED env 정합 방침(기본 true=groq 폴백, false=openai 단독, local 경로 삭제),
LEGACY/현행 프로필 테이블 두 벌 식별(교체 대상=현행 ~1008행, LEGACY ~623행 비변경), 라인 재확정.

## I. CODEX-H 메티 독립 검증 (2026-06-12) — 합격

| 항목 | 결과 |
|---|---|
| 변경 범위 | 보고 일치 (darwin 5 + hub 4 + core 1; meeting-room dirty 비접촉) |
| H1-a 쿨다운 | 함수 2종 + 455(시도 직전 스킵, _ignoreRateLimitCooldown로 마지막 1개 시도) + 471(기록) + 765(체인 필터) + export(1163, H6 marker) |
| H1-b/H2-a 체인 | localFastEntry 완전 제거, env 기본 true=groq 폴백/false=openai 단독, DARWIN_ROUTES gemini/qwen_deep 0건, anthropic 보존. 직접 해석: darwin.planner=[openai-oauth -> groq] |
| H2-b 알람 | 현행(1012행)=groq 160 primary+폴백 신설, LEGACY(635행)=원래 groq 200 비변경 |
| H2-c 가드 | local 정확일치 비교(local-embedding 자동 보존), normalizeTaskTypeInput 재사용, env false=현행 복귀 |
| TS-1~16 | 스모크에 구조화 내장(codex_h_reliability_ts) — 메티 독립 재실행 15+1건 전부 PASS |
| GATE-H | shadow_ready_data_pending — **contract blocker 0 (marker 3개 해소)**, evidence 4건은 6/11 과거 데이터 (정상) |
| 제한 | node --check는 .ts 타입 구문으로 불가 -> tsx 로드 대체 (레포 관행상 합리) |

§F 갱신: TS-1~4/5~8/9~10/11~14/15/16 — 코덱스 자가 PASS, 메티 독립 PASS(06-12). TS-L1 PASS(06-12), TS-L2 대기.

## J. 전환 전략 재수립 (2026-06-12 — CODEX-H 검증 완료 기준)

### 즉시 (마스터)
1. 커밋 + `ai.hub.resource-api` 재기동 완료. **plist env 추가 불필요** — 코드 기본값이 목표 상태
   (쿨다운 ON / 가드 ON / groq 폴백 ON). 킬스위치 3종만 인지: HUB_LLM_RATELIMIT_COOLDOWN_ENABLED=false,
   HUB_LLM_LOCAL_BACKTEST_ONLY=false, HUB_DARWIN_SIGMA_GROQ_FALLBACK_ENABLED=false.
2. TS-L1 (메티): 재기동 직후 darwin 모의 호출 local 부재 + 알람 해석 정상 확인 완료(§K).
3. GATE-H evidence: 168h 창에 6/11 인시던트 포함 -> **6/18경 자동 ready 예상**.
   조기 확인: 적용 +48h에 `--hours=48` 게이트로 선행 판정 (메티), 정식 판정은 168h 기본.

### R 시리즈 (정책 엔진 — 분산 해소)
| Phase | 내용 | 상태/시점 | 게이트 |
|---|---|---|---|
| R0 | CODEX-H (darwin 체인이 목표 구조 1호 사례) | **검증 완료 — TS-L1 통과, GATE-H 관측 중** | GATE-H |
| R1 | 정책 스키마 설계 + 현행 전수 스냅샷(전 팀×용도 체인 덤프 = 회귀 기준) | 적용 직후 착수 (메티 설계서) | 마스터 승인 |
| R2 | 정책 엔진 구현 + shadow 비교(신구 diff=0) | R1 승인 후 CODEX-R | GATE-R 신설(H6 패턴) |
| R3 | 팀 단위 점진 전환: darwin/sigma -> hub -> blog -> luna/claude | GATE-R ready 후 | 팀별 evidence |
| R4 | 레거시 소거: 프로필 테이블 2벌->1, selectorVersion 19분기->0, HUB_* env 7->2~3 | R3 완료 후 | 회귀 스모크 |

목표 효과: llm-model-selector.ts 2,211줄 -> 엔진 ~300줄 + 선언 정책 데이터.
신규 정책 = 데이터 1행. 인시던트 대응 = env 신설이 아니라 정책 행 수정.

이력 추가: 2026-06-12 CODEX-H 독립 검증 합격(TS-1~16) + GATE-H contract 통과 + 전환 전략 재수립(§J) (메티)

## K. TS-L1 라이브 검증 (2026-06-12, hub PID 378 재기동 후) — PASS

| 검증 | 방법 | 결과 |
|---|---|---|
| darwin.planner 체인 | 모의 호출 (darwin launchd가 weekly뿐이라 자연 트래픽 부재 -> 직접 유발) | provider=openai-oauth/gpt-5.4-mini, local 부재 PASS |
| 알람 해석 | 모의 호출 selectorKey=hub.alarm.interpreter.work | provider=groq (구 local 탈출) PASS |
| local 일반 호출 | 재기동 후 창 | 0건 PASS |
| 참고 | selectorKey는 팀 prefix 포함 형식(hub.alarm.*)이 정식 — prefix 없는 호출은 chain_required로 실패(과거에도 동일, 회귀 아님) | |

남은 단계: GATE-H --hours=48 선행 판정(~6/14, 메티) -> 정식 168h ready(~6/18) -> R1 설계 착수.
이력: 2026-06-12 TS-L1 PASS 기록 (메티)
