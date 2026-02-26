# 🤖 AI Agent System

맥미니 M4 Pro 기반 멀티 에이전트 AI 봇 시스템 | v2.0

---

## 봇 현황

| 봇 | Primary LLM | Fallback | 예상 월비용 | 상태 |
|----|-------------|----------|-----------|------|
| 🧠 메인봇 (오케스트레이터) | `claude-sonnet-4-6` | `kimi-k2p5` | ~$8 | ⏳ Phase 3 |
| 📅 스카봇 (예약관리) | `ollama/qwen2.5:7b` | `gemini-2.0-flash` | $0 | ✅ OPS 운영 중 |
| 🗓️ 비서봇 (일정·캘린더) | `gemini-2.0-flash` | `ollama/qwen2.5:7b` | ~$1 | ⏳ Phase 3 |
| 💼 업무봇 (문서·이메일) | `kimi-k2p5` | `claude-sonnet-4-6` | ~$5 | ⏳ Phase 3 |
| 📚 학술봇 (논문 리서치) | `ollama/deepseek-r1:32b` | `claude-opus-4-6` | $0 | ⏳ Phase 4 |
| ⚖️ 판례봇 (법률 판례) | `ollama/deepseek-r1:32b` | `kimi-k2p5` | $0 | ⏳ Phase 4 |
| 💹 투자 메인봇 (펀드매니저) | `claude-sonnet-4-6` | `gemini-2.0-flash` | (메인봇 공유) | ⏳ Phase 3 |
| 📊 기술·감성·온체인·뉴스 분석가 | `groq/llama-3.3-70b` + `gemini-flash` | `claude-haiku-4-5` | $0 (무료) | ⏳ Phase 3 |
| 🔍 강세·약세 리서처 + 리스크매니저 | `claude-haiku-4-5` | `groq/llama-4-scout` | ~$0.5 | ⏳ Phase 3 |
| ⚡ 바이낸스 실행봇 | LLM 없음 (규칙 기반) | — | $0 | ⏳ Phase 3 |
| 🇰🇷 업비트 실행봇 | LLM 없음 (규칙 기반) | — | $0 | ⏳ Phase 3 |
| 📚 백테스팅 엔진 | `ollama/deepseek-r1:32b` | — | $0 | ⏳ Phase 3 |

**총 예상 월 API 비용: ~$16.5**

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

### 💹 투자팀 v2.0 (Phase 3) — 9 에이전트 구조
> TradingAgents (arXiv:2412.20138) + HedgeAgents (arXiv:2502.13165) 논문 기반 설계

- **투자 메인봇** (펀드매니저): 전체 조율 → 최종 매매 결정 → 실행봇 명령 → 일일 리포트
- **분석가팀 (4명, 병렬)**: 기술분석(Groq 70B) / 감성분석(Gemini) / 온체인(Groq 8B) / 뉴스(Groq 8B)
- **리서처팀 (2명, 토론)**: 강세 리서처 ↔ 약세 리서처 — 합의 의견 도출 (claude-haiku)
- **리스크 매니저**: 포지션 한도·손실 한도 최종 검토 (claude-haiku)
- **바이낸스 실행봇**: USDT 마켓 spot/futures, TP/SL 자동 설정 (LLM 없음)
- **업비트 실행봇**: KRW 마켓 현물 거래 (LLM 없음)
- **백테스팅 엔진**: 전략 파라미터 최적화, 샤프비율/MDD 검증 (deepseek-r1 로컬)
- **3가지 회의 체계**: 정기(5분) / 경험공유(22:00) / 긴급(±5% 급락 자동 소집)

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
