# CODEX_CHRONOS_PHASE_A — Ollama 서버 + 모델 + Chronos Layer 1 설계

> 실행 대상: 코덱스 (코드 구현)
> 환경: **맥 스튜디오 (OPS)** — Ollama는 OPS에서만 실행
> 작성일: 2026-03-30
> 작성자: 메티 (전략+설계)
> OPS 설정 절차: 마스터 승인 후 코덱스가 OPS에서 직접 구현

---

## 배경

루나팀 Tier 2 — Chronos(백테스팅) 구축 시작.
백테스팅에 LLM이 필수인 이유: 실투자 파이프라인이 LLM 기반 판단이므로
규칙 엔진만으로는 "실제 파이프라인의 성능"을 검증할 수 없음.

API LLM 비용 비현실적 (1회 백테스트 ~$35) → 로컬 LLM(Ollama) 필수.

### 현재 상태

```
Ollama: 바이너리 설치됨 (v0.19.0, /opt/homebrew/bin/ollama)
서버: 미실행
모델: 미다운로드
하드웨어: Mac Studio M4 Max 14코어 36GB RAM
디스크: 291GB 여유
Chronos: 스켈레톤 121줄 (bots/investment/team/chronos.js)
```

---

## 작업 1: Ollama 서버 실행 + launchd 등록

### 1-1. Ollama 서버 시작 + 테스트

```bash
# 서버 시작 (백그라운드)
ollama serve &

# 서버 동작 확인
curl -s http://localhost:11434/api/version
# 기대: { "version": "0.19.0" }
```

### 1-2. 모델 다운로드

전략 문서 기반 + M4 Max 36GB 고려:

```bash
# Layer 2: 감성/뉴스 시뮬레이션 (가벼운 모델, 빠른 추론)
ollama pull qwen2.5:7b
# 약 4.7GB, M4 Max에서 ~40 tok/s

# Layer 3: 종합 판단 시뮬레이션 (무거운 모델, 정밀 추론)
ollama pull deepseek-r1:32b
# 약 19GB, M4 Max에서 ~15 tok/s

# 임베딩 (RAG 로컬 전환용, 선택사항)
# ollama pull nomic-embed-text
# 약 274MB — 필요 시 나중에
```

### 1-3. 모델 동작 확인

```bash
# qwen2.5:7b 테스트
ollama run qwen2.5:7b "BTC/USDT 현재 가격이 $67,000이고 RSI가 72일 때, 단기 전망을 한 문장으로 답해."
# 기대: 한국어 or 영어 답변 (내용은 중요하지 않음, 동작 확인)

# deepseek-r1:32b 테스트
ollama run deepseek-r1:32b "당신은 암호화폐 트레이딩 팀장입니다. BUY/SELL/HOLD 중 하나만 답하세요."
# 기대: BUY/SELL/HOLD 중 하나
```

### 1-4. launchd로 자동 실행 등록

Ollama가 OPS 재부팅 시 자동 시작되도록:

새 파일: `~/Library/LaunchAgents/ai.ollama.serve.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" 
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.ollama.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/ollama</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/ollama.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/ollama.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OLLAMA_HOST</key>
    <string>127.0.0.1:11434</string>
  </dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/ai.ollama.serve.plist
launchctl list | grep ollama
# 기대: PID  0  ai.ollama.serve
```

---

## 작업 2: Chronos Layer 1 — 규칙 엔진 + OHLCV 수집

### 설계 개요

```
Chronos 3계층 하이브리드 백테스팅:

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

### 새 테이블: `investment.ohlcv_cache`

```sql
CREATE TABLE IF NOT EXISTS investment.ohlcv_cache (
  symbol      TEXT NOT NULL,
  exchange    TEXT NOT NULL DEFAULT 'binance',
  timeframe   TEXT NOT NULL DEFAULT '5m',
  open_time   BIGINT NOT NULL,        -- Unix ms
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

### 새 파일: `bots/investment/shared/ohlcv-fetcher.js`

OHLCV 과거 데이터 수집 + PostgreSQL 저장:

```
역할:
  1. ccxt로 바이낸스 과거 OHLCV 수집 (5m/1h/1d)
  2. PostgreSQL ohlcv_cache 테이블에 저장
  3. 이미 있는 기간은 스킵 (중복 방지)
  4. CLI: node shared/ohlcv-fetcher.js --symbol=BTC/USDT --from=2025-01-01 --timeframe=5m

핵심 함수:
  fetchAndStore(symbol, timeframe, from, to)
    → ccxt.fetchOHLCV() 반복 호출 (1000개씩 페이징)
    → PostgreSQL UPSERT (ON CONFLICT DO NOTHING)
    → 진행률 로그 출력

  getOHLCV(symbol, timeframe, from, to)
    → DB에서 OHLCV 조회 (캐시 활용)
    → 없으면 자동 fetch

주의: ccxt 바이낸스 rate limit 준수 (1200 req/min)
```

### 새 파일: `bots/investment/shared/ta-indicators.js`

기술지표 계산 (순수 수학, LLM 없음):

```
역할:
  OHLCV 배열을 받아서 기술지표 계산
  외부 의존성 최소화 (ta-lib 대신 직접 구현 or technicalindicators npm)

함수:
  calcRSI(closes, period=14) → number[]
  calcMACD(closes, fast=12, slow=26, signal=9) → { macd, signal, histogram }[]
  calcBollingerBands(closes, period=20, stddev=2) → { upper, middle, lower }[]
  calcATR(highs, lows, closes, period=14) → number[]
  calcEMA(data, period) → number[]
  calcSMA(data, period) → number[]

의존성: technicalindicators npm 패키지 (순수 JS, 네이티브 불필요)
  npm install technicalindicators
```

### 수정 파일: `bots/investment/team/chronos.js`

기존 스켈레톤 121줄을 확장:

```
Layer 1 구현:
  1. ohlcv-fetcher로 기간 데이터 로드
  2. ta-indicators로 지표 계산
  3. 신호 필터링 규칙:
     - RSI > 70 or RSI < 30 → 과매수/과매도 신호
     - MACD 골든크로스/데드크로스
     - 볼린저밴드 상/하단 돌파
  4. 필터링된 신호 목록 반환 (Layer 2 입력)
  5. 기본 백테스트 엔진:
     - 신호 기반 가상 매매 실행
     - 수익률/MDD/샤프비율 계산
     - 결과 PostgreSQL 저장

```

---

## 작업 3: Chronos Layer 2~3 — Ollama LLM 시뮬레이션

### 새 파일: `bots/investment/shared/ollama-client.js`

로컬 Ollama HTTP API 클라이언트:

```
역할:
  Ollama REST API (localhost:11434) 호출 래퍼
  callOllama(model, prompt, options) → string
  
구현:
  POST http://localhost:11434/api/generate
  {
    "model": "qwen2.5:7b",
    "prompt": "...",
    "stream": false,
    "options": { "temperature": 0.3, "num_predict": 500 }
  }
  
  타임아웃: qwen2.5:7b → 30초, deepseek-r1:32b → 120초
  에러 시: null 반환 (백테스트 중단 방지)
  연결 확인: isOllamaAvailable() → boolean
```

### chronos.js Layer 2 확장

```
Layer 2 흐름:
  Layer 1에서 추출된 ~200개 신호 각각에 대해:
  
  1. 해당 시점의 과거 맥락 구성:
     - 최근 24시간 가격 변화율
     - RSI/MACD 현재값
     - 거래량 변화율
  
  2. Ollama qwen2.5:7b 호출 — 소피아(감성) 시뮬레이션:
     프롬프트: "당신은 암호화폐 감성 분석가입니다.
     다음 시장 데이터를 보고 시장 감성을 BULLISH/BEARISH/NEUTRAL로 판단하세요.
     [데이터: RSI=72, 24h변화=+3.2%, 거래량=1.5배 증가]
     JSON으로 답: { sentiment, confidence, reasoning }"
  
  3. Ollama qwen2.5:7b 호출 — 헤르메스(뉴스) 시뮬레이션:
     (과거 뉴스 데이터가 있으면 활용, 없으면 기술지표만)
  
  4. 결과를 Layer 3 입력에 추가
```

### chronos.js Layer 3 확장

```
Layer 3 흐름:
  Layer 2 결과(신호 + 감성 판단)에 대해:
  
  1. Ollama deepseek-r1:32b 호출 — 루나(팀장) 판단 시뮬레이션:
     프롬프트: "당신은 암호화폐 트레이딩 팀장입니다.
     다음 분석 결과를 종합하여 BUY/SELL/HOLD를 결정하세요.
     [기술분석: RSI=72, MACD=골든크로스, BB상단돌파]
     [감성분석: BULLISH (confidence 0.7)]
     [리스크: 현재 포지션 3개, 자본 사용률 45%]
     JSON으로 답: { action, confidence, reasoning }"
  
  2. 네메시스 리스크 규칙 적용 (LLM 불필요):
     - 최대 동시 포지션 초과 → HOLD
     - 일일 최대 손실 초과 → HOLD
     - 변동성 급등 → 포지션 사이즈 축소
  
  3. 최종 신호: BUY/SELL/HOLD + 사이즈
```

---

## 실행 순서 요약

```
OPS (맥 스튜디오):
  1. Ollama 서버 시작 + launchd 등록
  2. 모델 다운로드 (qwen2.5:7b + deepseek-r1:32b)
  3. 모델 동작 확인

DEV (맥북 에어):
  4. npm install technicalindicators
  5. ohlcv-fetcher.js 구현
  6. ta-indicators.js 구현
  7. ollama-client.js 구현
  8. chronos.js Layer 1~3 구현
  9. ohlcv_cache 테이블 마이그레이션
  10. git push → OPS 배포

OPS (맥 스튜디오):
  11. E2E 테스트: chronos.js --symbol=BTC/USDT --from=2026-01-01
```

---

## 완료 기준

### OPS (작업 1)

```bash
# Ollama 서버
curl -s http://localhost:11434/api/version
# 기대: { "version": "0.19.0" }

# 모델 목록
ollama list
# 기대: qwen2.5:7b, deepseek-r1:32b

# launchd
launchctl list | grep ollama
# 기대: PID  0  ai.ollama.serve
```

### DEV → OPS (작업 2~3)

```bash
# 문법 검사
node --check bots/investment/shared/ohlcv-fetcher.js
node --check bots/investment/shared/ta-indicators.js
node --check bots/investment/shared/ollama-client.js
node --check bots/investment/team/chronos.js

# OHLCV 수집 테스트
node bots/investment/shared/ohlcv-fetcher.js \
  --symbol=BTC/USDT --from=2026-03-01 --timeframe=1h
# 기대: ~720개 캔들 수집 + DB 저장

# Ollama 클라이언트 테스트
node -e "
const { callOllama, isOllamaAvailable } = require('./bots/investment/shared/ollama-client');
(async () => {
  console.log('available:', await isOllamaAvailable());
  const r = await callOllama('qwen2.5:7b', 'Say hello in one word');
  console.log('response:', r?.slice(0, 50));
})();
"

# Chronos Layer 1 백테스트
node bots/investment/team/chronos.js \
  --symbol=BTC/USDT --from=2026-03-01 --to=2026-03-30 --layer=1
# 기대: 신호 N개 추출 + 수익률/MDD/샤프 출력

# Chronos Layer 1~3 통합 백테스트
node bots/investment/team/chronos.js \
  --symbol=BTC/USDT --from=2026-03-01 --to=2026-03-30 --layer=3
# 기대: LLM 시뮬 포함 결과 (소요 ~10~30분)
```

---

## 커밋

```
OPS:
  feat(ops): Ollama launchd 서비스 등록 + qwen2.5:7b + deepseek-r1:32b

DEV:
  feat(luna): Chronos Layer 1~3 백테스팅 엔진

  - ohlcv-fetcher.js: ccxt 과거 OHLCV 수집 + PostgreSQL 캐시
  - ta-indicators.js: RSI/MACD/BB/ATR 기술지표 계산
  - ollama-client.js: 로컬 Ollama HTTP 클라이언트
  - chronos.js: 3계층 백테스팅 (규칙→감성LLM→판단LLM)
  - migration: ohlcv_cache 테이블
```
