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
| TS-L1 | 재기동 직후 라이브 | n/a | - | - |
| TS-L2 | 7일 관측 (§D 대비) | n/a | n/a | - |

기록 규칙: PASS(일자) / FAIL(사유) / '-' 미실시. 코덱스 자가 컬럼은 자기보고 표 기준,
메티 독립 컬럼은 메티 재검증 통과 시에만 기입.

## G. H6 추가 (2026-06-11 — 루나 자동승급 패턴 이식)

| ID | 내용 | 상태 | 다음 행동 | 검증 기준 |
|---|---|---|---|---|
| H6 | Hub LLM Promotion Gate (계약+증거+ready_for_master_review, --apply 영구차단) | 프롬프트 | CODEX-H 적용 후 코덱스 구현 | GATE-H/GATE-H3 판정이 §D 수동 측정과 일치 + apply 차단 assert |

이력 추가: 2026-06-11 루나 hybrid-promotion-gate 분석 -> H6 설계(설계서 §9) + CODEX-H6 프롬프트 작성 (메티)
