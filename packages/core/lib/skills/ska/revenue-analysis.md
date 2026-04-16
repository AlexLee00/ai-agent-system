# SKA Skill: Revenue Analysis

## 목적
스터디카페 일/주/월 매출 분석, 이상 감지, Prophet+SARIMA 앙상블 예측.
Rebecca(레베카) + Forecast(포캐스트)가 담당한다.

## 입력/출력
- 입력: `revenue_daily` 테이블 + `environment_factors` + `exam_events`
- 출력: 예측 매출, MAPE, 이상 감지 결과, 텔레그램 리포트

## 예측 모델 (forecast.py)
```
Prophet (primary)
  - weekly_seasonality=True, yearly=False
  - add_country_holidays(KR)
  - regressors: exam_score, rain_prob, vacation_flag, temperature

SARIMA(1,1,1)(1,1,1,7) (단기 보정)
  - statsmodels SARIMAX
  - 14일 이상 데이터 확보 시 활성화

SMA/EMA (빠른 예측)
  - 14일 미만 데이터 또는 보조 예측
  - 앙상블 가중치에 포함

앙상블 = Prophet × 0.5 + SARIMA × 0.3 + SMA/EMA × 0.2
```

## 실행 명령
```bash
# 일별 예측 (기본)
bots/ska/venv/bin/python bots/ska/src/forecast.py --mode=daily

# 주별 예측 (D+1 ~ D+7)
bots/ska/venv/bin/python bots/ska/src/forecast.py --mode=weekly

# 월별 예측 (D+1 ~ D+30)
bots/ska/venv/bin/python bots/ska/src/forecast.py --mode=monthly

# 모델 진단 + 자동 파라미터 튜닝
bots/ska/venv/bin/python bots/ska/src/forecast.py --mode=review

# JSON 출력 (텔레그램용)
bots/ska/venv/bin/python bots/ska/src/forecast.py --mode=daily --json
```

## 핵심 함수 (forecast.py)
- `load_history(con)` — revenue_daily + 환경/시험 JOIN
- `load_weekday_avg(con)` — 요일별 평균 매출
- `load_future_env(con, start, end)` — 미래 환경 변수
- `build_daily_fallback_insight(result_row, mape)` — 예측 인사이트 텍스트
- `_load_model_params()` / `_save_model_params(params)` — 파라미터 자동 저장

## 핵심 함수 (rebecca.py)
- `get_day(con, date)` — 당일 매출 상세
- `get_avg_7d(con, date)` — 7일 평균
- `get_monthly(con, date)` — 월 누적
- `detect_anomalies(today, avg_7d, env_today)` — 이상 감지
- `get_forecast_context(con, date)` — 예측 대비 실적
- `format_telegram(report)` — 텔레그램 메시지 포맷

## DB 테이블
- `ska.revenue_daily` — 일별 실제 매출
- `ska.environment_factors` — 날씨/시험/공휴일 환경 변수
- `ska.exam_events` — 수능/모의고사 일정
- `ska.forecast_results` — 예측 결과 저장 (MAPE 포함)

## 이상 감지 임계값
- 전일 대비 ±30% 이상 변동 → 경고
- MAPE > 15% → 모델 재훈련 트리거 (--mode=review)
- 예측 대비 실제 매출 ±20% 이상 → 알림

## 운영 스케줄 (launchd)
- `ai.ska.forecast` — 매일 18:00 일별 예측
- `ai.ska.forecast.weekly` — 매일 18:05 주별 예측
- `ai.ska.rebecca` — 매일 07:30 전일 실적 분석
