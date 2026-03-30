# 루나팀 시스템 설계 (Phase 3-A v2.3)

## 개요

`bots/investment/`는 Phase 3-A에서 신규 구축된 루나팀 자동매매 시스템.
기존 `bots/invest/`(Phase 0)와 병렬 운영 — 안정화 후 기존 시스템 은퇴 예정.

---

## 운영 모드

### 용어 기준

- `executionMode`
  - `paper`: 실제 주문 차단
  - `live`: 실제 주문 실행
- `brokerAccountMode`
  - `mock`: 주식용 모의 계좌
  - `real`: 실계좌

### 조합 의미

| executionMode | brokerAccountMode | 설명 |
|------|------------------|------|
| `paper` | `mock` | 모의투자 계좌 연결, 실제 주문 차단 |
| `paper` | `real` | 실계좌 연결, 실제 주문 차단 |
| `live` | `mock` | 모의 계좌를 이용해 주문 실행 (현재는 주식만 해당) |
| `live` | `real` | 실제 투자 |

### 시장별 적용 원칙

- 암호화폐
  - `brokerAccountMode=real`만 사용
  - `executionMode=paper/live`만 운영상 판단 기준
- 국내/해외주식
  - `brokerAccountMode=mock/real` 모두 사용 가능

### 레거시 설정 매핑

- `PAPER_MODE` / `trading_mode`
  - `executionMode`를 결정하는 레거시 입력
- `kis_mode`
  - 주식 시장의 `brokerAccountMode`를 결정
- `kis.paper_trading`
  - deprecated 레거시 입력
- `binance_testnet`
  - 레거시 실험용 플래그
  - 현재 운영 기준의 `brokerAccountMode` 분류에는 사용하지 않음

---

## 현재 운영 상태 (2026-03-05)

| 서비스 | executionMode / brokerAccountMode | 상태 |
|-------|------|------|
| ai.investment.crypto (5분) | `live / real` | ✅ OPS |
| ai.investment.domestic (30분) | `live / mock` | ✅ OPS |
| ai.investment.overseas (30분) | `live / mock` | ✅ OPS |
| ai.investment.commander | bot_commands 폴링 | ✅ OPS |

---

## 디렉토리 구조

```
bots/investment/
├── team/               # 팀원 에이전트
│   ├── luna.js         # 오케스트레이터·최종 판단
│   ├── aria.js         # TA MTF 5m/1h/4h (규칙기반)
│   ├── oracle.js       # 온체인·매크로 (Groq)
│   ├── hermes.js       # 뉴스 3시장 (Groq + Naver + DART)
│   ├── sophia.js       # 감성 3시장 (Groq + xAI)
│   ├── zeus.js         # 강세 리서처 (OpenAI)
│   ├── athena.js       # 약세 리서처 (OpenAI)
│   ├── nemesis.js      # 리스크 평가 (OpenAI)
│   ├── hephaestos.js   # 바이낸스 실행 (LLM 없음)
│   ├── hanul.js        # KIS 실행 (국내+해외, LLM 없음)
│   ├── reporter.js     # 투자 리포트 (npm run report)
│   ├── chronos.js      # 백테스팅 (Skeleton)
│   └── argos.js        # 전략수집 (Groq — 루나 판단에 연결됨)
├── markets/            # 사이클 진입점
│   ├── crypto.js       # 암호화폐 5분 주기 launchd 트리거
│   ├── domestic.js     # 국내주식 30분 사이클 (KST 09:00~15:30)
│   └── overseas.js     # 미국주식 30분 사이클 (동절기 KST 23:30~06:00)
├── shared/             # 공용 모듈
│   ├── llm-client.js   # 통합 LLM (Groq + OpenAI, 토큰 DB 추적)
│   ├── db.js           # DuckDB 래퍼 (investment.duckdb)
│   ├── secrets.js      # 설정 로더 (장 시간 체크 포함)
│   ├── cost-tracker.js # 비용 추적 (JSON, Haiku 전용)
│   └── mainbot-client.js # 제이 큐 전송
├── scripts/            # CLI 유틸
│   └── trading-journal.js # 매매 일지 (npm run journal)
├── context/
│   ├── IDENTITY.md
│   ├── COMMANDER_IDENTITY.md
│   └── SYSTEM_DESIGN.md (이 파일)
├── db/                 # investment.duckdb 저장 위치
├── launchd/            # macOS 서비스 plist
├── package.json
└── config.yaml         # 실제 설정 (secrets.json fallback)
```

---

## LLM 정책 (v2.3 — 2026-03-04)

**전 모드 공통**: Groq llama-4-scout-17b (무료) / 성능 우선 에이전트 → OpenAI gpt-4o

| 에이전트 | 제공자 | 모델 |
|---------|-------|------|
| 루나·네메시스·오라클·아테나·제우스 | OpenAI | gpt-4o |
| 아르고스·헤르메스·소피아·기타 | Groq | llama-4-scout-17b (무료) |
| 아리아·헤파이스토스·한울 | 없음 | 규칙 기반 |

> **callLLM(agentName, system, user, maxTokens)** — shared/llm-client.js 자동 분기
> 모든 호출은 `claude-team.db token_usage` 테이블에 자동 기록 (토큰수·응답시간·비용)

---

## DB 스키마

### investment.duckdb

```sql
-- 분석가 결과
analyses (id, symbol, exchange, analyst, signal, confidence, reasoning, metadata, created_at)

-- 신호 (루나 최종 판단)
signals (id, symbol, exchange, action, amount_usdt, confidence, reasoning, status, trace_id, block_reason, block_code, block_meta, created_at)

-- 체결 내역
trades (id, signal_id, symbol, exchange, side, amount, price, total_usdt, paper, executed_at)

-- 현재 포지션
positions (symbol, exchange, amount, avg_price, unrealized_pnl, updated_at)

-- 자산 스냅샷 (사이클별)
asset_snapshots (id, exchange, usdt_balance, total_usdt_equiv, created_at)
```

### claude-team.db (SQLite, 공용)

```sql
-- LLM 사용 이력 (전 봇 공통)
token_usage (id, bot_name, team, model, provider, is_free, task_type,
             tokens_in, tokens_out, cost_usd, duration_ms, recorded_at, date_kst)
```

---

## 매매 일지 CLI

```bash
npm run journal          # 오늘 거래 내역 + 손익 + 토큰 사용
npm run journal:week     # 최근 7일
npm run journal:all      # 전체 이력
npm run journal:tg       # 텔레그램 전송
```

출력 내용:
- 거래 내역 (날짜별, 원화/달러 자동 구분)
- FIFO 방식 실현손익
- 미결 포지션 현황
- LLM 토큰 사용 (호출수·토큰수·응답시간·비용)

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
네메시스 LLM (gpt-4o)
  └── APPROVE / ADJUST / REJECT
```

---

## launchd 서비스

| 서비스 | 주기 | executionMode / brokerAccountMode | 상태 |
|-------|------|-----------|------|
| ai.investment.crypto | 5분 | `live / real` | ✅ OPS |
| ai.investment.domestic | KST 09:00~15:30 30분 | `live / mock` | ✅ OPS |
| ai.investment.overseas | KST 23:30~06:00 30분 | `live / mock` | ✅ OPS |
| ai.investment.commander | KeepAlive | - | ✅ OPS |

---

## 상태 파일 (~/.openclaw/investment-state.json)

```json
{
  "lastCycleAt": 1772680278215,
  "lastBtcPrice": 72561.8,
  "lastUsdtAlertAt": 1772680278216
}
```

**주의**: `saveState` 호출 시 반드시 `{ ...prev, ...updates }` spread 패턴 사용
(특정 필드만 저장 시 다른 필드 손실 버그 발생 — 2026-03-05 수정 완료)

---

## 주요 버그 수정 이력

| 날짜 | 버그 | 수정 |
|------|------|------|
| 2026-03-05 | USDT 잔고 알람 쿨다운 미작동 | updateState spread 패턴 적용 |
| 2026-03-05 | 포트폴리오 프롬프트 BTC/USDT 환각 | buildPortfolioPrompt 동적 생성 + 심볼 필터링 |
| 2026-03-05 | KIS 신호에 exchange='binance' 기록 | 덱스터 감지 추가 |

---

*최종 업데이트: Phase 3-A v2.3 (2026-03-05)*
