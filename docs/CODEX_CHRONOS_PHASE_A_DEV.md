# CODEX_CHRONOS_PHASE_A_DEV — Chronos Layer 1~3 백테스팅 엔진

> 실행 대상: 코덱스 (코드 구현)
> 환경: **맥북 에어 (DEV)** → git push → OPS 배포
> 작성일: 2026-03-30
> 작성자: 메티 (전략+설계)

---

## 사전 조건

⚠️ **OPS 프롬프트(`CODEX_CHRONOS_PHASE_A_OPS.md`)가 먼저 완료되어야 함.**

OPS에서 완료된 항목:
- Ollama 서버 launchd 등록 + 자동 실행
- qwen2.5:7b + deepseek-r1:32b 모델 다운로드
- localhost:11434 API 동작 확인

이 DEV 프롬프트는 OPS 완료 후, 코드 구현만 진행합니다.

---

## 설계 개요: Chronos 3계층 하이브리드 백테스팅

```
Layer 1 — 규칙 엔진 (LLM 없음, 초고속)
  ccxt로 과거 OHLCV 수집 → PostgreSQL 저장
  기술지표 계산: RSI, MACD, 볼린저밴드, ATR
  1차 필터링: 수천 개 캔들 → 유의미 신호 ~200개 추출
  비용: $0 / 속도: 수 초

Layer 2 — 로컬 LLM 감성 시뮬 (Ollama qwen2.5:7b)
  Layer 1 추출 ~200개 신호에만 적용
  소피아(감성) + 헤르메스(뉴스) 역할 시뮬레이션
  비용: $0 / 속도: 신호당 2~3초

Layer 3 — 로컬 LLM 판단 시뮬 (Ollama deepseek-r1:32b)
  Layer 2 통과 신호에 대해
  루나(종합판단) + 네메시스(리스크) 역할 시뮬레이션
  비용: $0 / 속도: ~30분
```

---

## 작업 1: DB 마이그레이션 — ohlcv_cache 테이블

새 파일: `bots/investment/migrations/ohlcv-cache.sql`

```sql
CREATE TABLE IF NOT EXISTS investment.ohlcv_cache (
  symbol      TEXT NOT NULL,
  exchange    TEXT NOT NULL DEFAULT 'binance',
  timeframe   TEXT NOT NULL DEFAULT '5m',
  open_time   BIGINT NOT NULL,
  open        DOUBLE PRECISION,
  high        DOUBLE PRECISION,
  low         DOUBLE PRECISION,
  close       DOUBLE PRECISION,
  volume      DOUBLE PRECISION,
  fetched_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (symbol, exchange, timeframe, open_time)
);

CREATE INDEX IF NOT EXISTS idx_ohlcv_symbol_time
  ON investment.ohlcv_cache(symbol, timeframe, open_time DESC);
```

db.js에 마이그레이션 자동 실행 추가 (initSchema에서).

---

## 작업 2: OHLCV 수집기

새 파일: `bots/investment/shared/ohlcv-fetcher.js`

```
역할:
  ccxt로 바이낸스 과거 OHLCV 수집 → PostgreSQL ohlcv_cache 저장
  이미 있는 기간은 스킵 (UPSERT, 중복 방지)

핵심 함수:
  fetchAndStore(symbol, timeframe, from, to)
    → ccxt.fetchOHLCV() 반복 호출 (1000개씩 페이징)
    → PostgreSQL UPSERT (ON CONFLICT DO NOTHING)
    → 진행률 로그

  getOHLCV(symbol, timeframe, from, to)
    → DB에서 조회 (캐시 활용)
    → 없으면 자동 fetch

CLI: node shared/ohlcv-fetcher.js --symbol=BTC/USDT --from=2025-01-01 --timeframe=5m

주의:
  - ccxt 바이낸스 rate limit 준수 (1200 req/min)
  - 기존 shared/db.js의 DB 연결 패턴 사용
  - 날짜 파싱: kst.js 활용
```

---

## 작업 3: 기술지표 계산기

새 파일: `bots/investment/shared/ta-indicators.js`

```
역할:
  OHLCV 배열 → 기술지표 계산 (순수 수학, LLM 없음)

의존성: npm install technicalindicators

함수:
  calcRSI(closes, period=14) → number[]
  calcMACD(closes, fast=12, slow=26, signal=9)
    → { macd, signal, histogram }[]
  calcBollingerBands(closes, period=20, stddev=2)
    → { upper, middle, lower }[]
  calcATR(highs, lows, closes, period=14) → number[]
  calcEMA(data, period) → number[]
  calcSMA(data, period) → number[]

참고: 기존 aria.js에 유사 로직 있을 수 있음
  → aria.js를 읽고 중복 방지. 공통화 가능하면 추출.
```

---

## 작업 4: Ollama HTTP 클라이언트

새 파일: `bots/investment/shared/ollama-client.js`

```
역할:
  로컬 Ollama REST API (localhost:11434) 호출 래퍼
  Chronos Layer 2~3에서 사용

함수:
  isOllamaAvailable() → boolean
    GET http://localhost:11434/api/version
    타임아웃 3초

  callOllama(model, prompt, options={}) → string|null
    POST http://localhost:11434/api/generate
    body: { model, prompt, stream: false, options }
    타임아웃: qwen2.5:7b → 30초, deepseek-r1:32b → 120초
    에러 시: null 반환 (백테스트 중단 방지)
    options 기본값: { temperature: 0.3, num_predict: 500 }

  callOllamaJSON(model, prompt, options={}) → object|null
    callOllama 호출 후 JSON.parse 시도
    파싱 실패 시: null 반환

패턴: 기존 hub-client.js와 동일 (AbortController + 타임아웃 + null 반환)
참고: OPS Hub는 localhost:7788, Ollama는 localhost:11434 — 포트 충돌 없음
```

---

## 작업 5: Chronos Layer 1~3 구현

수정 파일: `bots/investment/team/chronos.js` (스켈레톤 121줄 → 확장)

### Layer 1: 규칙 엔진

```
기존 runBacktest() 스켈레톤을 실제 구현으로 교체:

1. ohlcv-fetcher.getOHLCV()로 기간 데이터 로드
2. ta-indicators로 RSI/MACD/BB/ATR 계산
3. 신호 필터링 규칙:
   - RSI > 70 → 과매수 (잠재 SELL)
   - RSI < 30 → 과매도 (잠재 BUY)
   - MACD 골든크로스 → BUY 신호
   - MACD 데드크로스 → SELL 신호
   - BB 하단 돌파 → BUY 신호
   - BB 상단 돌파 → SELL 신호
4. 필터링된 신호 목록 반환 (Layer 2 입력)
5. 신호 기반 가상 매매 → 수익률/MDD/샤프 계산
```

### Layer 2: 감성 LLM 시뮬레이션

```
Layer 1에서 추출된 신호 각각에 대해:

1. 해당 시점 맥락 구성:
   - 최근 24시간 가격 변화율
   - RSI/MACD 현재값
   - 거래량 변화율

2. Ollama qwen2.5:7b 호출 — 소피아(감성) 시뮬레이션:
   프롬프트: "당신은 암호화폐 감성 분석가입니다.
   다음 시장 데이터를 보고 감성을 판단하세요.
   [데이터: RSI=72, 24h변화=+3.2%, 거래량=1.5배]
   JSON으로 답: { sentiment, confidence, reasoning }"

3. 결과를 Layer 3 입력에 추가
```

### Layer 3: 판단 LLM 시뮬레이션

```
Layer 2 결과에 대해:

1. Ollama deepseek-r1:32b 호출 — 루나(팀장) 시뮬:
   프롬프트: "당신은 트레이딩 팀장입니다.
   [기술분석: RSI=72, MACD=골든크로스]
   [감성분석: BULLISH (confidence 0.7)]
   [리스크: 포지션 3개, 자본사용률 45%]
   JSON으로 답: { action, confidence, reasoning }"

2. 네메시스 리스크 규칙 적용 (LLM 불필요):
   - 최대 동시 포지션 초과 → HOLD
   - 일일 최대 손실 초과 → HOLD

3. 최종 신호: BUY/SELL/HOLD + 사이즈
```

### CLI 인터페이스

```
# Layer 1만 (규칙 엔진, 빠름)
node team/chronos.js --symbol=BTC/USDT --from=2026-01-01 --to=2026-03-30 --layer=1

# Layer 1~3 통합 (LLM 포함, ~30분)
node team/chronos.js --symbol=BTC/USDT --from=2026-01-01 --to=2026-03-30 --layer=3

# 결과 출력: 수익률, MDD, 샤프비율, 승률, 총 거래수
```

---

## 완료 기준

### DEV 단계

```bash
# 1. npm 의존성
npm install technicalindicators

# 2. 문법 검사
node --check bots/investment/shared/ohlcv-fetcher.js
node --check bots/investment/shared/ta-indicators.js
node --check bots/investment/shared/ollama-client.js
node --check bots/investment/team/chronos.js

# 3. git push
git add -A
git commit -m "feat(luna): Chronos Layer 1~3 백테스팅 엔진

- ohlcv-fetcher.js: ccxt OHLCV 수집 + PostgreSQL 캐시
- ta-indicators.js: RSI/MACD/BB/ATR 기술지표
- ollama-client.js: 로컬 Ollama HTTP 클라이언트
- chronos.js: 3계층 백테스팅 (규칙→감성LLM→판단LLM)
- migration: ohlcv_cache 테이블"
git push origin main
```

### OPS 배포 후 (자동 5분 cron)

```bash
# 4. OHLCV 수집 테스트
node bots/investment/shared/ohlcv-fetcher.js \
  --symbol=BTC/USDT --from=2026-03-01 --timeframe=1h
# 기대: ~720개 캔들 수집 + DB 저장

# 5. Ollama 클라이언트 테스트
node -e "
const { callOllama, isOllamaAvailable } = require('./bots/investment/shared/ollama-client');
(async () => {
  console.log('available:', await isOllamaAvailable());
  const r = await callOllama('qwen2.5:7b', 'Say hello');
  console.log('response:', r?.slice(0, 50));
})();
"

# 6. Chronos Layer 1 백테스트
node bots/investment/team/chronos.js \
  --symbol=BTC/USDT --from=2026-03-01 --to=2026-03-30 --layer=1
# 기대: 신호 N개 + 수익률/MDD/샤프 출력

# 7. Chronos Layer 1~3 통합 백테스트
node bots/investment/team/chronos.js \
  --symbol=BTC/USDT --from=2026-03-01 --to=2026-03-30 --layer=3
# 기대: LLM 시뮬 포함 결과 (소요 ~10~30분)
```
