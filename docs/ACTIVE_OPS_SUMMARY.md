# Active Ops Summary

> 마지막 업데이트: 2026-03-22
> 목적: 다음 세션과 운영자가 "지금 바로 봐야 할 이슈"만 빠르게 파악하기 위한 전사 운영 요약판.
> 원칙: 이 문서는 history가 아니라 active risk / watch / recently resolved만 다룬다.

---

## 1. 현재 판단

- 전체 플랫폼은 **운영 가능 상태**다.
- 다만 현재 우선순위는 장애 대응보다 **원장 정합성 / 응답 계약 / 운영 관찰 구조 보강**에 있다.
- `SESSION_HANDOFF.md`는 사실 이력과 맥락을 유지하고, 이 문서는 **현재 액션 우선순위**만 본다.

---

## 2. 지금 바로 봐야 할 항목

### P1. 제이/OpenClaw gateway rate limit + retry burst

- 상태: **1차 안정화 완료, 관찰 필요**
- 근거:
  - `scripts/reviews/jay-gateway-experiment-daily.js`
  - 최신 스냅샷 기준 `rate limit=76`, `active rate limit=33`
  - `embedded unique runs=14`, `retry burst runs=13`, `max attempts per run=4`
- 이번 세션 조치:
  - fallback chain을 ready provider만 남도록 `11 -> 4`로 정리
  - `maxConcurrent=1`, `subagents.maxConcurrent=2`로 보수화
  - `ai.openclaw.gateway` 재기동 완료
  - gateway 실험 리포트에 `마지막 gateway 재기동 이후` 창을 추가해 과거 24시간 노이즈와 현재 상태를 분리
- 의미:
  - 미준비 fallback이 복구 경로를 오염시키던 문제는 해소
  - 남은 진짜 병목은 `Gemini rate limit` 이후 동일 run 재시도 burst
- 지금 당장 필요한 구조:
  - post-prune / post-tune 창에서 `provider auth missing`, `retry burst` 감소 여부 관찰
  - `main` / `session:*` lane 동시 버스트를 분리 해석
- 나중에 확장할 구조:
  - provider `registered / ready / cooldown / disabled` 공통 계약
  - gateway KPI에 `rate limit / retry burst / lane duplication` 분리 기록

### P1. 스카 취소 상위 응답 레이어

- 상태: **구현 경계 복구 완료, 실전 관찰 단계**
- 근거:
  - [pickko-cancel-cmd.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/manual/reservation/pickko-cancel-cmd.js)는
    `partialSuccess`, `pickkoCancelled`, `naverUnblockFailed`를 분리 반환
  - 이번 세션에서 스카 command contract에 `cancel_reservation`을 추가해
    [ska-command-handlers.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/ska-command-handlers.js),
    [dashboard-server.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/dashboard-server.js),
    [router.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.js)까지 같은 result shape가 흐르도록 연결 완료
- 의미:
  - 문서에는 있었지만 실제 contract에 빠져 있던 취소 write-path가 정식 command로 승격됨
  - 이제 부분 실패를 완전 성공처럼 포장할 구조적 위험이 크게 줄어듦
- 지금 당장 필요한 구조:
  - 실전 취소 1건에서 `partialSuccess`가 실제 텔레그램 문구 `픽코 취소 완료, 네이버 수동 확인 필요`로 분기하는지 관찰
- 나중에 확장할 구조:
  - 취소 응답 표준 계약 문서화
  - `pickko cancel / naver unblock` 단계별 사용자 문구 분리

### P2. 스카 daily_summary 무결성

- 상태: **다른 채팅에서 수정 진행 중**
- 근거:
  - `node bots/reservation/scripts/health-report.js --json`
  - 경고: `2026-03-21: room_amounts_json 156000원 != pickko_study_room 10500원`
- 의미:
  - 매출 원장 신뢰성 이슈
  - worker 매출 미러 / 향후 SaaS 정산 구조에 직접 영향
- 지금 당장 필요한 구조:
  - 현재 채팅에서는 중복 수정하지 않고 진행 상황만 관찰
- 나중에 확장할 구조:
  - `integrity report`를 health와 분리
  - `daily_summary` 저장 시 derived/stored delta 자동 기록

### P2. 오케스트레이터 reporting payload 경고

- 상태: **원인 수정 완료, 로그 잔상 관찰 중**
- 근거:
  - `reservation/rebecca`, `system/reporting-hub`가 `payload.summary`에 객체를 넣던 문제 수정
  - [night-handler.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/night-handler.js)에서
    `forecast_summary`, `warning_summary`로 키 변경
- 의미:
  - 공용 reporting-hub schema drift는 막았음
  - `/tmp/reporting-payload-warnings.jsonl` 24시간 잔상 때문에 리포트에 예전 2건이 보일 수 있음
- 지금 당장 필요한 구조:
  - 새 warning이 추가로 쌓이지 않는지 관찰
- 나중에 확장할 구조:
  - payload schema severity 표준화
  - producer별 schema contract lint

### P2. 비디오 preview/quality 원장화

- 상태: **미착수**
- 근거:
  - `validation_report.json` 기준 5세트 preview 검증 성공
  - 하지만 `preview_ms`, `quality_score`, `quality_pass`, `loop_iterations`는 원장 저장이 불충분
- 의미:
  - 기능은 통과했지만 운영 KPI 관찰성이 부족함
- 지금 당장 필요한 구조:
  - `video_edits`에 preview/quality 메타 저장
- 나중에 확장할 구조:
  - RAG 추정값 / 실제 wall-clock 비교
  - SaaS 가격/성능 모델링 데이터 축적

---

## 3. 관찰 중 항목

### 스카 manual follow-up 원장

- 상태: **이번 세션 기준 정상화**
- 기준점:
  - `manual-block-followup-report.js --from=2026-03-21`
  - `openCount=0`
- 다음 관찰:
  - 새 manual 등록 1건에서
    - `last_block_attempt_at`
    - `last_block_result`
    - `last_block_reason`
    - `block_retry_count`
    가 실제로 쌓이는지 확인

### 스카 자동 취소 E2E

- 상태: **부분 보강 완료, 실전 검증 필요**
- 기준점:
  - `naver-monitor.js`는 자동 취소 성공 후 `--unblock-slot`까지 후속 실행하도록 수정됨
- 제약:
  - 미래 취소 감지 스캔 범위와 테스트 예약 날짜가 어긋나면 자동 E2E 검증이 어렵다
- 다음 관찰:
  - 60일 이내 테스트 예약으로
    - 취소 감지
  - pickko cancel
  - naver unblock
  전체 확인

### 제이 gateway post-prune 관찰

- 상태: **1차 관찰 성공**
- 기준점:
  - fallback `11 -> 4`
  - `ready fallback=4`, `unready fallback=0`
  - concurrency `2/4 -> 1/2`
- 최신 관찰:
  - `log-jay-gateway-experiment.js` 기준 `마지막 gateway 재기동 이후: rate limit 0건 / auth missing 0건 / retry burst 0건`
- 다음 관찰:
  - 새 트래픽이 더 쌓였을 때도 post-restart 창이 낮게 유지되는지 확인
  - rolling 24시간 창이 자연히 내려오는지 확인
  - 다시 높아지면 upstream rate-limit 또는 backoff 설계 재검토

### 비디오 quality score

- 상태: **성공은 했지만 품질 목표 미달**
- 기준점:
  - `avg_quality_score=80`
  - 목표 `85`
- 다음 관찰:
  - quality-loop 수렴률
  - Critic/Refiner/RAG 반영률

---

## 4. 최근 해소된 항목

- 스카 manual 등록 후속 차단 silent failure 원장화 완료
- 민경수 포함 manual 미래 예약 8건 수동 처리 후 `manually_confirmed` 반영 완료
- 스카 취소 경로:
  - 자동 취소 후 `--unblock-slot` 후속 실행 연결 완료
  - 수동 취소 partial success 계약 분리 완료
- 제이/OpenClaw gateway:
  - 미준비 Groq/Cerebras fallback 제거 완료
  - concurrency `maxConcurrent=1`, `subagents.maxConcurrent=2` 보수화 완료
  - 실험 리포트에 `auth missing`, `retry burst` 분리 지표 추가
- orchestrator reporting payload 경고 원인 수정 완료
- 비디오 5세트 preview 검증 복구 완료

---

## 5. 다음 자연스러운 작업 순서

1. 제이 gateway post-prune 관찰 창에서 `retry burst` 감소 여부 확인
2. 스카 취소 상위 응답 레이어 실전 관찰
3. 스카 `daily_summary` 별도 채팅 진행 상황 확인
4. 비디오 preview/quality 원장화

---

## 6. 참고 문서

- [SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
- [WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)
- [TEST_RESULTS.md](/Users/alexlee/projects/ai-agent-system/docs/TEST_RESULTS.md)
- [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
