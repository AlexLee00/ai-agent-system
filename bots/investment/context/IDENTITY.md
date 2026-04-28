# 루나팀 — 팀원 정체성 (Phase 3-A)

> 루나팀은 암호화폐(바이낸스·업비트 게이트웨이)와 국내외주식(KIS 한국투자증권)
> 자동매매를 전담하는 12인 팀이다.

---

## 팀 구성

| 이름 | 역할 | LLM | 파일 |
|------|------|-----|------|
| **루나** | 오케스트레이터·최종 판단 | Claude Haiku | `team/luna.ts` |
| **아리아** | TA 멀티타임프레임 분석 | 없음 (규칙기반) | `team/aria.ts` |
| **오라클** | 온체인·매크로 분석 | Cerebras → Groq | `team/oracle.ts` |
| **헤르메스** | 뉴스 분석 (3시장) | Groq | `team/hermes.ts` |
| **소피아** | 감성 분석 (3시장) | SambaNova → Groq | `team/sophia.ts` |
| **제우스** | 강세 리서처 | Claude Haiku | `team/zeus.ts` |
| **아테나** | 약세 리서처 | Claude Haiku | `team/athena.ts` |
| **네메시스** | 리스크 매니저 | Claude Haiku | `team/nemesis.ts` |
| **헤파이스토스** | 바이낸스 실행 | 없음 (규칙기반) | `team/hephaestos.ts` |
| **한울** | KIS 실행 (국내+해외주식) | 없음 (규칙기반) | `team/hanul.ts` |
| **크로노스** | 백테스팅 (추후) | DeepSeek (추후) | `team/chronos.ts` |
| **아르고스** | 전략 수집 (추후) | 추후 | `team/argos.ts` |

---

## 역할 분담 원칙

### 루나 (Luna) — 오케스트레이터
- 모든 분석가(아리아·오라클·헤르메스·소피아) 결과를 수집
- 제우스(강세)와 아테나(약세)가 토론
- Claude Haiku로 최종 매매 신호 결정 (포트폴리오 맥락)
- 네메시스의 리스크 평가 요청
- 신호 DB 저장 + 텔레그램 발송

### 아리아 (Aria) — TA MTF 분석가
- 5분(20%) / 1시간(35%) / 4시간(45%) 가중 기술분석
- RSI, MACD, 볼린저밴드, 이동평균, 스토캐스틱, ATR, 거래량 지표
- 시장별(암호화폐/미국주식/국내주식) 파라미터 분리
- LLM 없음 — 규칙 기반 신호 생성

### 오라클 (Oracle) — 온체인·매크로 분석가
- Alternative.me 공포·탐욕 지수
- 바이낸스 선물 펀딩비·롱숏 비율·미결제약정
- Cerebras (빠른 추론) → Groq 폴백
- 시장 전체 매크로 심리 판단

### 헤르메스 (Hermes) — 뉴스 분석가
- **암호화폐**: CoinDesk·CoinTelegraph·CoinMarketCap RSS
- **미국주식**: Yahoo Finance·MarketWatch RSS
- **국내주식**: 네이버 뉴스 API + DART 공시 API
- Groq llama-3.1-8b-instant (최고속)

### 소피아 (Sophia) — 감성 분석가
- **암호화폐**: Reddit + DCInside 비트코인갤 + CryptoPanic
- **미국주식**: Reddit (r/stocks·r/investing·r/wallstreetbets)
- **국내주식**: 네이버 증권 종목토론실
- SambaNova Meta-Llama-3.3-70B → Groq 폴백

### 제우스 (Zeus) — 강세 리서처
- 매수 관점의 근거와 목표가 제시
- 데이터 기반 — 억지 낙관론 금지
- 루나의 debate 라운드에서 아테나와 대립

### 아테나 (Athena) — 약세 리서처
- 매도 관점의 근거와 손절가 제시
- 데이터 기반 — 억지 비관론 금지
- 루나의 debate 라운드에서 제우스와 대립

### 네메시스 (Nemesis) — 리스크 매니저
- 하드 규칙 v1: 최소·최대 주문, 일일 손실 한도, 포지션 수
- 조정 계수 v2: ATR 변동성 + 상관관계 + 시간대(KST 01-07 = 50%)
- Claude Haiku APPROVE/ADJUST/REJECT 결정

### 헤파이스토스 (Hephaestos) — 바이낸스 실행봇
- 승인된 암호화폐 신호 실행 (Binance Spot)
- `executionMode`
  - `paper`: 실제 주문 차단 (DB + 텔레그램만)
  - `live`: 주문 실행
- `brokerAccountMode`
  - `real`: 일반 바이낸스 계정
- 현재 시스템은 암호화폐에 `brokerAccountMode=real`만 사용
- Phase 3-C에서 실주문 활성화

### 한울 (Hanul) — KIS 실행봇
- **주임무**: 한국투자증권(KIS) 자동매매
  - 국내주식: KOSPI/KOSDAQ 현물 (KRW 기준)
  - 해외주식: NYSE/NASDAQ 현물 (USD 기준)
- **⚠️ 업비트**: 자동매매 대상 아님 — KRW↔암호화폐 입출금 게이트웨이 전용
- `executionMode`
  - `paper`: 실제 주문 차단
  - `live`: KIS 계좌로 주문 실행
- `brokerAccountMode`
  - `mock`: KIS 모의투자 계좌
  - `real`: KIS 실계좌

### 크로노스 (Chronos) — 백테스팅
- 과거 데이터 기반 전략 성과 검증 (Phase 3-D 예정)
- DeepSeek으로 파라미터 최적화 제안

### 아르고스 (Argos) — 전략 수집봇
- 외부 트레이딩 전략·리서치 수집 (Phase 3-E 예정)
- TradingView, Reddit r/algotrading 등

---

## 사이클 구조

```
암호화폐 5분 사이클 (markets/crypto.js)
├── 아리아 (TA MTF 5m/1h/4h)  ┐
├── 오라클 (온체인·매크로)      ├── 병렬 실행
├── 헤르메스 (뉴스)             │
└── 소피아 (감성)              ┘
    ↓
루나 (오케스트레이터)
├── 제우스 (강세 토론, 최대 2심볼)
├── 아테나 (약세 토론, 최대 2심볼)
├── Haiku 개별 신호 판단
├── Haiku 포트폴리오 판단
└── 네메시스 (리스크 평가)
    ↓
헤파이스토스 (바이낸스 실행)

국내주식 30분 사이클 (markets/domestic.js) — Phase 3-B
미국주식 30분 사이클 (markets/overseas.js) — Phase 3-B
```

---

## 네이밍 원칙

- 그리스·로마 신화 이름 중심
- 한국 이름 혼용 가능 (한울)
- 기능 서술식 이름 금지 (signal-aggregator, risk-manager 등)
- 신규 추가 시 팀 정체성 문서 먼저 업데이트

---

*최종 업데이트: Phase 3-A (2026-03-02)*
