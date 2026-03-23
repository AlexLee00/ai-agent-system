# 스카 예측엔진 업데이트 전략 (2026-03-22)

## 1. 결론

- 스카 매출 source of truth는 이제 `reservation.daily_summary.total_amount` 단일값이 아니다.
- 현재 운영 기준 총매출은 아래 조합으로 읽어야 한다.
  - `총매출 = general_revenue + pickko_study_room`
- 따라서 예측엔진은 `revenue_daily.actual_revenue`와 feature store 입력을 이 기준으로 다시 정렬해야 한다.

## 2. 현재 상태

### 지금 당장 필요한 구조

- `reservation.daily_summary`
  - `pickko_study_room`
  - `general_revenue`
  - `room_amounts_json`
  를 함께 읽어야 한다.
- `bots/ska/src/etl.py`는 이제
  - `studyroom_revenue = pickko_study_room`
  - `general_revenue = general_revenue`
  - `actual_revenue = studyroom_revenue + general_revenue`
  기준으로 `ska.revenue_daily`를 upsert 해야 한다.
- `bots/ska/lib/feature_store.py`는
  - `payment_day|study_room`를 더 이상 active source로 읽지 않는다.
  - 기존 `study_room_payment_*` 컬럼은 training schema 호환용으로만 유지하고 `0`으로 고정한다.
  - `total_amount`는 legacy compatibility / fallback trace 용도로만 취급한다.

### 나중에 확장할 구조

- `reservation.daily_summary`에 source policy/version 메타 추가
- `ska.revenue_daily`에도 `source_version`, `reservation_total_revenue`, `reservation_studyroom_revenue`, `reservation_general_revenue`를 분리 저장
- forecast feature store는 raw source snapshot과 training target을 모두 보존

## 3. 업데이트 전략

### Phase A. source/read 경로 정렬

- 대상:
  - `bots/reservation/lib/ska-read-service.js`
  - `bots/reservation/scripts/dashboard-server.js`
  - `scripts/collect-kpi.js`
- 목표:
  - `total_amount` 직접 사용 대신 `general_revenue + pickko_study_room`을 총매출로 사용
  - 기존 필드는 호환용으로 유지하되, 새 `total_revenue` 축을 함께 노출

### Phase B. ETL target 정렬

- 대상:
  - `bots/ska/src/etl.py`
- 목표:
  - `revenue_daily.actual_revenue`를 새 총매출 정의로 교체
  - `studyroom_revenue`, `general_revenue`도 같은 기준으로 분리 저장
- 효과:
  - 이후 `forecast.py`, `forecast_health.py`, `rebecca.py`, review scripts는 `revenue_daily`만 봐도 일관된 총매출 기준을 사용하게 된다.

### Phase C. feature store / forecast 검증

- 대상:
  - `bots/ska/lib/feature_store.py`
  - `bots/ska/src/forecast.py`
  - `bots/ska/src/forecast_health.py`
  - `scripts/reviews/ska-sales-forecast-daily-review.js`
  - `scripts/reviews/ska-sales-forecast-weekly-review.js`
- 점검 포인트:
  - `actual_revenue`가 새 총매출 기준으로 들어오는지
  - `payment_day|study_room` 기반 stale feature가 학습 입력에 남아 있지 않은지
  - `total_amount`가 legacy 호환 필드로만 쓰이고 primary feature처럼 해석되지 않는지
  - `studyroom_revenue_ratio`, `general_revenue_ratio` feature가 여전히 유효한지
  - 최근 MAPE 변동이 source 변경 때문인지 모델 성능 때문인지 구분 가능한지

### Phase D. 재학습/관찰

- 지금 당장 필요한 구조
  - 기존 모델을 즉시 폐기하지 않음
  - ETL/feature store 갱신 후 최근 구간 예측/리뷰를 다시 돌려 drift 여부를 관찰
- 나중에 확장할 구조
  - source version별 forecast accuracy 비교
  - 멀티워크스페이스 확장 시 workspace별 revenue policy 분기

## 4. 리스크

- `total_amount` 의미가 historical row마다 다를 수 있어 혼합 구간 해석이 필요하다.
- `study_room_payment_*`처럼 삭제된 축을 전제로 만든 feature를 그대로 두면
  historical/current 데이터 의미가 달라져 학습 품질이 흔들릴 수 있다.
- ETL만 바꾸고 review/query 계층을 안 바꾸면 운영 숫자와 예측 숫자가 서로 달라질 수 있다.
- feature store는 `actual_revenue` 기준이 바뀌면 과거 모델 비교가 왜곡될 수 있다.

## 5. 권장 다음 단계

1. source/read 경로와 ETL을 먼저 정렬한다.
2. `revenue_daily` 최근 30~90일 재적재 여부를 판단한다.
3. review / forecast health / rebecca 출력을 새 기준으로 재검증한다.
4. 필요하면 forecast 재학습 또는 shadow 비교를 다시 시작한다.
