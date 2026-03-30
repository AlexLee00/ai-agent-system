# CODEX_CHRONOS_PHASE_A_DEV — Chronos Layer 1~3 백테스팅 엔진

> 실행 대상: 코덱스 (코드 구현)
> 환경: **맥북 에어 (DEV)** → git push → OPS 배포
> 작성일: 2026-03-30 (v2 — MLX 기반)
> 작성자: 메티 (전략+설계)

---

## 사전 조건

⚠️ **OPS 프롬프트(`CODEX_CHRONOS_PHASE_A_OPS.md`)가 먼저 완료되어야 함.**

OPS에서 완료된 항목:
- Ollama 제거 완료
- MLX + mlx-lm + mlx-openai-server 설치
- qwen2.5-7b + deepseek-r1-32b 모델 다운로드
- MLX 서버 launchd 등록 (포트 11434, OpenAI 호환 API)
- DEV에서 Tailscale 경유 접근 확인 (REDACTED_TAILSCALE_IP:11434)

---

## 설계 개요: Chronos 3계층 하이브리드 백테스팅

```
Layer 1 — 규칙 엔진 (LLM 없음, 초고속)
  ccxt로 과거 OHLCV 수집 → PostgreSQL 저장
  기술지표 계산: RSI, MACD, 볼린저밴드, ATR
  1차 필터링: 수천 개 캔들 → 유의미 신호 ~200개 추출
  비용: $0 / 속도: 수 초

Layer 2 — MLX qwen2.5-7b (감성 시뮬레이션)
  Layer 1 추출 ~200개 신호에만 적용
  소피아(감성) + 헤르메스(뉴스) 역할 시뮬레이션
  비용: $0 / 속도: 신호당 2~3초

Layer 3 — MLX deepseek-r1-32b (판단 시뮬레이션)
  Layer 2 통과 신호에 대해
  루나(종합판단) + 네메시스(리스크) 역할 시뮬레이션
  비용: $0 / 속도: ~30분
```

---

## 작업 1~3: 기존과 동일

### 작업 1: ohlcv_cache 테이블 마이그레이션
새 파일: `bots/investment/migrations/ohlcv-cache.sql` — investment.ohlcv_cache 테이블

### 작업 2: OHLCV 수집기
새 파일: `bots/investment/shared/ohlcv-fetcher.js`
- ccxt.fetchOHLCV() → PostgreSQL UPSERT
- getOHLCV(symbol, timeframe, from, to) — DB 캐시 우선
- CLI: `node shared/ohlcv-fetcher.js --symbol=BTC/USDT --from=2025-01-01 --timeframe=5m`

### 작업 3: 기술지표 계산기
새 파일: `bots/investment/shared/ta-indicators.js`
- 의존성: `npm install technicalindicators`
- calcRSI, calcMACD, calcBollingerBands, calcATR, calcEMA, calcSMA
- 기존 aria.js 읽고 중복 방지

---

## 작업 4: 로컬 LLM 클라이언트 (공용 계층, OpenAI 호환)

새 파일: `packages/core/lib/local-llm-client.js`

⚠️ 루나팀 전용이 아닌 **공용 계층** (hub-client.js와 동일 레벨)
⚠️ Tailscale 직접 접근 (Hub 경유 안 함 — 장시간 응답이므로)

**핵심: OpenAI 호환 /v1/chat/completions API → 백엔드 MLX/Ollama 교체 가능**

```
환경변수:
  LOCAL_LLM_BASE_URL
    MODE=ops → http://localhost:11434
    MODE=dev → http://REDACTED_TAILSCALE_IP:11434 (Tailscale)

모델 상수:
  LOCAL_MODEL_FAST = 'qwen2.5-7b'
  LOCAL_MODEL_DEEP = 'deepseek-r1-32b'

함수:
  isLocalLLMAvailable() → boolean
    GET ${LOCAL_LLM_BASE_URL}/v1/models | 타임아웃 3초

  callLocalLLM(model, messages, options={}) → string|null
    POST ${LOCAL_LLM_BASE_URL}/v1/chat/completions
    body: { model, messages, max_tokens, temperature }
    타임아웃: FAST→30초, DEEP→120초
    에러 시: null 반환

  callLocalLLMJSON(model, messages, options={}) → object|null
    callLocalLLM → JSON.parse | 실패 시 null

  getAvailableModels() → string[]
    GET ${LOCAL_LLM_BASE_URL}/v1/models

패턴: hub-client.js와 동일 (AbortController + 타임아웃 + null)
```

### env.js 수정

```
packages/core/lib/env.js에 추가:
  LOCAL_LLM_BASE_URL:
    MODE=ops → 'http://localhost:11434'
    MODE=dev → 'http://REDACTED_TAILSCALE_IP:11434'
```

---

## 작업 5: Chronos Layer 1~3 구현

수정 파일: `bots/investment/team/chronos.js` (스켈레톤 121줄 → 확장)

### Layer 1: 규칙 엔진
```
ohlcv-fetcher.getOHLCV() → ta-indicators 지표 계산 → 신호 필터링
필터 규칙: RSI>70/RSI<30, MACD 크로스, BB 돌파
→ 필터링된 신호 목록 (Layer 2 입력)
→ 기본 백테스트: 가상 매매 → 수익률/MDD/샤프
```

### Layer 2: MLX 감성 시뮬
```
Layer 1 신호 각각에 대해:
  callLocalLLM(LOCAL_MODEL_FAST, [
    { role: "system", content: "암호화폐 감성 분석가. JSON 답: {sentiment,confidence,reasoning}" },
    { role: "user", content: "RSI=72, 24h변화=+3.2%, 거래량=1.5배" }
  ])
```

### Layer 3: MLX 판단 시뮬
```
Layer 2 결과에 대해:
  callLocalLLM(LOCAL_MODEL_DEEP, [
    { role: "system", content: "트레이딩 팀장. JSON 답: {action,confidence,reasoning}" },
    { role: "user", content: "기술:RSI=72 감성:BULLISH(0.7) 리스크:포지션3개" }
  ])
→ 네메시스 규칙 적용 (LLM 불필요)
→ 최종: BUY/SELL/HOLD + 사이즈
```

### CLI
```
node team/chronos.js --symbol=BTC/USDT --from=2026-01-01 --to=2026-03-30 --layer=1
node team/chronos.js --symbol=BTC/USDT --from=2026-01-01 --to=2026-03-30 --layer=3
```

---

## 완료 기준

```bash
# 1. 의존성
npm install technicalindicators

# 2. 문법 검사
node --check bots/investment/shared/ohlcv-fetcher.js
node --check bots/investment/shared/ta-indicators.js
node --check packages/core/lib/local-llm-client.js
node --check bots/investment/team/chronos.js

# 3. 커밋
git add -A
git commit -m "feat(luna): Chronos Layer 1~3 + local-llm-client (MLX)

- ohlcv-fetcher.js: ccxt OHLCV 수집 + PostgreSQL 캐시
- ta-indicators.js: RSI/MACD/BB/ATR 기술지표
- local-llm-client.js: OpenAI 호환 로컬 LLM 클라이언트 (공용)
- chronos.js: 3계층 백테스팅 (규칙→감성MLX→판단MLX)
- env.js: LOCAL_LLM_BASE_URL 추가"
git push origin main

# 4. OPS 배포 후 테스트
node bots/investment/shared/ohlcv-fetcher.js \
  --symbol=BTC/USDT --from=2026-03-01 --timeframe=1h

node -e "
const { isLocalLLMAvailable, callLocalLLM, LOCAL_MODEL_FAST } = require('./packages/core/lib/local-llm-client');
(async () => {
  console.log('available:', await isLocalLLMAvailable());
  const r = await callLocalLLM(LOCAL_MODEL_FAST, [{role:'user',content:'1+1=?'}]);
  console.log('response:', r?.slice(0, 50));
})();
"

node bots/investment/team/chronos.js \
  --symbol=BTC/USDT --from=2026-03-01 --to=2026-03-30 --layer=1

node bots/investment/team/chronos.js \
  --symbol=BTC/USDT --from=2026-03-01 --to=2026-03-30 --layer=3
```
