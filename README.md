# 🤖 AI Agent System

맥미니 M4 Pro 기반 멀티 에이전트 AI 봇 시스템 | v2.0

---

## 봇 현황

| 봇 | Primary LLM | Fallback | 예상 월비용 | 상태 |
|----|-------------|----------|-----------|------|
| 🧠 메인봇 (오케스트레이터) | `claude-sonnet-4-6` | `kimi-k2p5` | ~$8 | ⏳ Phase 3 |
| 📅 스카봇 (예약관리) | `google-gemini-cli/gemini-2.5-flash` | `claude-haiku-4-5` | $0 | ✅ OPS 운영 중 |
| 🗓️ 비서봇 (일정·캘린더) | `gemini-2.0-flash` | `ollama/qwen2.5:7b` | ~$1 | ⏳ Phase 3 |
| 💼 업무봇 (문서·이메일) | `kimi-k2p5` | `claude-sonnet-4-6` | ~$5 | ⏳ Phase 3 |
| 📚 학술봇 (논문 리서치) | `ollama/deepseek-r1:32b` | `claude-opus-4-6` | $0 | ⏳ Phase 4 |
| ⚖️ 판례봇 (법률 판례) | `ollama/deepseek-r1:32b` | `kimi-k2p5` | $0 | ⏳ Phase 4 |
| 💹 투자 메인봇 (펀드매니저) | `claude-haiku-4-5-20251001` | — | ~$0.1 | ✅ DEV 운영 중 |
| 📊 기술·감성·온체인·뉴스 분석가 | `groq/llama-3.3-70b` + `groq/llama-3.1-8b` | `claude-haiku-4-5` | $0 (무료) | ✅ DEV 운영 중 |
| 🔍 강세·약세 리서처 + 리스크매니저 | `claude-haiku-4-5-20251001` | — | ~$0.1 | ✅ DEV 운영 중 |
| ⚡ 바이낸스 실행봇 (타일러) | LLM 없음 (규칙 기반) | — | $0 | ✅ DEV 드라이런 |
| 🇰🇷 업비트 실행봇 (몰리) + KIS 실행봇 (크리스) | LLM 없음 (규칙 기반) | — | $0 | ✅ DEV 드라이런 |
| 📊 성과 리포터 + 백테스팅 엔진 | 규칙 기반 | — | $0 | ✅ DEV 운영 중 |

**총 예상 월 API 비용: ~$0.2 (DEV 모드, haiku 2개 봇 실비용)**

---

## 전체 아키텍처

```
👤 사용자 (텔레그램 단일 채널)
    │
    ▼ 모든 지시 → 메인봇으로
┌──────────────────────────────────────────────────────┐
│  🧠 메인봇 (오케스트레이터)  claude-sonnet-4-6        │
│  - 의도 파악 → 담당 봇 위임                           │
│  - 크로스봇 조율 (스카+투자 연계 등)                  │
│  - 최종 응답 포맷 & 전달                              │
└──────┬──────────┬──────────┬──────────┬──────────────┘
       │          │          │          │
       ▼          ▼          ▼          ▼
┌──────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
│📅 스카봇  │ │🗓️비서봇 │ │💼업무봇 │ │📚학술봇  │
│예약관리   │ │일정관리 │ │문서/메일│ │논문리서치│
│qwen2.5:7b│ │gemini  │ │kimi-k2p5│ │deepseek │
│          │ │-flash  │ │        │ │-r1:32b  │
└──────────┘ └────────┘ └────────┘ └──────────┘
                                    ┌──────────┐
                                    │⚖️판례봇  │
                                    │법률판례  │
                                    │deepseek │
                                    │-r1:32b  │
                                    └──────────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│  💹 투자팀                                       │
│                                                 │
│  ┌─────────────────────────────────────────────┐  │
│  │  💹 투자 메인봇 (펀드매니저)                  │  │
│  │     claude-sonnet-4-6                       │  │
│  │  - 4개 분석가 병렬 → 리서처 토론 → 리스크검토│  │
│  │  - 매매 의사결정 → 실행봇 명령               │  │
│  │  - 일일 22:00 수익률 리포트                  │  │
│  └──┬──────────┬──────────┬────────────────────┘  │
│     │          │          │                        │
│   [병렬]    [토론]     [실행]                       │
│     ▼          ▼          ▼                        │
│  ┌──────────────────────────────────────────────┐ │
│  │ 📊기술  🌐감성  ⛓️온체인  📰뉴스  (병렬분석) │ │
│  │ groq   gemini  groq    groq                  │ │
│  ├──────────────────────────────────────────────┤ │
│  │ 🐂강세리서처 ↔ 🐻약세리서처  ⚖️리스크매니저  │ │
│  │       claude-haiku-4-5                       │ │
│  ├──────────────────────────────────────────────┤ │
│  │ ⚡바이낸스실행봇   🇰🇷업비트실행봇  📚백테스팅 │ │
│  │  (LLM없음)         (LLM없음)    deepseek로컬 │ │
│  └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

---

## 봇별 상세

### 📅 스카봇 — 예약관리봇 (OPS 운영 중)
- 네이버 스마트플레이스 5분 주기 모니터링
- 신규 예약 감지 → 픽코 키오스크 자동 등록 (Stage 1~9)
- 키오스크 예약 감지 → 네이버 예약불가 자동 차단/해제
- 매출 일일 보고 (스터디카페/스터디룸 분리)

### 🧠 메인봇 — 오케스트레이터 (Phase 3)
- 사용자의 모든 요청을 받아 담당 봇으로 라우팅
- 크로스봇 조율: 스카 매출 + 투자 연계 등 복합 질문 처리

### 🗓️ 비서봇 (Phase 3)
- Google Calendar 연동 일정 관리
- 리마인더·알림·날씨·교통 등 생활 정보

### 💼 업무봇 (Phase 3)
- Gmail 연동 이메일 분류·요약·답장 초안
- 문서 작성 (보고서·제안서), Notion/구글 드라이브 관리

### 📚 학술봇 (Phase 4)
- KCI 논문 검색·분석 (SE 기반 소프트웨어 감성 평가 연구)
- Semantic Scholar API 해외 논문 수집
- ChromaDB RAG 파이프라인 (nomic-embed-text)

### ⚖️ 판례봇 (Phase 4)
- CourtListener API 미국 판례 수집
- 국내 법원 판례 검색·분석
- 학술봇과 deepseek-r1:32b 모델 공유

### 💹 루나팀 (투자팀) — Phase 0 DEV 운영 중
> TradingAgents (arXiv:2412.20138) + HedgeAgents (arXiv:2502.13165) 논문 기반 설계
> **모든 엔진이 암호화폐(바이낸스·업비트) + 국내주식(KIS) 함께 처리**

- **루나 펀드매니저** (fund-manager.js): 전체 조율 → 최종 매매 결정 → 일일 리포트 (claude-haiku, 60분)
- **제이슨 신호집계기** (signal-aggregator.js): 4개 분석가 병렬 → 리서처 토론 → LLM 판단 (10분)
- **분석가팀 (4명)**: 기술분석(haiku) / 감성분석(Groq 70B) / 온체인(Groq 8B) / 뉴스(Groq 8B)
- **리서처팀 (2명, 토론)**: 강세 리서처 ↔ 약세 리서처 — MAX 2심볼 debate (claude-haiku)
- **리스크 매니저 v2**: ATR변동성·상관관계·시간대·LLM 4단계 조정 (claude-haiku)
- **타일러** (binance-executor): 바이낸스 Spot 주문 (드라이런)
- **몰리 v2** (upbit-bridge): 업비트 TP/SL 자동 청산 ±3% (드라이런)
- **크리스** (kis-executor): KIS 국내주식 모의투자 실행봇 (모의투자 기본값)
- **성과 리포터** (reporter.js): 일/주/월 수익률 리포트 (22:00 자동 발송)
- **백테스팅 엔진** (backtest.js): 4심볼 1d/4h 전략 검증, 샤프비율/MDD
- **대상 심볼**: 코인 BTC/ETH/SOL/BNB + KIS 005930(삼성)/000660(SK하이닉스)

---

## 프로젝트 구조

```
ai-agent-system/
├── bots/
│   ├── registry.json              # 전체 봇 등록부
│   ├── _template/                 # 신규 봇 스캐폴딩
│   ├── reservation/               # 📅 스카봇 (OPS 운영 중)
│   │   ├── context/               # IDENTITY / MEMORY / DEV_SUMMARY / HANDOFF
│   │   ├── lib/                   # 공유 모듈 (db, pickko, crypto 등)
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
│   ├── core/                      # @ai-agent/core (outputResult, fail, utils 등)
│   └── playwright-utils/          # @ai-agent/playwright-utils
├── scripts/
│   ├── deploy-context.js          # 봇 기억 배포/역동기화
│   ├── session-close.js           # 세션 마감 자동화
│   └── lib/                       # scripts 공유 모듈
└── docs/
    └── SYSTEM_DESIGN.md           # 전체 설계서
```

---

## 컨텍스트 관리

```bash
node scripts/deploy-context.js --bot=reservation   # 스카봇 배포
node scripts/deploy-context.js --all               # 전체 배포
node scripts/deploy-context.js --bot=reservation --sync  # 역동기화
```

---

## 구축 단계

| Phase | 내용 | 상태 |
|-------|------|------|
| **Phase 1** | 스카봇 OPS + SQLite + 매출통계 + RAG + 공유 인프라 + iPad 원격 접속 | ✅ 완료 |
| **Phase 2** | 맥미니 구매 + Ollama/n8n 설치 + 전체 시스템 이전 | ⏳ 대기 |
| **Phase 3** | 메인봇 + 비서봇 + 업무봇 + **투자팀** 구축 | ⏳ 맥미니 후 |
| **Phase 4** | 학술봇 + 판례봇 + 실전 자동매매 전환 | ⏳ Phase 3 후 |

---

## 상세 설계서

[SYSTEM_DESIGN.md](./docs/SYSTEM_DESIGN.md)

---

## 맥북 재부팅 절차

### 재부팅 전 (자동화)

```bash
# 재부팅 전 종료 루틴 실행 (git 상태 확인 + 서비스 정지 + 텔레그램 알림)
bash scripts/pre-reboot.sh
# → 완료 후 재부팅
```

### 재부팅 후 (자동)

재부팅 완료 후 약 65초 내에 텔레그램으로 상태 알림이 자동 전송됩니다.
(`ai.agent.post-reboot` launchd 서비스가 RunAtLoad로 자동 실행)

```bash
# 수동 확인이 필요한 경우
skastatus                           # 스카 서비스 PID 확인
bootlog                             # 스카 BOOT 완료 확인 (durationMs 확인)
tail -f /tmp/post-reboot.log        # 재부팅 후 시작 루틴 로그
```

### launchd 자동 재시작 서비스 목록

**스카팀 (KeepAlive — 항상 실행)**

| 서비스 | 역할 |
|--------|------|
| `ai.openclaw.gateway` | 스카 LLM 게이트웨이 (gemini-2.5-flash) |
| `ai.ska.naver-monitor` | 앤디 — 네이버 예약 5분 모니터링 |
| `ai.ska.kiosk-monitor` | 지미 — 키오스크 30분 모니터링 |

**스카팀 (스케줄 기반)**

| 서비스 | 역할 |
|--------|------|
| `ai.ska.pickko-verify` | 픽코 검증 (08:00/14:00/20:00) |
| `ai.ska.pickko-daily-summary` | 일일 예약 요약 (09:00 / 00:00) |
| `ai.ska.pickko-daily-audit` | 일일 감사 (00:00/22:00/23:00) |
| `ai.ska.health-check` | 헬스체크 (30분 주기) |
| `ai.ska.log-rotate` | 로그 로테이션 (자정) |
| `ai.ska.etl` | ETL 데이터 동기화 (매시) |
| `ai.ska.rebecca` | 매출 분석 (일일) |
| `ai.ska.eve` | 환경요소 수집 (일일) |
| `ai.ska.forecast-daily` | 일별 예측 (일일) |

**루나팀 (스케줄 기반 — DEV 드라이런)**

| 서비스 | 역할 |
|--------|------|
| `ai.invest.dev` | 제이슨 신호집계 (10분 주기) |
| `ai.invest.fund` | 루나 펀드매니저 (60분 주기) |
| `ai.invest.tpsl` | 몰리 TP/SL 모니터 (5분 주기) |
| `ai.invest.bridge` | 업비트 브릿지 (1시간 주기) |
| `ai.invest.report` | 성과 리포터 (22:00 일일) |

**클로드팀 (스케줄 기반)**

| 서비스 | 역할 |
|--------|------|
| `ai.claude.dexter` | 덱스터 시스템 점검 (1시간) |
| `ai.claude.dexter.daily` | 덱스터 일일 보고 (08:00) |
| `ai.claude.archer` | 아처 기술 인텔리전스 (매주 월 09:00) |

**공통**

| 서비스 | 역할 |
|--------|------|
| `ai.agent.post-reboot` | 재부팅 후 상태 확인 (RunAtLoad, 1회) |
| `ai.agent.auto-commit` | 자동 커밋 (KeepAlive) |
| `ai.agent.nightly-sync` | 야간 컨텍스트 동기화 (자정) |

---

## iPad SSH 접속 가이드

```bash
# SSH 접속 (Termius)
로컬:      192.168.45.176:22
외부(Tailscale): 100.124.124.65:22

# 클로드 실행 alias
ai        # 시스템 전체 작업 (CL-xxx 태스크) → cd ~/projects/ai-agent-system && claude
ska       # 스카봇 전용 작업
skalog    # 스카 OPS 로그 실시간 확인
skastatus # launchd 스카 서비스 상태
bootlog   # 스카 BOOT 시간 확인

# 작업 이어받기 예시
"CL-003 매출 예측 엔진 작업 시작해줘"
"CL-002 코딩가이드 최신화해줘"
```
