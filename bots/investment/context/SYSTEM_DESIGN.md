# 루나팀 시스템 설계 (Phase 3-A)

## 개요

`bots/investment/`는 Phase 3-A에서 신규 구축된 루나팀 자동매매 시스템.
기존 `bots/invest/`(Phase 0)와 병렬 운영 — 안정화 후 기존 시스템 은퇴 예정.

---

## 운영 모드

| 모드 | PAPER_MODE | 설명 |
|------|-----------|------|
| Phase 3-A | `true` | 신호 생성·DB·텔레그램만 (실주문 없음) |
| Phase 3-B | `true` | 국내·해외주식 파이프라인 추가 |
| Phase 3-C | `false` | 실주문 활성화 (사용자 최종 승인 후) |

---

## 디렉토리 구조

```
bots/investment/
├── team/               # 12명 에이전트
│   ├── luna.js         # 오케스트레이터·최종 판단 (Haiku)
│   ├── aria.js         # TA MTF 5m/1h/4h (규칙기반)
│   ├── oracle.js       # 온체인·매크로 (Cerebras→Groq)
│   ├── hermes.js       # 뉴스 3시장 (Groq + Naver + DART)
│   ├── sophia.js       # 감성 3시장 (SambaNova→Groq + xAI)
│   ├── zeus.js         # 강세 리서처 (Haiku)
│   ├── athena.js       # 약세 리서처 (Haiku)
│   ├── nemesis.js      # 리스크 평가 (Haiku)
│   ├── hephaestos.js   # 바이낸스 실행 (LLM 없음)
│   ├── hanul.js        # KIS 실행 (국내+해외, LLM 없음)
│   ├── chronos.js      # 백테스팅 (Skeleton)
│   └── argos.js        # 전략수집 (Skeleton)
├── markets/            # 사이클 진입점
│   ├── crypto.js       # 암호화폐 5분 사이클
│   ├── domestic.js     # 국내주식 30분 사이클 (Skeleton)
│   └── overseas.js     # 미국주식 30분 사이클 (Skeleton)
├── shared/             # 공용 모듈
│   ├── llm.js          # 통합 LLM (groq+cerebras+sambanova+xai+anthropic)
│   ├── db.js           # DuckDB 래퍼 (investment.duckdb)
│   ├── signal.js       # 신호 상수 (ACTIONS, ANALYST_TYPES)
│   ├── secrets.js      # 설정 로더 (PAPER_MODE 포함)
│   └── report.js       # 텔레그램 포매터
├── context/
│   ├── IDENTITY.md     # 팀원 정체성
│   └── SYSTEM_DESIGN.md (이 파일)
├── db/                 # investment.duckdb 저장 위치
├── launchd/            # macOS 서비스 plist
├── package.json
└── secrets.json        # 실제 키 (gitignore)
```

---

## LLM 정책

| 에이전트 | 제공자 | 모델 | 이유 |
|---------|-------|------|------|
| 루나 (오케스트레이터) | Anthropic | claude-haiku-4-5 | 포트폴리오 판단 품질 |
| 제우스·아테나 (리서처) | Anthropic | claude-haiku-4-5 | 투자 리서치 품질 |
| 네메시스 (리스크) | Anthropic | claude-haiku-4-5 | 리스크 판단 정확성 |
| 오라클 (온체인) | Cerebras → Groq | llama-3.1-8b | 빠른 수치 해석 |
| 헤르메스 (뉴스) | Groq | llama-3.1-8b-instant | 최고속 텍스트 분류 |
| 소피아 (감성) | SambaNova → Groq | llama-3.3-70b | 감성 분류 정확성 |
| 아리아·헤파이스토스·한울 | 없음 | — | 규칙 기반 충분 |

---

## 데이터 소스

### 암호화폐 (5분 사이클)

| 소스 | 에이전트 | 주기 |
|------|---------|------|
| Binance OHLCV (CCXT) | 아리아 | 5분 |
| Alternative.me F&G | 오라클 | 5분 |
| Binance Futures (funding/LS/OI) | 오라클 | 5분 |
| CoinDesk·CoinTelegraph RSS | 헤르메스 | 5분 |
| CoinMarketCap 뉴스 RSS | 헤르메스 | 5분 |
| Reddit r/CryptoCurrency 등 | 소피아 | 5분 |
| DCInside 비트코인갤 | 소피아 | 5분 |
| CryptoPanic API | 소피아 | 5분 |

### 미국주식 (30분 사이클, Phase 3-B)

| 소스 | 에이전트 | 주기 |
|------|---------|------|
| KIS OHLCV (해외) | 아리아 | 30분 |
| Yahoo Finance RSS | 헤르메스 | 30분 |
| MarketWatch RSS | 헤르메스 | 30분 |
| Reddit (r/stocks·r/investing·r/wallstreetbets) | 소피아 | 30분 |
| Alpha Vantage 뉴스감성 | 소피아 | 30분 |

### 국내주식 (30분 사이클, Phase 3-B)

| 소스 | 에이전트 | 주기 |
|------|---------|------|
| KIS OHLCV (국내) | 아리아 | 30분 |
| 네이버 뉴스 API | 헤르메스 | 30분 |
| DART OpenDart 공시 | 헤르메스 | 30분 |
| 네이버 증권 종목토론실 | 소피아 | 30분 |

---

## xAI 결정 (2026-03-02)

- X 데이터 공유 프로그램 종료 (2025년 5월), 학생 할인 없음
- X Search 비용 월 $24~46 — 제거 결정
- xAI API 키는 보관 (추후 필요 시 callOpenAICompat 직접 호출 가능)
- X 트렌드 전략은 아르고스(6시간 주기)가 수집 → 실시간 아님, 전략 참조용

---

## DB 스키마 (investment.duckdb)

```sql
-- 분석가 결과
analyses (id, symbol, exchange, analyst, signal, confidence, reasoning, metadata, created_at)

-- 신호 (루나 최종 판단)
signals (id, symbol, exchange, action, amount_usdt, confidence, reasoning, status, paper, created_at)

-- 체결 내역
trades (id, signal_id, symbol, exchange, side, amount, price, total_usdt, paper, created_at)

-- 현재 포지션
positions (symbol, exchange, amount, avg_price, unrealized_pnl, updated_at)
```

---

## 리스크 관리 레이어

```
루나 포트폴리오 제약
  └── 단일 포지션 ≤ 20% / 동시 포지션 ≤ 5개 / 일손실 ≤ 5%
      ↓
네메시스 v1 하드 규칙
  └── 최소 $10 / 최대 $1000 / 일일 손실 한도
      ↓
네메시스 v2 조정 계수
  └── ATR 변동성 × 상관관계 × 시간대(KST 01~07: 0.5)
      ↓
네메시스 LLM (Haiku)
  └── APPROVE / ADJUST / REJECT
```

---

## launchd 서비스

| 서비스 | 파일 | 주기 | 상태 |
|-------|------|------|------|
| ai.investment.crypto | `launchd/ai.investment.crypto.plist` | 5분 | Phase 3-A |
| ai.investment.domestic | (추후) | 30분 | Phase 3-B |
| ai.investment.overseas | (추후) | 30분 | Phase 3-B |

---

## 신규 API 키 (secrets.json)

```json
{
  "xai_api_key": "",              // grok-3-mini-fast x_search — 없으면 Groq fallback
  "naver_client_id": "",          // 네이버 뉴스 API — 없으면 RSS fallback
  "naver_client_secret": "",
  "dart_api_key": "",             // DART 공시 API — 없으면 스킵
  "cryptopanic_api_key": "",      // CryptoPanic — 없으면 스킵
  "alpha_vantage_api_key": "",    // Alpha Vantage — 없으면 스킵
  "paper_mode": true,
  "binance_symbols": ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT"],
  "kis_symbols": ["005930", "000660"],
  "kis_overseas_symbols": ["AAPL", "TSLA", "NVDA"]
}
```

---

## Phase 로드맵

| Phase | 내용 | 상태 |
|-------|------|------|
| 3-A | 암호화폐 5분 사이클 (PAPER_MODE) | **현재** |
| 3-B | 국내·해외주식 30분 사이클 추가 | 다음 |
| 3-C | 실주문 활성화 (사용자 최종 승인) | 추후 |
| 3-D | 크로노스 백테스팅 (DeepSeek) | 추후 |
| 3-E | 아르고스 전략 수집 | 추후 |

---

*최종 업데이트: Phase 3-A (2026-03-02)*
