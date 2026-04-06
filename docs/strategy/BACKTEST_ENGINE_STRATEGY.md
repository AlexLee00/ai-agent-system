# 다윈팀 연구 과제: Freqtrade 코드 분석 → 자체 백테스트 엔진 구축

> 작성: 메티 (Claude Opus 4.6)
> 작성일: 2026-04-06
> 목표: Freqtrade 핵심 패턴 추출 → chronos.js 완성 → 루나팀 통합
> 방향: 도구로 "사용"이 아니라 지식으로 "흡수"!

---

## 1. 왜 Freqtrade를 도입하지 않고 분석하는가

```
Freqtrade 패러다임:
  1개 봇 + 1개 전략 + populate_entry_trend() 단일 함수
  = "혼자 판단하는 단일 봇"

팀 제이 패러다임:
  13명 에이전트 + 다전략 + bull/bear 토론
  echo(TA) → oracle(온체인) → hermes(뉴스) → bullish↔bearish 토론
  → luna(융합) → nemesis(리스크) → swift(실행)
  = "팀이 함께 판단하는 다중 에이전트"

Freqtrade를 그대로 쓰면:
  ❌ 13명 에이전트 파이프라인을 1개 함수로 압축해야!
  ❌ 시그마팀 피드백/자율 고용/경쟁과 분리!
  ❌ Python Docker 별도 운영 = 관리 포인트!
  ❌ 전략 이중 관리 (Node.js + Python)

코드 분석으로 흡수하면:
  ✅ 루나팀 파이프라인 그대로 유지!
  ✅ 시그마/다윈/경쟁 시스템과 자연 통합!
  ✅ Node.js 단일 스택!
  ✅ 자체 진화 가능 (Self-Evolving Backtest!)
```

---

## 2. Freqtrade에서 추출할 핵심 패턴 6가지

### 패턴 1: Walk-Forward 자동 리트레이닝

```
Freqtrade FreqAI:
  전체 데이터를 train/test로 분할하지 않음!
  대신 롤링 윈도우로 주기적 재학습:
    [학습 구간 180일][테스트 30일] → 30일 후 →
    [학습 구간 180일][테스트 30일] → ...
  = 시장 변화에 자동 적응!

우리 적용:
  chronos.js에 walk-forward 모듈 추가
  루나팀 전략을 180일 학습 + 30일 테스트로 검증
  매주 자동 재학습 (launchd)
```

### 패턴 2: 슬리피지/수수료 현실화

```
Freqtrade:
  거래 수수료 (maker/taker)
  슬리피지 시뮬레이션
  자금 비용 (funding rate)
  = 현실적인 수익률 계산

우리 적용:
  바이낸스 수수료 0.1% 반영
  슬리피지 모델 (호가창 깊이 기반)
  포지션 크기별 임팩트 계산
```

### 패턴 3: FreqAI 아키텍처 (feature→label→train→predict)

```
Freqtrade FreqAI:
  feature_engineering() → 특성 생성 (RSI, MACD, 볼밴드...)
  set_freqai_targets() → 라벨 정의 (5분 후 가격 변화)
  train() → 모델 학습 (XGBoost/LSTM/RL)
  predict() → 예측 생성

우리 적용:
  루나팀 분석가 시그널 = feature!
    echo의 RSI/MACD = feature
    oracle의 온체인 = feature
    hermes의 뉴스 감성 = feature
    vibe의 Fear&Greed = feature
  luna의 최종 판단 = label!
  실제 수익률 = ground truth!
  → ML 없이도 "어떤 분석가 조합이 가장 정확한가?" 검증!
```

### 패턴 4: 백테스트→드라이런→라이브 3단계

```
Freqtrade:
  freqtrade backtesting → 과거 데이터 시뮬레이션
  freqtrade trade --dry-run → 실시간 가상 거래
  freqtrade trade → 실제 거래

우리 적용 (이미 부분적으로 있음!):
  chronos.js → 백테스트 (구현 필요!)
  PAPER 모드 → 드라이런 (이미 있음!)
  LIVE 모드 → 실거래 (이미 있음!)
  = chronos.js만 완성하면 3단계 파이프라인 완성!
```

### 패턴 5: 하이퍼파라미터 최적화

```
Freqtrade hyperopt:
  전략 파라미터 (RSI 기간, SL/TP 비율 등)를
  자동으로 최적 값 탐색
  = "어떤 RSI 기간이 최적인가?" 자동 탐색

우리 적용:
  nemesis의 ATR 기반 동적 SL/TP 파라미터 최적화
  echo의 지표 기간 최적화
  luna의 신호 융합 가중치 최적화
  → 시그마팀이 최적 파라미터를 피드백!
```

### 패턴 6: 성과 지표 표준화

```
Freqtrade 성과 지표:
  Sharpe Ratio (위험 대비 수익)
  Max Drawdown (최대 낙폭)
  Win Rate (승률)
  Profit Factor (총이익/총손실)
  Avg Trade Duration (평균 거래 시간)
  Expectancy (기대값)

우리 적용:
  analyze-rr.js 확장!
  모든 전략/에이전트별 표준 지표 계산
  시그마팀이 지표 기반 피드백!
  경쟁 시스템에서 지표로 승패 판정!
```

---

## 3. chronos.js 완성 설계

```
현재: chronos.js = Skeleton (주석 상태)
목표: Freqtrade 6패턴 흡수 → 자체 백테스트 엔진!

chronos.js 구조:
  ┌─────────────────────────────────────────┐
  │  chronos.js — 백테스트 엔진             │
  │                                         │
  │  [1] DataLoader                         │
  │    바이낸스 OHLCV 히스토리 다운로드       │
  │    ccxt 활용 (이미 루나팀에서 사용!)      │
  │    캐시: PostgreSQL에 저장              │
  │                                         │
  │  [2] StrategyAdapter                    │
  │    루나팀 에이전트 파이프라인을           │
  │    백테스트 가능한 형태로 래핑            │
  │    echo.analyze(candle) → signal        │
  │    luna.decide(signals) → action        │
  │                                         │
  │  [3] SimulationEngine                   │
  │    주문 매칭 시뮬레이션                  │
  │    슬리피지 + 수수료 반영               │
  │    포지션 관리 (진입/청산/부분청산)      │
  │                                         │
  │  [4] WalkForward                        │
  │    롤링 윈도우 (학습180일+테스트30일)    │
  │    주기적 재평가                        │
  │                                         │
  │  [5] MetricsCalculator                  │
  │    Sharpe/MDD/승률/기대값/PF            │
  │    에이전트별 성과 분해                  │
  │                                         │
  │  [6] Reporter                           │
  │    텔레그램 리포트                       │
  │    시그마팀 피드백 데이터 전달           │
  │    경쟁 시스템 점수 반영                │
  └─────────────────────────────────────────┘
```

---

## 4. 다윈팀 연구 과제 등록

```
연구 ID: DARWIN-BACKTEST-001
제목: Freqtrade 소스 코드 분석 → 자체 백테스트 엔진
담당: scholar (심층 연구) + edison (프로토타입)
LLM: claude-code/sonnet (OAuth)
기간: 6주

Week 1-2: Freqtrade 소스 코드 심층 분석
  scholar가 Freqtrade 핵심 모듈 분석:
    freqtrade/strategy/ — 전략 인터페이스
    freqtrade/optimize/ — 백테스팅 + hyperopt
    freqtrade/freqai/ — ML 통합 아키텍처
    freqtrade/persistence/ — 데이터 영속화
    freqtrade/exchange/ — 거래소 연동
  결과: docs/research/RESEARCH_FREQTRADE_ANALYSIS.md

Week 3-4: chronos.js 핵심 모듈 구현
  edison이 6패턴을 Node.js로 구현:
    DataLoader (ccxt OHLCV)
    SimulationEngine (주문 매칭)
    MetricsCalculator (Sharpe/MDD)
  결과: bots/investment/team/chronos.js 완성

Week 5-6: 루나팀 통합 + 자동화
  StrategyAdapter: 루나팀 파이프라인 래핑
  WalkForward: 롤링 윈도우 자동화
  Reporter: 텔레그램 + 시그마 연동
  launchd 등록: 주간 자동 백테스트
```

---

## 5. 시그마팀/경쟁 시스템 연동

```
백테스트 결과 → 시그마팀:
  "echo의 RSI 시그널이 최근 90일 승률 45% → 가중치 하향!"
  "bullish↔bearish 토론이 일치할 때 승률 78% → 일치 시 배팅 확대!"
  "nemesis의 ATR SL이 너무 타이트 → MDD 개선 위해 1.5배 확대!"

백테스트 결과 → 경쟁 시스템:
  completeCompetition에 백테스트 지표 반영!
  "전략 A: Sharpe 1.8 / MDD 12% vs 전략 B: Sharpe 1.2 / MDD 18%"
  → 전략 A 승! → 에이전트 점수 반영!

백테스트 결과 → 자율 고용:
  "백테스트 성적이 좋은 에이전트 → 고용 점수 상승!"
  "백테스트 성적이 나쁜 에이전트 → 고용 점수 하락 → 교체!"
  = 데이터 기반 에이전트 진화!
```

---

## 6. 궁극적 비전: Self-Evolving Backtest

```
Phase 1: chronos.js 완성 (6주)
  Freqtrade 패턴 흡수 → 자체 엔진

Phase 2: 자동 최적화 (이후)
  시그마팀이 백테스트 결과 분석
  → "이 파라미터 변경하면 Sharpe +0.3"
  → Standing Orders로 자동 적용!

Phase 3: 자율 전략 생성 (장기)
  다윈팀이 최신 논문에서 새 전략 발견
  → chronos.js로 자동 백테스트
  → 성과 좋으면 자동 적용 (Sprint 4 파이프라인!)
  → 성과 나쁘면 자동 폐기

= 전략 발견 → 백테스트 → 적용 → 평가 → 개선
  전부 자동! 마스터는 주간 리포트만!
  = Self-Evolving Trading System!

이것이 팀 제이만의 차별점:
  Freqtrade: 1개 봇이 1개 전략 실행
  팀 제이: 13명이 팀으로 판단 + 자동 진화!
```
