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
| 💹 투자 메인봇 | `claude-sonnet-4-6` | `gemini-2.0-flash` | (메인봇 공유) | ⏳ Phase 3 |
| ⚡ 바이낸스 실행봇 | LLM 없음 (규칙 기반) | — | $0 | ⏳ Phase 3 |
| 🔍 리서치봇 (시장 정보) | `gemini-2.0-flash` | `openrouter/auto` | ~$2 | ⏳ Phase 3 |
| 📚 백테스팅 엔진 | `ollama/deepseek-r1:32b` | — | $0 | ⏳ Phase 3 |

**총 예상 월 API 비용: ~$16**

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
│  ┌─────────────────────────────────────────┐    │
│  │  💹 투자 메인봇   claude-sonnet-4-6      │    │
│  │  - 신호 종합 → 매매 의사결정             │    │
│  │  - 리스크 관리 (포지션 한도, 손실 한도)  │    │
│  │  - 일일 22:00 수익률 리포트              │    │
│  └───────┬──────────────┬───────────────────┘    │
│          │              │              │          │
│          ▼              ▼              ▼          │
│  ┌─────────────┐ ┌──────────┐ ┌──────────────┐  │
│  │⚡바이낸스   │ │🔍리서치봇 │ │📚백테스팅엔진│  │
│  │실행봇       │ │gemini    │ │deepseek-r1  │  │
│  │(LLM 없음)  │ │-flash    │ │:32b (로컬)  │  │
│  │Binance API  │ │커뮤니티  │ │전략최적화   │  │
│  │spot/futures │ │기술지표  │ │매주 일요일  │  │
│  │TP/SL 자동  │ │온체인    │ │자동 실행    │  │
│  └─────────────┘ └──────────┘ └──────────────┘  │
└─────────────────────────────────────────────────┘
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

### 💹 투자팀 (Phase 3)
- **투자 메인봇**: 신호 종합 → 매매 의사결정 → 일일 리포트
- **바이낸스 실행봇**: spot/futures, TP/SL 자동 설정, 안전장치
- **리서치봇**: 기술지표(RSI·MACD·볼린저) + 커뮤니티 감성 + 온체인 지표
- **백테스팅 엔진**: 전략 파라미터 최적화, 샤프비율/MDD 기준 검증

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
