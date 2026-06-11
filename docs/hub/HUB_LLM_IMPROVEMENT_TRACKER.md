# Hub LLM 개선 추적 문서 (HUB_LLM_IMPROVEMENT_TRACKER)

관리: 메티(Meti) | 갱신: 2026-06-11
설계: docs/hub/HUB_LLM_RELIABILITY_DESIGN_2026-06.md
규칙: 상태 변경 시 본 문서 갱신. 검증은 메티 독립 재검증 통과 기준.

## 상태 범례
`설계` 설계만 존재 / `프롬프트` CODEX 프롬프트 작성됨 / `구현` 코덱스 구현 완료 /
`검증` 메티 독립 검증 통과 / `적용` 마스터 커밋+재기동 라이브 / `보류` 결정 대기

---

## A. 완료 (코드리뷰 시리즈 P1~P4, 2026-06-10)

| ID | 내용 | 상태 | 검증 근거 |
|---|---|---|---|
| P1 | chronos 게이트 대칭화 (taskType 조건부 우회 + 정책 복원) | 적용 | 라이브 luna표기 judgment 200 + DB caller_team=luna success=t |
| P2 | hub-llm-client 관측 무음실패 카운터 (noteObservabilityDrop) | 적용 | 15곳 교체, 제외 2곳 보존, 스모크 통과 |
| P3 | routes/llm.ts 403 중복 6곳 -> 헬퍼 3개 (1279->1254줄) | 적용 | 98047b912, 응답 JSON 무변형, guard 스모크 403 확인 |
| P4 | taskType alias 단일화 + callerTeam 기본값 의도 명문화 | 검증 | camel/snake 양표기 통과, 커밋+hub 재기동 대기 |

## B. 진행 대기 (H 시리즈 — 설계서 §3)

| ID | 내용 | 상태 | 다음 행동 | 검증 기준 (설계서 §5) |
|---|---|---|---|---|
| H1-a | provider 레벨 rate-limit 쿨다운 (사전 스킵) | 설계 | 결정2 후 CODEX-H 프롬프트 | 풀고갈 시 attempted에 groq 부재, 실패평균 <30s |
| H1-b | darwin 체인 단일화 + cap 2048->1024 | 설계 | CODEX-H | darwin 실패 한 자릿수, 체인 단일성 스모크 |
| H1-c | darwin purpose 태깅 | 설계 | CODEX-H | unknown 0건 |
| H2-a | darwin/sigma 폴백에서 local 제거 (545행 push 삭제) | 설계 | **결정1 필요** | provider=local 일반 호출 0건 |
| H2-b | 알람 해석기 4종 local->groq_scout + 폴백 신설 (현재 폴백 없음!) | 설계 | CODEX-H 최우선 포함 | local 중단 시 알람 해석 생존 |
| H2-c | 전역 가드: backtest_* 외 local 차단 (local-embedding 제외) | 설계 | CODEX-H | 가드 스모크 통과/차단 assert |
| H3 | 동적 timeout/출력예산 (섀도->활성) | 설계 | CODEX-H3 (2차) | 산출값 캘리브레이션 1주 + blog 장문 회귀 없음 |
| H4 | 피드백 루프 (usage->selector 자동조정) | 보류 | 별도 설계서 | - |
| H5 | 스모크 확장 (크기×provider×쿨다운) | 설계 | 각 CODEX 동반 | 신규 assert 전부 통과 |

## C. 마스터 결정 대기

| # | 결정 | 옵션 | 메티 권고 |
|---|---|---|---|
| 결정1 | H2-a 후 darwin 안전망 | (안1) groq_scout 폴백+쿨다운 게이트 / (안2) openai 단독 | 안1 |
| 결정2 | H1-a 쿨다운 시작 모드 | 즉시 활성 / shadow 1주 후 활성 | 즉시 활성 (메커니즘 단순, Retry-After 존중) |

## D. 관측 베이스라인 (2026-06-11, 7일 창 — 효과 비교용)

darwin 실패 51/64 | 실패평균 97s | local 일반 62건 | unknown purpose 44건 |
groq 0.86s · openai 4.9s · local 18.6s · claude-code 118s (avg) | 풀고갈 메시지 48건

## E. 이력
- 2026-06-11: 문서 신설 (오류 실측 + 소스 심층분석 기반 설계 확정, 메티)
