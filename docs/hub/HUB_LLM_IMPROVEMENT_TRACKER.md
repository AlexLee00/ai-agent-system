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

## L. S 시리즈 신설 (2026-06-12 — Hub 전체 시스템 안정성, 설계서: HUB_SYSTEM_STABILITY_DESIGN_2026-06.md)

| ID | 내용 | 상태 | 비고 |
|---|---|---|---|
| S-1 | local 회로 x on-demand 콜드스타트 충돌 보정 | 설계 (**긴급**) | OPEN 고착 실측 — backtest 경로 차단 위험 |
| S-2 | 알람 발송 outbox + 실패 카운터 | 설계 | alarm-client timeout 실측 |
| S-3 | pgPool 가시성/한도 (/hub/health 노출) | 설계 | |
| S-4 | 재기동 감사 + .plist.bak 6개 정리 | 설계 | SIGTERM 주체 불명 2회 |
| S-5 | GATE-S (Hub 자체 건강 게이트, H6 확장) | 설계 | stage-b 리포트 -> 판정 자동화 |
| S-6 | 무중단 재기동 | 보류 (비조치 결정) | |

통합 로드맵: 설계서 §5 — S1(긴급) -> GATE-H ready -> S2/S3 -> H3 -> R1~R4 -> S4/S5.
이력: 2026-06-12 Hub 전체 정밀 분석(25,715줄 인벤토리 + 실측 + 외부 검증 LiteLLM★50k/TensorZero★11k) -> S 시리즈 설계 + 통합 로드맵 재설계 (메티)

## M. 문서 정합 갱신 + 세션 마감 (2026-06-12)

### 갱신 내역
1. 테스트 시나리오: S 시리즈 TS-S1-1~TS-SL2 신설 — 원천=HUB_SYSTEM_STABILITY_DESIGN §7
   (H 시리즈 TS-1~16 원천은 RELIABILITY §8 유지 — 문서별 원천 분리, 이중 기재 금지)
2. 로드맵 단일 원천화: 통합 로드맵 = STABILITY §5 (RELIABILITY §10에 이관 공지)
3. §F 확장: 아래 TS-S 행 추가

### §F 추가분 — S 시리즈 통과 현황
| TS | 영역 | 코덱스 자가 | 메티 독립 | 라이브 |
|---|---|---|---|---|
| TS-S1-1~5 | S-1 콜드스타트 회로 | - | - | - |
| TS-S2-1~3 | S-2 알람 outbox | - | - | - |
| TS-S3-1~2 | S-3 풀 가시성 | - | - | - |
| TS-S4-1 | S-4 재기동 감사 | - | - | - |
| TS-S5-1~3 | S-5 GATE-S | - | - | - |
| TS-SL1/SL2 | 라이브 | n/a | - | - |

### 다음 세션 진입점 (세션 마감 합의)
1. git status — 오늘 산출물 커밋 확인 (CODEX-H 코드 + 문서 4종: STABILITY 설계서/RELIABILITY §9·10/트래커/CODEX-H6 파일들)
2. **CODEX-S1 프롬프트 작성** (TS-S1-1~5 기준, local-circuit 코드 위치 분석 포함) — 새 세션 1순위
3. 6/14: GATE-H --hours=48 선행 판정 / 6/18: 정식 ready 예상
4. 대기: R1 정책엔진 설계(병행 가능), 루나 robust 벌크 재백테스트 + CODEX-BT-A/B 전달

이력: 2026-06-12 TS-S 시나리오 신설 + 로드맵 단일 원천화 + 세션 마감 (메티)

## N. 세션 시작 점검 + CODEX-S1 프롬프트 (2026-06-12 저녁 세션)

### 시작 점검
- hub PID 22837 연속 가동(재기동 없음), RSS 132MB 안정. CODEX-H 코드 커밋 확인(512b92fe7).
- 직전 문서 산출물(STABILITY 설계서 등)은 미커밋 — 마스터 커밋 대기.
- plist 변경 출처 판명: HUB_CONTROL_APPROVER_IDS/APPROVAL_CHAT_ID env 템플릿 추가(control 승인 작업, 무해).
  green plist는 5/31부터 존재 = **blue-green 전환 메커니즘 기존재** -> S-4 SIGTERM 주체의 유력 단서로 기록.

### CODEX-S1 프롬프트 작성 완료
- 파일: docs/codex/CODEX_HUB_S1_LOCAL_COLD_START_2026-06-12.md
- 사전 분석 확정: local-ollama.ts DEFAULT 15s < 콜드 로드(핫 평균도 18.6s) + 회로 THRESHOLD 3/OPEN 30s
  + HALF_OPEN probe 동일 15s 실패 = 고착 루프.
- 설계: **2단 타임아웃 재시도** (1차 30s -> timeout 시 1회 재시도 180s, timeout 사유에만, 재시도 성공=회로 무손상).
  env 3종(TIMEOUT/COLD_START_TIMEOUT/COLD_RETRY_ENABLED 킬스위치). circuit-breaker/local-llm-client/
  local-embedding/unified-caller **4개 비접촉** — 변경 최소화.
- 검증 기준: STABILITY §7 TS-S1-1~5 + 신규 스모크(local-cold-start-retry-smoke) + 라이브 TS-SL1.

S-1 상태: 설계 -> **프롬프트**.
이력: 2026-06-12 저녁 세션 시작 점검 + CODEX-S1 프롬프트 (메티)

## O. CODEX-S1 메티 독립 검증 (2026-06-12) — 합격

| 항목 | 결과 |
|---|---|
| 변경 범위 | local-ollama.ts + 신규 스모크 + package.json (luna callback 3파일은 별도 스트림 비접촉) |
| env 3종 | HUB_LLM_LOCAL_TIMEOUT_MS(30s)/COLD_START_TIMEOUT_MS(180s)/COLD_RETRY_ENABLED(킬스위치) — 8-10행 명세 일치 |
| 재시도 로직 | shouldRetryColdStart: 킬스위치 + failureReason==timeout만 + 명시 timeout이 DEFAULT 이하일 때만 — 명세 일치. connection refused류 즉시 실패 유지 |
| 회로 의미 | 1차 timeout 미기록 -> 재시도 성공=recordSuccess만(무손상) / 최종 실패=recordFailure 1회 / 미발동 실패=즉시 기록 — THRESHOLD 3 의미 보존 |
| TS-S1-1~5 | 스모크 독립 재실행 ok:true 전부 PASS (S1-5 HALF_OPEN -> cold retry 성공 -> CLOSED 복귀 포함) |
| 비접촉 4영역 | circuit-breaker / local-llm-client / unified-caller / local-embedding diff 없음 |
| provider:failed 의심 | 기존 관행 확인(HEAD~1 동일) + unified-caller가 체인 기준 기록 — 무해. R 시리즈 코드위생 후보로만 기록 |
| 커밋 | 자동커밋 447f09758 "Improve Hub local cold start..."가 이미 처리 |

남은 단계: **마스터 ai.hub.resource-api 재기동** -> 메티 TS-SL1 라이브(qwen idle 언로드 확인 -> backtest judgment 1건 -> 성공 + 회로 OPEN 전이 없음 + coldStartRetried 텔레메트리 확인).
S-1 상태: 프롬프트 -> **검증** (적용 대기).
이력: 2026-06-12 CODEX-S1 독립 검증 합격 (메티)

## P. TS-SL1 라이브 검증 (2026-06-12, hub PID 37536 재기동 후) — PASS

| 검증 | 방법 | 결과 |
|---|---|---|
| 콜드스타트 성공 | qwen 언로드 확인(mlx RSS~0) -> callLocalOllama 직접 호출(동일 모듈) | ok=true, 10.5s(콜드 로드 포함), 1차 성공(30s 상향 효과) |
| 회로 무손상 | 호출 후 isCircuitOpen | false — OPEN 전이 없음 |
| 재시도 경로 | 라이브는 핫 상태라 미발동(585ms 1차 성공) — mock 스모크 TS-S1-1/2/5로 검증 완료 | 충분 |

### GATE-H 조기 신호 (--hours=6, 참고용)
- darwin failure / failed_avg blocker **소멸** — CODEX-H 적용 효과 즉시 확인.
- 잔여 2건: local_general 1건 + darwin unknown 2/5 — **18:59-19:01 클러스터** (darwin launchd weekly라
  자연 트래픽 아님, 시험 트래픽 추정). 현 코드 darwin 체인에 local 부재는 TS-L1+스모크로 증명됨.
  **6/14 --hours=48 선행 판정에서 재확인** — 19:01 이후 재발 시 가드 구멍으로 격상 조사.

S-1 종결: 설계 -> 프롬프트 -> 구현 -> 독립검증 -> 적용 -> **TS-SL1 PASS**. 콜드스타트 고착 루프 해소.
다음: 6/14 GATE-H 선행 판정 / ~6/18 정식 ready / R1 정책엔진 설계(승인 시) / S-2+S-3는 GATE-H ready 후.
이력: 2026-06-12 TS-SL1 PASS + S-1 종결 (메티)

## Q. 세션 마감 (2026-06-12 밤) — 다음 세션 진입점: R1 정책엔진 설계

### 이번 세션 완결 사항
- CODEX-S1 독립 검증 합격 + 적용 + **TS-SL1 라이브 PASS** -> S-1(콜드스타트 고착) 종결
- GATE-H 조기 신호: darwin failure/avg blocker 소멸 (CODEX-H 효과 확인)
- 커밋: 자동커밋이 코드(447f09758)+문서(3db280380) 처리 — 잔여는 트래커 §P/§Q뿐

### 다음 세션 1순위: R1 정책엔진 설계 (마스터 승인됨)
- 산출물: docs/hub/HUB_LLM_POLICY_ENGINE_DESIGN_2026-06.md + 전수 스냅샷 스크립트
- 입력 자료: §J 분산 정량(selector 2,211줄 / 후처리 함수 12+ / HUB_* env 7 / selectorVersion 분기 19 / 프로필 테이블 2벌(LEGACY 623행, 현행 1008행)) + CODEX-H로 정리된 darwin 체인(목표 구조 1호 사례)
- 설계 범위: ① 선언 정책 스키마(team x agent x taskType -> chain/cap/timeout/flags)
  ② 단일 파이프라인(resolvePolicy -> buildChain -> applyGlobalGuards(쿨다운/local가드/disabled) -> budget -> execute)
  ③ 현행 전수 스냅샷(전 팀 x 용도 체인 해석 덤프 — R2 shadow diff=0의 기준선)
  ④ GATE-R 정의(H6 게이트에 1종 추가) ⑤ R3 팀 전환 순서/킬스위치
- 원칙: 기존 인프라 재활용(runtime-profiles/token-budget/unified-caller 골격 유지), 빅뱅 금지

### 일정 항목
- 6/14: GATE-H --hours=48 선행 판정 (19:01 local 1건/unknown 클러스터 재확인 포함)
- ~6/18: GATE-H 정식 ready 예상 -> CODEX-S2(알람 outbox)+S3(풀 가시성) 착수
- 루나 트랙 대기: robust 벌크 재백테스트 + CODEX-BT-A/B 코덱스 전달

이력: 2026-06-12 세션 마감 — Hub 트랙 P/H/H6/S1 완결, R1 설계 승인 (메티)

## R. R1 정책엔진 설계 완료 (2026-06-12 밤 세션)

- 설계서: docs/hub/HUB_LLM_POLICY_ENGINE_DESIGN_2026-06.md (§1~9)
- 신규 실측: 정책 표면 **89 selectorKey x 12팀** + agent 내부 차원(SIGMA_ROUTES 1863행 신규 식별) +
  A/B 퍼센트 롤아웃 메커니즘 기존재(LLM_TEAM_SELECTOR_AB_PERCENT) + 후처리 암묵 순서 8단계 명문화.
- **스냅샷 함정 확정**: describeLLMSelector 기본=LEGACY 해석 (alarm.error: default=claude-code/400 vs
  oauth4=groq/320=라이브 현행) -> 전 스냅샷 oauth4 명시 고정 (TS-R1-2로 회귀 방지).
- 스냅샷 도구 = 기존 listLLMSelectorKeys + describeLLMSelector 재사용 (신규 해석 로직 금지).
- 전환: R2 shadow(MODE env, GATE-R diff=0) -> R3 팀 단위 -> R4 소거(분기 19->0, 후처리 12->가드 4, env 7->2~3).
- 테스트 원천: 설계서 §7 TS-R1-1~TS-R4-1.

상태: R1 **설계** (마스터 승인 대기 — 결정 3건: 설계 승인 / 정책 저장소 TS모듈 권고 / 롤아웃 레버 MODE 권고).
승인 시 다음: CODEX-R1 프롬프트(스냅샷 스크립트만, 엔진은 R2).
이력: 2026-06-12 R1 설계서 작성 (메티)
