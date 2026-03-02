# 🤖 멀티 에이전트 AI 봇 시스템 설계서

> 최초 작성: 2026년 2월 22일
> 최종 업데이트: 2026년 2월 27일
> 목적: 맥미니 M4 Pro 기반 로컬 AI 멀티 에이전트 시스템 구축

---

## 1. 시스템 개요

### 핵심 철학

> 사용자는 **메인봇(팀장)에게만 지시**하고, 메인봇이 담당 서브봇에게 위임한 뒤 결과를 취합해 보고한다.
> 긴급 알림(거래 체결·예약 오류)은 서브봇이 텔레그램으로 직접 발송한다.

### 전체 구조도

```
👤 사용자 (텔레그램 단일 채널)
    │
    ▼ 모든 지시 → 메인봇으로
┌──────────────────────────────────────────────┐
│  🧠 메인봇 (오케스트레이터)                    │
│  claude-sonnet-4-6                           │
│  - 의도 파악 → 담당 봇 위임                   │
│  - 크로스봇 조율 (스카+주식 연계 등)           │
│  - 최종 응답 포맷 & 전달                      │
└──────┬──────────────┬──────────────┬─────────┘
       │              │              │
       ▼              ▼              ▼
┌─────────────┐ ┌───────────┐ ┌──────────────────┐
│ 📅 스카봇   │ │ 💹 투자팀  │ │ (Phase 3~4)      │
│ 예약관리     │ │ 메인봇    │ │ 비서봇/업무봇     │
│ qwen2.5:7b  │ │ sonnet-4-6│ │ 학술봇/판례봇    │
└─────────────┘ └─────┬─────┘ └──────────────────┘
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
  ┌─────────────┐ ┌──────────┐ ┌──────────────┐
  │ ⚡ 바이낸스  │ │ 🔍 리서치│ │ 📚 백테스팅  │
  │  실행봇      │ │   봇     │ │   엔진       │
  │ (LLM 없음) │ │  gemini  │ │  deepseek    │
  │ Binance API │ │  -flash  │ │  -r1:32b     │
  └─────────────┘ └──────────┘ └──────────────┘
```

---

## 2. 하드웨어 구성

| 항목   | 사양              |
|------|-----------------|
| 기기   | Mac Mini M4 Pro |
| CPU  | 12코어            |
| GPU  | 16코어            |
| 메모리  | 64GB 통합 메모리     |
| 저장장치 | 1TB SSD         |
| 운영체제 | macOS Sequoia   |

### 기기 운용 방식

| 기기         | 역할                   | 상태       |
|------------|----------------------|----------|
| 🖥️ 맥미니    | AI 봇 서버 24시간 운용 (집 고정) | ⏳ 구매 예정  |
| 💻 맥북 에어 M3 | 이동형 / Claude Code CLI | ✅ 현재 사용 중 |
| 📱 아이패드   | Termius SSH + Tailscale 외부 원격 | ✅ **설정 완료** |
| 📱 핸드폰    | 텔레그램 봇으로 알림 및 명령    | ✅ 연결 완료  |

### 원격 접속 구성 (2026-02-27 완료)

| 방식 | 접속 정보 | 상태 |
|------|---------|------|
| 로컬 SSH | `192.168.45.176:22` | ✅ |
| 외부 SSH (Tailscale) | `100.124.124.65:22` | ✅ |
| 계정 | `alexlee` / ED25519 키 인증 | ✅ |

```bash
# 아이패드에서 바로 실행
ska       # → cd reservation 디렉토리 + npx claude
skalog    # → tail -f /tmp/naver-ops-mode.log
skastatus # → launchctl list | grep ai.ska
```

---

## 3. 소프트웨어 스택

| 구성요소            | 도구              | 역할                     | 상태        |
|-----------------|-----------------|------------------------|-----------|
| LLM 엔진          | Ollama          | 로컬 LLM 모델 실행            | ⏳ 맥미니 후   |
| AI 에이전트 게이트웨이   | OpenClaw        | 멀티채널 AI 에이전트 허브         | ✅ 운영 중    |
| 봇 프레임워크         | n8n             | 멀티 에이전트 워크플로우 관리        | ⏳ 맥미니 후   |
| 원격 접속           | Tailscale       | 외부에서 봇 접속 (100.124.124.65) | ✅ **완료** |
| 브라우저 자동화        | Playwright      | 네이버 스마트플레이스 / 픽코 자동화    | ✅ OPS 운영 중 |
| 핸드폰 알림          | 텔레그램 봇          | 예약 알림 및 명령 수신           | ✅ 연결 완료   |
| 지식 베이스          | RAG (ChromaDB)  | 예약 이력 저장 + 질의응답         | ✅ 운영 중    |
| DB              | SQLite (state.db) | 예약·매출·블록 데이터 영구 저장    | ✅ 운영 중    |
| 컨텍스트 관리         | deploy-context.js | 봇 기억 배포 + 역동기화        | ✅ 운영 중    |
| 자동 백업           | launchd         | 자정 컨텍스트 자동 보존 (git commit) | ✅ 운영 중    |

---

## 4. 봇별 LLM 모델 구성 (2026-02-28 업데이트)

> 기준: Mac Mini M4 Pro 12코어 64GB / 월 API 비용 목표 ~$16.5

### 📊 전체 요약

| 봇 | 역할 | Primary LLM | Fallback | 예상 월비용 | 실행위치 |
|----|------|-------------|----------|-----------|---------|
| 🧠 메인봇 | 오케스트레이터 | `claude-sonnet-4-6` | `kimi-k2p5` | ~$8 | API |
| 📅 스카봇 | 예약관리 자동화 | `ollama/qwen2.5:7b` | `gemini-2.0-flash` | $0 | 로컬 |
| 🗓️ 비서봇 | 일정·캘린더 관리 | `gemini-2.0-flash` | `ollama/qwen2.5:7b` | ~$1 | API |
| 💼 업무봇 | 문서·이메일 처리 | `kimi-k2p5` | `claude-sonnet-4-6` | ~$5 | API |
| 📚 학술봇 | 논문 리서치·KCI | `ollama/deepseek-r1:32b` | `claude-opus-4-6` | $0 | 로컬 |
| ⚖️ 판례봇 | 법률 판례 분석 | `ollama/deepseek-r1:32b` | `kimi-k2p5` | $0 | 로컬 |
| 💹 투자 메인봇 | 매매 의사결정·조율 | `claude-sonnet-4-6` | `gemini-2.0-flash` | (메인봇 공유) | API |
| 📊 기술분석가 | TA 지표 분석 | `groq/llama-3.3-70b-versatile` | `gemini-2.0-flash` | $0 (무료) | API |
| 🌐 감성분석가 | 커뮤니티 감성 | `gemini-2.0-flash` | `groq/llama-4-scout-17b` | $0 (무료 OAuth) | API |
| ⛓️ 온체인분석가 | 온체인·매크로 | `groq/llama-3.1-8b-instant` | `gemini-2.0-flash` | $0 (무료) | API |
| 📰 뉴스분석가 | 뉴스·이벤트 | `groq/llama-3.1-8b-instant` | `gemini-2.0-flash` | $0 (무료) | API |
| 🐂 강세 리서처 | 매수 근거 도출 | `claude-haiku-4-5-20251001` | `groq/llama-4-scout-17b` | ~$0.3 | API |
| 🐻 약세 리서처 | 리스크 근거 도출 | `claude-haiku-4-5-20251001` | `groq/llama-4-scout-17b` | ~$0.2 | API |
| ⚖️ 리스크 매니저 | 포지션·손실 검토 | `claude-haiku-4-5-20251001` | `groq/llama-3.3-70b-versatile` | $0 (무료 한도내) | API |
| ⚡ 바이낸스 실행봇 | USDT 마켓 주문 | LLM 없음 (규칙 기반) | — | $0 | 로컬 |
| 🇰🇷 업비트 실행봇 | KRW 마켓 주문 | LLM 없음 (규칙 기반) | — | $0 | 로컬 |
| 📚 백테스팅 엔진 | 전략 최적화 | `ollama/deepseek-r1:32b` | — | $0 | 로컬 |

**총 예상 월비용: ~$16.5**

### 모델 선택 근거

| 원칙 | 모델 | 대상 봇 |
|------|------|---------|
| 복잡한 판단·조율 | `claude-sonnet-4-6` | 메인봇, 투자 메인봇 |
| 빠른 데이터 분석 (무료, 200ms) | `groq/llama-3.1-8b-instant` | 온체인·뉴스 분석가 |
| 빠른 추론 (무료, 225ms) | `groq/llama-3.3-70b-versatile` | 기술분석가 |
| Google 서비스 연동 + 고속 | `gemini-2.0-flash` | 비서봇, 감성분석가 |
| 추론 품질 + 저비용 | `claude-haiku-4-5-20251001` | 리서처, 리스크 매니저 |
| 긴 문서·컨텍스트 (2M 토큰) | `kimi-k2p5` | 업무봇, 판례봇 Fallback |
| 학술·추론 집약 (무료 로컬) | `deepseek-r1:32b` | 학술봇, 판례봇, 백테스팅 |
| 반복·단순 파싱 (무료 로컬) | `qwen2.5:7b` | 스카봇 (24/7 상주) |

### Groq 무료 한도 분석 (5분 주기 운영 기준)

| 모델 | 무료 한도 | 일 소비량 (5분 주기) | 잔여율 | 전략 |
|------|---------|-----------------|--------|------|
| `llama-3.1-8b-instant` | 14,400 RPD / 500K TPD | 288 calls (온체인) + 288 calls (뉴스) = **576** | **96% 남음** | 단일 계정 충분 |
| `llama-3.3-70b-versatile` | 1,000 RPD / 100K TPD | 288 calls (기술분석) | **71% 남음** | 단일 계정 충분 |
| `llama-4-scout-17b` | 1,000 RPD / 500K TPD | Fallback용 (미사용 시 0) | — | 예비 계정 |
| **리스크 완화** | — | Groq 계정 2~3개 라운드로빈 → 한도 2~3배 확장 | — | 멀티계정 전략 |

---

## 5. 봇 구성 상세

### 5-1. 📅 스카봇 (예약관리봇) ✅ OPS 실운영 중

| 항목 | 내용 |
|------|------|
| Primary LLM | `ollama/qwen2.5:7b` (로컬, 무료) |
| Fallback | `gemini-2.0-flash` |
| 채널 | 텔레그램 (@SCAFE8282_BOT) |
| 상태 | **OPS 모드 실운영 중** (launchd KeepAlive) |
| 파싱 도구 | Playwright (헤드리스, PICKKO_HEADLESS=1) |
| 대상 플랫폼 | 네이버 스마트플레이스 → 픽코 키오스크 |

**시스템 흐름**

```
[네이버 스마트플레이스]
        ↓ 신규 예약 감지 (5분 주기)
[naver-monitor.js] ← OPS 모드
        ↓ sendAlert() → SQLite state.db
        ↓ runPickko() 자동 호출
[pickko-accurate.js] ← Stage [1-9] 자동 실행
        ↓
[픽코 키오스크] ← 예약 + 0원 현금 결제 완료
        ↓ Heartbeat (30분)
[Telegram] ← 사장님에게 결과 알람
```

**핵심 파일**

| 파일 | 역할 | 상태 |
|------|------|------|
| `src/naver-monitor.js` | 네이버 모니터링 + 픽코 트리거 | ✅ OPS |
| `src/pickko-accurate.js` | 픽코 자동 예약 Stage [1-9] | ✅ |
| `src/pickko-kiosk-monitor.js` | 키오스크 예약 감지 → 네이버 차단/해제 | ✅ |
| `src/start-ops.sh` | OPS 자동 재시작 루프 | ✅ launchd |
| `lib/db.js` | SQLite 4테이블 (예약/매출/블록/알림) | ✅ |
| `lib/pickko-stats.js` | 일별 매출 분리 (스터디카페/스터디룸) | ✅ |
| `scripts/pickko-revenue-backfill.js` | 매출 이력 일괄 채우기 + CSV 생성 | ✅ |

---

### 5-2. 🧠 메인봇 (오케스트레이터)

| 항목 | 내용 |
|------|------|
| Primary LLM | `claude-sonnet-4-6` |
| Fallback | `kimi-k2p5` |
| 상태 | ⏳ Phase 3 구축 예정 |
| 역할 | 의도 파악 → 담당 봇 위임 → 결과 취합 |

**라우팅 흐름**

```
사용자 메시지
    ↓
메인봇 (claude-sonnet-4-6) 의도 분류
    ├── 예약/스카/픽코 관련    → 스카봇 위임
    ├── 투자/주식/코인 관련    → 투자 메인봇 위임
    ├── 일정/캘린더 관련       → 비서봇 위임 (Phase 3)
    ├── 문서/이메일 관련       → 업무봇 위임 (Phase 3)
    └── 일반 질문              → 메인봇 직접 처리
```

**크로스봇 예시**

```
"이번달 스카 매출로 얼마나 투자할 수 있어?"
    → 스카봇: "2월 매출 182만원"
    → 투자봇: "리스크 자산 비중 20% 권고"
    → 메인봇: "2월 매출 182만원 기준 투자 권고금액 약 36만원"
```

---

### 5-3. 💹 투자팀 v2.0 (주식/코인봇)

> **논문 기반 설계**: TradingAgents (arXiv:2412.20138) + HedgeAgents (arXiv:2502.13165) + LLM_trader 패턴 통합
> **구조**: 투자 메인봇(펀드매니저)이 9개 에이전트를 지휘 — 병렬 분석 → 토론 → 리스크 검토 → 실행

#### ⚡ 현재 구현 상태 (Phase 0 — 드라이런, 2026-03-01)

> Phase 0는 v2.0 설계 구축 전 **드라이런 검증용 간소화 구현**입니다.
> 바이낸스 API 키 없이 실제 가격 데이터로 신호를 생성하고 DB에 기록하며, 실제 주문은 실행하지 않습니다.

**구현된 컴포넌트:**

| 봇 (별명) | 파일 | 역할 | 상태 |
|-----------|------|------|------|
| 제이슨 | `src/analysts/signal-aggregator.js` | TA 집계 + Claude LLM 판단 | ✅ DEV 운영 중 |
| 타일러 | `src/binance-executor.js` | 바이낸스 Spot 실행봇 (드라이런) | ✅ 드라이런 구현 |
| 몰리 | `src/upbit-bridge.js` | 업비트 브릿지 (드라이런) | ✅ 드라이런 구현 |
| - | `src/risk-manager.js` | 규칙 기반 리스크 매니저 | ✅ 구현 완료 |
| - | `src/analysts/ta-analyst.js` | RSI/MACD/볼린저밴드 계산 | ✅ 구현 완료 |

**launchd 운영:**
- `ai.invest.dev.plist` — 10분 주기, `INVEST_MODE=dev`, `DRY_RUN=true`, `RunAtLoad=true`
- OPS 플리스트(`ai.invest.pipeline`, `ai.invest.bridge`)는 실 API 키 준비 시까지 언로드

**드라이런 테스트 (2026-03-01):** BTC/USDT + ETH/USDT, 9/9 단계 통과

**Phase 0 → OPS 전환 조건:**
- `secrets.json`: `binance_api_key`, `binance_api_secret`, `dry_run: false`
- 바이낸스 API: IP 화이트리스트 + 거래 권한만 (출금 비활성화)
- `ai.invest.dev` 언로드 → `ai.invest.pipeline` + `ai.invest.bridge` 로드

---

#### 전체 구조 (v2.0)

```
투자 메인봇 / 펀드매니저 (claude-sonnet-4-6)
    │
    ├── [병렬 ~5초] 4개 분석가 동시 실행 ──────────────────────
    │   ├── 📊 기술분석가   groq/llama-3.3-70b      RSI/MACD/볼린저/이평정배열
    │   ├── 🌐 감성분석가   gemini-2.0-flash        Reddit/DCInside/X 커뮤니티
    │   ├── ⛓️ 온체인분석가  groq/llama-3.1-8b       Glassnode/공포탐욕지수/DXY
    │   └── 📰 뉴스분석가   groq/llama-3.1-8b       매크로이벤트/뉴스 요약
    │         └─→ 각각 구조화된 보고서 작성 (JSON/Markdown)
    │
    ├── [토론 ~5초] 불/베어 토론으로 합의 도출 ────────────────
    │   ├── 🐂 강세 리서처  claude-haiku-4-5        매수 근거 + 목표가 제시
    │   └── 🐻 약세 리서처  claude-haiku-4-5        매도 근거 + 리스크 제시
    │         └─→ n라운드 토론 → 합의 의견 → 펀드매니저에게 전달
    │
    ├── [리스크 검토 ~3초] ──────────────────────────────────
    │   └── ⚖️ 리스크 매니저  claude-haiku-4-5      포지션 크기·손실한도 최종 검토
    │         └─→ 승인 / 수정 / 거부
    │
    └── [실행 ~0.5초] ───────────────────────────────────────
        ├── ⚡ 바이낸스 실행봇  (LLM 없음)           USDT 마켓 · spot+futures
        └── 🇰🇷 업비트 실행봇   (LLM 없음)           KRW 마켓 · 현물

[비동기·주기적]
    └── 📚 백테스팅 엔진     deepseek-r1:32b 로컬   매주 일요일 02:00
```

**전체 사이클 타임**: 병렬5초 + 토론5초 + 리스크3초 + 실행0.5초 = **약 13~15초** (5분 캔들에 충분)

---

#### 5-3-1. 💹 투자 메인봇 (펀드매니저)

| 항목 | 내용 |
|------|------|
| Primary LLM | `claude-sonnet-4-6` |
| Fallback | `gemini-2.0-flash` |
| 상태 | ⏳ Phase 3 구축 예정 |
| 역할 | 전체 조율 → 최종 매매 결정 → 실행봇 명령 → 보고 |

**핵심 기능**

| 기능 | 설명 |
|------|------|
| 4개 분석가 병렬 실행 | Promise.all() → 구조화 보고서 수집 |
| 리서처 토론 조율 | 강세↔약세 n라운드 → 합의 추출 |
| 리스크 매니저 검토 요청 | 결정 전 최종 안전장치 |
| 실행봇 명령 발송 | JSON 명령어 → 바이낸스/업비트 선택 |
| 학습 루프 | 거래 결과 → ChromaDB → 전략 가중치 조정 |
| 일일 보고 | 매일 22:00 수익률 리포트 텔레그램 발송 |

---

#### 5-3-2. 분석가팀 (4명 병렬)

**📊 기술분석가**

| 항목 | 내용 |
|------|------|
| LLM | `groq/llama-3.3-70b-versatile` (225ms, 무료) |
| Fallback | `gemini-2.0-flash` |
| 수집 소스 | TA-Lib: RSI, MACD, 볼린저밴드, ATR, 이평정배열(5/10/20/60/120) |
| 주기 | 매 5분 (바이낸스/업비트 캔들 데이터) |
| 출력 | `{ signal: "BUY/SELL/HOLD", confidence: 0.8, key_indicators: [...] }` |

**🌐 감성분석가**

| 항목 | 내용 |
|------|------|
| LLM | `gemini-2.0-flash` (무료 OAuth) |
| Fallback | `groq/llama-4-scout-17b` |
| 수집 소스 | Reddit (r/Bitcoin, r/Crypto) / DCInside 코인갤 / 코인판 / X 트렌드 |
| 주기 | 30분 (커뮤니티) + 5분 (X 실시간) |
| 출력 | `{ sentiment: "bullish/bearish/neutral", score: 0.7, sources: [...] }` |

**⛓️ 온체인분석가**

| 항목 | 내용 |
|------|------|
| LLM | `groq/llama-3.1-8b-instant` (203ms, 무료) |
| Fallback | `gemini-2.0-flash` |
| 수집 소스 | Glassnode API, 공포탐욕지수, KOSPI/KOSDAQ, DXY, 펀딩비, 미결제약정 |
| 주기 | 1시간 (온체인) + 5분 (펀딩비) |
| 출력 | `{ onchain_signal: "accumulation/distribution", fear_greed: 45 }` |

**📰 뉴스분석가**

| 항목 | 내용 |
|------|------|
| LLM | `groq/llama-3.1-8b-instant` (203ms, 무료) |
| Fallback | `gemini-2.0-flash` |
| 수집 소스 | CoinDesk, CoinTelegraph, 블록미디어, DART 공시 |
| 주기 | 30분 |
| 출력 | `{ impact: "positive/negative/neutral", events: [...] }` |

---

#### 5-3-3. 리서처팀 (강세 ↔ 약세 토론)

| 항목 | 강세 리서처 | 약세 리서처 |
|------|-----------|-----------|
| LLM | `claude-haiku-4-5-20251001` | `claude-haiku-4-5-20251001` |
| Fallback | `groq/llama-4-scout-17b` | `groq/llama-4-scout-17b` |
| 역할 | 4개 분석 보고서에서 매수 근거 추출 | 4개 분석 보고서에서 리스크 추출 |
| 출력 | 매수 근거 + 목표가 + 진입 타이밍 | 매도 근거 + 손절가 + 위험 요소 |

**통신 패턴**: 구조화된 보고서 전달 (TradingAgents "telephone effect" 방지)
```
분석가 보고서 4개 → [강세/약세 리서처가 동일 보고서 읽음]
강세: "BTC RSI 과매도 + 이평 정배열 → 매수 유효"
약세: "펀딩비 -0.05% → 롱 청산 압력 + 온체인 분산 신호"
→ 펀드매니저가 합의점 판단
```

---

#### 5-3-4. ⚖️ 리스크 매니저

| 항목 | 내용 |
|------|------|
| LLM | `claude-haiku-4-5-20251001` |
| Fallback | `groq/llama-3.3-70b-versatile` |
| 역할 | 펀드매니저 결정 최종 검토 |

**안전장치 규칙**

| 규칙 | 기준 |
|------|------|
| 단일 포지션 한도 | 총자산의 10% 이하 |
| 일일 손실 한도 | -3% 도달 시 자동 중단 |
| 연속 손실 차단 | 3연속 손실 → 24시간 거래 중지 |
| 긴급 청산 조건 | 단일 포지션 -7% 도달 |

---

#### 5-3-5. ⚡ 바이낸스 실행봇 vs 🇰🇷 업비트 실행봇

| 항목 | 바이낸스 실행봇 | 업비트 실행봇 |
|------|--------------|-------------|
| LLM | 없음 (완전 규칙 기반) | 없음 (완전 규칙 기반) |
| 마켓 | USDT/BTC 마켓 | KRW 마켓 |
| 지원 유형 | spot + futures (레버리지) | 현물만 |
| API 한도 | 1,200 req/min weight | 8 req/sec (주문) |
| TP/SL | ✅ 자동 설정 | ❌ (별도 모니터링 필요) |
| 용도 | 글로벌 USDT 전략 · 선물 헷지 | 원화 직접 투자 · 안전한 현물 |
| 안전장치 | 포지션 한도 10%, 일손실 -3% | 종목당 한도 10%, 일손실 -3% |

**공통 명령 구조**
```json
{
  "exchange": "binance",
  "action": "BUY",
  "symbol": "BTCUSDT",
  "type": "limit",
  "size": 0.001,
  "price": 95000,
  "stopLoss": 93000,
  "takeProfit": 100000,
  "reason": "RSI 과매도 + 이평 정배열 + 감성 긍정"
}
```

---

#### 5-3-6. 📚 백테스팅 엔진

| 항목 | 내용 |
|------|------|
| LLM | `ollama/deepseek-r1:32b` (로컬, 무료) |
| 프레임워크 | backtrader + pandas-ta (→ VectorBT 전환 검토) |
| 역할 | 신규 전략 검증, 파라미터 최적화 |
| 주기 | 매주 일요일 02:00 cron 자동 실행 |
| 기준 | 샤프비율 > 1.5 + MDD < 20% |

---

#### 5-3-7. 3가지 회의 체계 (HedgeAgents 패턴)

| 회의 | 트리거 | 참여자 | 목적 |
|------|--------|--------|------|
| **정기 분석 회의** | 매 5분 자동 | 전체 팀 | 일반 매매 결정 사이클 |
| **경험 공유 회의** | 매일 22:00 | 메인봇 + 리서처 | 거래 리뷰 → ChromaDB 학습 저장 |
| **긴급 시장 회의** | 일간 ±5% / 3일 ±10% 감지 | 전체 팀 즉시 | 포지션 긴급 재검토·청산 |

---

#### 5-3-8. 의사소통 아키텍처

**메인봇 ↔ 투자팀 통신 케이스**

| 케이스 | 흐름 | 방식 |
|--------|------|------|
| 사용자 질문 "BTC 어때?" | 메인봇 → 투자메인봇 → 응답 → 메인봇 → 사용자 | 동기 호출 |
| 거래 체결 알람 | 투자팀 → 텔레그램 직발송 | 비동기 직발송 |
| 일일 보고 (22:00) | 투자팀 cron → 텔레그램 직발송 | 스케줄 트리거 |
| 긴급 급락 | 가격감시 → EMC 트리거 → 즉시 포지션 검토 | 이벤트 드리븐 |

**팀 내부 통신**: 직접 함수 호출 (async/await) + 구조화 보고서
- 에이전트 간 메시지 이력 전달 ❌ (telephone effect 방지)
- 각 에이전트가 공유 상태(SQLite/Redis)에서 직접 읽음 ✅
- 병렬 분석: `Promise.all([기술, 감성, 온체인, 뉴스])` ✅

---

#### 5-3-9. 투자팀 구축 로드맵

| Phase | 내용 | 시점 |
|-------|------|------|
| **3-A** | 기술·감성 분석가 + 투자 메인봇 기본 구조 + 모델 테스팅 | 맥미니 이전 후 |
| **3-B** | 온체인·뉴스 분석가 + 리서처 토론 + 리스크 매니저 추가 | +2주 |
| **3-C** | 바이낸스 실행봇 (페이퍼 트레이딩 먼저) | +2주 |
| **3-D** | 업비트 실행봇 + 두 거래소 전략 분리 | +1주 |
| **3-E** | 백테스팅 엔진 + 전략 라이브러리 + 3가지 회의 체계 | +2주 |
| **3-F** | 메인봇 라우팅 연동 (스카+투자 통합) | +1주 |
| **Phase 4** | 실전 자동매매 전환 (1개월 모의 검증 후) | 3개월 모의 후 |

> ⚠️ **Phase 3-C~D까지 페이퍼 트레이딩 필수** — 실제 자금은 백테스팅 + 모의 검증 후
> 💡 **수익 발생 시 모델 업그레이드 검토**: 리서처/리스크매니저 → claude-sonnet, 분석가 → claude-haiku 전환

---

### 5-4. 🗓️ 개인비서봇

| 항목 | 내용 |
|------|------|
| Primary LLM | `gemini-2.0-flash` |
| Fallback | `ollama/qwen2.5:7b` |
| 역할 | Google Calendar 연동, 일정 관리, 리마인더 |
| 상태 | ⏳ Phase 3 구축 예정 |

---

### 5-5. 💼 업무봇

| 항목 | 내용 |
|------|------|
| Primary LLM | `kimi-k2p5` (2M 토큰 컨텍스트) |
| Fallback | `claude-sonnet-4-6` |
| 역할 | Gmail 연동, 문서 작성, Notion/구글 드라이브 |
| 상태 | ⏳ Phase 3 구축 예정 |

---

### 5-6. 📚 학술보조봇

| 항목 | 내용 |
|------|------|
| Primary LLM | `ollama/deepseek-r1:32b` (로컬, 무료) |
| Fallback | `claude-opus-4-6` |
| 역할 | KCI 논문 검색·분석, RAG 파이프라인, 졸업 논문 지원 |
| 상태 | ⏳ Phase 4 구축 예정 |

---

### 5-7. ⚖️ 판례봇

| 항목 | 내용 |
|------|------|
| Primary LLM | `ollama/deepseek-r1:32b` (학술봇 모델 공유) |
| Fallback | `kimi-k2p5` (대용량 판례문 처리) |
| 역할 | CourtListener API 연동, 국내외 판례 분석 |
| 상태 | ⏳ Phase 4 구축 예정 |

---

## 6. 메모리 할당 계획 (Mac Mini M4 Pro 64GB)

### Ollama 로컬 모델 메모리

| 모델 | 사용 봇 | 메모리 | 운영 방식 |
|------|---------|--------|---------|
| `qwen2.5:7b` | 스카봇 Primary | **4.5 GB** | 24/7 상주 |
| `deepseek-r1:32b` | 학술봇·판례봇·백테스팅 공유 | **20.0 GB** | 요청 시 로딩 |
| `nomic-embed-text` | ChromaDB RAG 임베딩 | **0.3 GB** | 항상 상주 |

### 시나리오별 총 메모리 사용량

| 시나리오 | 총 사용 | 여유 | 상태 |
|---------|---------|------|------|
| 평상시 (스카봇) | **12.8 GB** | 51.2 GB | 🟢 여유 |
| 학술·판례·백테스팅 작업 | **28.3 GB** | 35.7 GB | 🟢 안전 |
| 최대 부하 (전체 동시) | **33.5 GB** | 30.5 GB | 🟢 안전 |
| 버퍼 포함 피크 (+20%) | **40.2 GB** | 23.8 GB | 🟢 안전 |

> ✅ **64GB는 모든 시나리오에서 안전하게 운영 가능**

### API 봇 로컬 메모리 (추론은 클라우드)

| 봇 | 로컬 메모리 |
|----|-----------|
| 메인봇 + 투자봇 + 비서봇 + 업무봇 + 리서치봇 | 각 0.1 GB |
| 합계 | **0.5 GB** |

### Ollama 운영 설정 권장값

```bash
export OLLAMA_MAX_LOADED_MODELS=1   # 동시 로딩 모델 수 제한
export OLLAMA_KEEP_ALIVE=24h        # 모델 메모리 유지 시간
export OLLAMA_NUM_GPU=99            # GPU 레이어 최대화 (M4 Pro)
```

### 봇별 모델 스케줄링 전략

```
[24/7 상주]
  qwen2.5:7b     → 스카봇 예약 파싱
  nomic-embed-text → RAG 임베딩

[요청 감지 시]
  qwen2.5:7b 언로드 → deepseek-r1:32b 로딩 (~30초)
  학술봇/판례봇/백테스팅 순차 큐잉 (deepseek-r1:32b 공유)

[향후 추가 가능 (여유 ~24GB)]
  llava:13b      → 이미지 분석 봇 (+8 GB)
  qwen2.5-coder:14b → 코딩 전용 봇 (+9 GB)
```

---

## 7. OpenClaw 설정

### 현재 운영 모델 (2026-02-27)

| 순서 | 모델 | 역할 | 비고 |
|------|------|------|------|
| Primary | `google-gemini-cli/gemini-2.0-flash` | 기본 엔진 (무료 OAuth) | deprecated이나 정상 동작 |
| Fallback #1 | `anthropic/claude-haiku-4-5` | Gemini 장애 시 | |
| Fallback #2 | `ollama/qwen2.5:7b` | 비상용 | Telegram 직접 발송 불가 |

### 텔레그램 봇

- 봇: `@SCAFE8282_BOT`
- 사장님 chat_id: `***REMOVED***`
- 상태: ✅ 정상 연결

### 멀티에이전트 구성 (맥미니 이전 후)

```json5
// openclaw.json 추가 예정
{
  "agents": {
    "list": [
      { "id": "main",       "workspace": "~/.openclaw/workspace" },
      { "id": "ska",        "workspace": "~/bots/reservation/context" },
      { "id": "investment", "workspace": "~/bots/investment/context" }
    ]
  }
}
```

---

## 8. 컨텍스트 관리 시스템 ✅ (2026-02-23 구축 완료)

```
context/ (소스, git 관리)
    │
    ▼ node deploy-context.js --bot=<name>
    ├── → ~/.openclaw/workspace/ (봇 기억)
    └── → ~/.claude/memory/ (Claude Code 기억)
```

```bash
node scripts/deploy-context.js --bot=reservation   # 스카봇 배포
node scripts/deploy-context.js --bot=investment    # 투자봇 배포 (추후)
node scripts/deploy-context.js --all               # 전체 배포
node scripts/deploy-context.js --bot=reservation --sync  # 역동기화
```

---

## 9. 자동화 운영 시스템

| 항목 | 방식 | 주기 | 상태 |
|------|------|------|------|
| 네이버 모니터링 | naver-monitor.js | 5분 | ✅ OPS |
| OPS 자동 재시작 | start-ops.sh (launchd KeepAlive) | 즉시 | ✅ |
| Heartbeat 알람 | OpenClaw 내장 | 30분 | ✅ |
| 픽코 키오스크 모니터 | pickko-kiosk-monitor.js | 30분 | ✅ |
| 매출 일일 보고 | pickko-daily-summary.js | 00:00 | ✅ |
| 컨텍스트 보존 | nightly-sync.sh + launchd | 00:00 | ✅ |
| 투자 리서치 수집 | 리서치봇 (예정) | 5분/30분/1시간 | ⏳ Phase 3 |
| 백테스팅 자동 실행 | 백테스팅 엔진 (예정) | 매주 일요일 | ⏳ Phase 3 |
| 투자 일일 보고 | 투자 메인봇 (예정) | 22:00 | ⏳ Phase 3 |

---

## 10. API 키 현황

| API | 대상 봇 | 상태 |
|-----|---------|------|
| Anthropic API | 메인봇, 투자봇 | ✅ 완료 |
| Google Gemini API (OAuth) | 스카봇 현재 primary | ✅ 완료 |
| Moonshot (Kimi) API | 업무봇, 판례봇 | 🔄 발급 필요 |
| OpenRouter API | 리서치봇 Fallback | 🔄 발급 필요 |
| Binance API | 바이낸스 실행봇 | ⏳ Phase 3 |
| DART API | 국내 주식 공시 | ⏳ Phase 3 |
| Glassnode API | 온체인 지표 | ⏳ Phase 3 |

---

## 11. 구축 단계별 진행 현황

### Phase 1 - ✅ 완료 (2026-02-23~27)

| 항목 | 상태 |
|------|------|
| OpenClaw 설치 + Gemini/Claude/Ollama Fallback Chain | ✅ |
| 텔레그램 봇 연결 (@SCAFE8282_BOT) | ✅ |
| 예약관리봇 100% 완성 (Stage [1-9] + 키오스크 모니터) | ✅ |
| OPS 모드 launchd KeepAlive + 헤드리스 실운영 | ✅ |
| SQLite 마이그레이션 + 개인정보 암호화 | ✅ |
| 매출 통계 분리 (스터디카페/스터디룸) + CSV 예측 데이터 | ✅ |
| RAG 지식 베이스 구축 | ✅ |
| 컨텍스트 관리 시스템 구축 | ✅ |
| 공유 인프라 packages/core + playwright-utils | ✅ |
| iPad Termius SSH + Tailscale 외부 원격 접속 | ✅ |

### Phase 2 - 맥미니 구매 후

| 항목 | 상태 |
|------|------|
| 맥미니 M4 Pro 12코어 64GB 1TB 구매 | ⏳ |
| Ollama (qwen2.5:7b + deepseek-r1:32b + nomic-embed-text) | ⏳ |
| Open WebUI + n8n 세팅 | ⏳ |
| 전체 시스템 맥미니 이전 | ⏳ |

### Phase 3 - 봇 순차 구축

| 항목 | 상태 |
|------|------|
| 예약관리봇 맥미니 이전 및 안정화 | ⏳ |
| 메인봇 구축 (claude-sonnet-4-6 + 라우팅 로직) | ⏳ |
| 비서봇 구축 (Google Calendar 연동) | ⏳ |
| 업무봇 구축 (Gmail + Notion 연동) | ⏳ |
| **투자팀 구축** (리서치봇 → 투자봇 → 실행봇) | ⏳ |
| 메인봇 ↔ 스카봇 ↔ 투자봇 라우팅 통합 | ⏳ |

### Phase 4 - 학술 시스템 + 실전 투자

| 항목 | 상태 |
|------|------|
| 학술보조봇 구축 (KCI + RAG 파이프라인) | ⏳ |
| 판례봇 구축 (CourtListener 연동) | ⏳ |
| 투자봇 실전 자동매매 전환 (1개월 모의 후) | ⏳ |

---

## 12. 디렉토리 구조

```
ai-agent-system/
├── bots/
│   ├── registry.json              # 전체 봇 등록부
│   ├── _template/                 # 신규 봇 스캐폴딩
│   ├── reservation/               # 📅 스카봇 (OPS 운영 중)
│   │   ├── context/               # IDENTITY / MEMORY / DEV_SUMMARY / HANDOFF
│   │   ├── lib/                   # 12개 공유 모듈
│   │   ├── src/                   # 실행 스크립트
│   │   └── scripts/               # 유지보수 스크립트
│   └── investment/                # 💹 투자팀 (Phase 3 신규)
│       ├── context/
│       ├── src/
│       │   ├── investment-main.js  # 투자 메인봇
│       │   ├── binance-executor.js # 바이낸스 실행봇
│       │   ├── researcher.js       # 리서치봇
│       │   └── backtester.js       # 백테스팅 엔진
│       └── lib/
├── packages/
│   ├── core/                      # @ai-agent/core (공유 유틸)
│   └── playwright-utils/          # @ai-agent/playwright-utils
├── scripts/
│   ├── deploy-context.js
│   ├── session-close.js
│   └── lib/                       # scripts 공유 모듈
└── docs/
    └── SYSTEM_DESIGN.md           # 본 문서
```

---

## 13. 자금 계획

| 항목 | 금액 | 상태 |
|------|------|------|
| 데스크탑 판매 | +180만원 | ✅ 완료 |
| 맥북 M1 Pro 판매 | +160만원 | 🔄 진행 중 |
| **총 예상 자금** | **340만원** | |
| 맥미니 구매 | -302만원 | ⏳ 대기 |
| **잔여 예산** | **38만원** | |

---

## 14. 유지보수 백로그

### 🔴 높은 우선순위

| ID | 항목 | 내용 |
|----|------|------|
| M-001 | OpenClaw cron 주기적 sync | `~/.openclaw/cron/jobs.json`에 1~2시간 주기 `--sync` 추가 |
| M-002 | IS-001 네이버 홈화면 복귀 이슈 | 캘린더 → 홈화면 복귀 자동화 미완성 |
| M-003 | RAG 서버 자동 시작 | launchd plist 추가 (현재 수동 실행) |

### 🟡 중간 우선순위

| ID | 항목 | 내용 |
|----|------|------|
| M-004 | Kimi API 발급 | 업무봇/판례봇 Primary 모델 준비 |
| M-005 | OpenRouter API 발급 | 리서치봇 Fallback 준비 |
| M-006 | 컨텍스트 diff 알림 | 역동기화 시 변경사항 Telegram 알림 |
| M-007 | registry.json 모델 최신화 | 모델 변경 시 자동 동기화 |

### 🟢 낮은 우선순위 / Phase 3 이후

| ID | 항목 | 내용 |
|----|------|------|
| M-008 | n8n 멀티봇 워크플로우 | 맥미니 구매 후 |
| M-009 | 봇 대시보드 | 전체 봇 운영 현황 웹 대시보드 |
| M-010 | 투자봇 페이퍼 트레이딩 | Phase 3-B 시작 조건 |

---

*본 문서는 시스템 구축 진행에 따라 지속 업데이트 예정*
*파일 위치: `~/projects/ai-agent-system/docs/SYSTEM_DESIGN.md`*
*최종 업데이트: 2026-02-27 | 제이 멀티에이전트 시스템 v2.0*
