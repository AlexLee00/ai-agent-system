# 🤖 AI Agent System

맥북프로 M1 Pro 기반 멀티 에이전트 AI 봇 시스템 | v4.0 (2026-03-08)

---

## 봇 현황 (2026-03-08 기준)

| 팀 | 봇 | LLM | 상태 |
|----|-----|-----|------|
| 클로드팀 | 클로드 (팀장) | claude-sonnet-4-6 | ✅ OPS — agent_tasks 기반 |
| 클로드팀 | 덱스터 (시스템 점검) | — (규칙 기반) | ✅ OPS — Phase 3 완료 |
| 클로드팀 | 독터 (자동 복구) | — | ✅ OPS — 태스크 폴링 |
| 클로드팀 | 아처 (기술 인텔리전스) | claude-sonnet-4-6 | ✅ OPS — 매주 월 09:00 |
| 스카팀 | 스카 (예약관리 메인봇) | gemini-2.5-flash / haiku-4-5 | ✅ OPS |
| 스카팀 | 앤디 (네이버 모니터) | — | ✅ OPS — 5분 주기 |
| 스카팀 | 지미 (키오스크 모니터) | — | ✅ OPS — 30분 주기 |
| 스카팀 | 레베카 (매출 분석) | claude-sonnet-4-6 | ✅ OPS — 일일 |
| 스카팀 | 이브 (환경요소 수집) | — | ✅ OPS — 일일 |
| 루나팀 | 루나 (팀장) | Groq Scout | ✅ OPS — 시그널 융합 |
| 루나팀 | 네메시스 (리스크 매니저) | Groq/Gemini | ✅ OPS — 동적 TP/SL |
| 루나팀 | 헤파이스토스 (실행봇) | — | ✅ OPS — 자본 관리 |
| 루나팀 | 분석팀 7명 (아리아/오라클/헤르메스/소피아/제우스/아테나/한울) | Groq Scout | ✅ OPS — confidence score |
| 루나팀 | Phase 0 (제이슨/루나 DEV) | Haiku 4.5 | 🔧 DEV — 10분 주기 |

**총 월 API 비용 추정: ~$1~3 (바이낸스 LIVE 실거래, Groq 무료 위주)**

---

## 전체 아키텍처

```
👤 사용자 (텔레그램)
    │
    ├── 스카봇 (예약관리 자동화)
    │    ├── 앤디: 네이버 5분 모니터링 → 픽코 자동 등록/취소/차단
    │    ├── 지미: 키오스크 30분 감지 → 네이버 예약불가 자동 제어
    │    ├── 레베카: 매출·예측 분석 (일일 리포트)
    │    └── 이브: 공휴일·날씨·학사·축제 수집
    │
    ├── 루나팀 (자동매매 — Phase 3)
    │    ├── 아리아: TA 분석 (RSI/MACD/BB/Stoch/ATR)
    │    ├── 오라클: 온체인 (공포탐욕/펀딩비/Long-Short)
    │    ├── 헤르메스: 뉴스 분석
    │    ├── 소피아: 감성 분석
    │    ├── 제우스↔아테나: 강세/약세 토론
    │    ├── 루나: 최종 신호 판단 (Haiku)
    │    ├── 네메시스: 리스크 매니저 (Haiku)
    │    ├── 헤파이스토스: 바이낸스 Spot 실행 [LIVE]
    │    └── 한울: KIS 국내+해외주식 실행 [PAPER]
    │
    └── 클로드팀 (시스템 유지보수)
         ├── 덱스터: 9개 체크 모듈 점검 + 자동수정 + 일일 보고
         └── 아처: AI/LLM 트렌드 서칭 + PATCH_REQUEST.md 오케스트레이션
```

---

## 프로젝트 구조

```
ai-agent-system/
├── CLAUDE.md                     # Claude Code 세션 규칙 (PATCH_REQUEST.md 처리)
├── PATCH_REQUEST.md              # 아처 자동 생성 — Claude Code 세션 시작 시 처리
├── bots/
│   ├── registry.json             # 전체 봇 등록부
│   ├── claude/                   # 클로드팀 (덱스터 + 아처)
│   │   ├── src/                  # dexter.js / archer.js
│   │   ├── lib/
│   │   │   ├── team-bus.js       # 덱스터↔아처 통신 버스 (claude-team.db)
│   │   │   ├── archer/           # config/fetcher/analyzer/patcher/reporter
│   │   │   └── checks/           # 9개 체크 모듈 + ska.js
│   │   ├── migrations/           # 001_team_bus.js (claude-team.db)
│   │   ├── scripts/              # migrate.js / team-status.js / patch-status.js
│   │   └── reports/              # 주간 리포트 + patches/ 티켓
│   ├── reservation/              # 스카팀 (OPS)
│   │   ├── auto/monitors/        # naver-monitor(앤디) + pickko-kiosk-monitor(지미)
│   │   ├── auto/scheduled/       # daily-summary / audit / pay-scan
│   │   ├── manual/reservation/   # pickko-accurate/cancel/register/query
│   │   ├── manual/admin/         # pickko-member/ticket/verify
│   │   ├── manual/reports/       # occupancy/alerts/stats/revenue
│   │   ├── lib/                  # db/pickko/state-bus/crypto 등 공유 모듈
│   │   └── migrations/           # 001_initial / 002_daily_summary / 003_agent_state
│   ├── investment/               # 루나팀 Phase 3-A (ESM, config.yaml)
│   │   ├── team/                 # aria/oracle/hermes/sophia/zeus/athena/luna/nemesis/hephaestos/hanul
│   │   ├── markets/              # crypto.js / domestic.js / overseas.js
│   │   └── shared/               # db/llm-client/secrets/cost-tracker/report
│   ├── invest/                   # 루나팀 Phase 0 (레거시 DEV)
│   └── ska/                      # 레베카·이브 (Python 3.12)
├── packages/
│   ├── core/                     # @ai-agent/core
│   └── playwright-utils/         # @ai-agent/playwright-utils
└── docs/
    ├── work-history.md            # 날짜별 작업 타임라인
    ├── coding-guide.md            # 개발 가이드 (P0~P4)
    ├── SYSTEM_DESIGN.md           # 전체 설계서
    └── LLM_DOCS.md               # LLM API 참조
```

---

## 클로드팀 운영 명령

```bash
cd bots/claude

# 덱스터 (시스템 점검)
npm run dexter              # 기본 점검 (9개 체크)
npm run dexter:full         # 전체 점검 + npm audit
npm run dexter:fix          # 자동 수정 + 텔레그램 알림
npm run dexter:daily        # 일일 보고 (텔레그램)

# 아처 (기술 인텔리전스)
npm run archer              # 데이터 수집 + Claude 분석
npm run archer:telegram     # 분석 + 텔레그램 + PATCH_REQUEST.md
npm run archer:fetch-only   # 수집만 (디버그)

# 팀 상태 관리
npm run migrate             # claude-team.db 마이그레이션
npm run status              # 팀 상태 대시보드
npm run patch:status        # PATCH_REQUEST.md + 패치 이력
```

---

## launchd 서비스 목록

### 클로드팀

| 서비스 | 역할 | 주기 |
|--------|------|------|
| `ai.claude.dexter` | 덱스터 시스템 점검 + 자동수정 | 1시간 |
| `ai.claude.dexter.daily` | 덱스터 일일 보고 (텔레그램) | 08:00 KST |
| `ai.claude.archer` | 아처 기술 인텔리전스 + 패치 오케스트레이션 | 매주 월 09:00 KST |

### 스카팀

| 서비스 | 역할 | 주기 |
|--------|------|------|
| `ai.openclaw.gateway` | OpenClaw LLM 게이트웨이 (gemini-2.5-flash) | KeepAlive |
| `ai.ska.naver-monitor` | 앤디 — 네이버 5분 모니터링 | KeepAlive |
| `ai.ska.kiosk-monitor` | 지미 — 키오스크 30분 감지 | KeepAlive |
| `ai.ska.pickko-verify` | 픽코 검증 | 08:00/14:00/20:00 |
| `ai.ska.pickko-daily-summary` | 일일 예약 요약 | 09:00 / 00:00 |
| `ai.ska.pickko-daily-audit` | 일일 감사 | 00:00/22:00/23:00 |
| `ai.ska.health-check` | 헬스체크 | 30분 |
| `ai.ska.etl` | ETL 데이터 동기화 | 매시 |
| `ai.ska.rebecca` | 레베카 매출 분석 | 일일 |
| `ai.ska.eve` | 이브 환경요소 수집 | 일일 |
| `ai.ska.forecast-daily` | 일별 예측 | 일일 |

### 루나팀

| 서비스 | 역할 | 모드 |
|--------|------|------|
| `ai.investment.crypto` | 크립토 사이클 (아리아~헤파이스토스) | 🔴 LIVE |
| `ai.investment.domestic` | 국내주식 사이클 (한울 KIS) | 🟡 PAPER |
| `ai.investment.overseas` | 해외주식 사이클 (한울 KIS 해외) | 🟡 PAPER |
| `ai.invest.dev` | Phase 0 신호집계 (제이슨) | 🔧 DEV |
| `ai.invest.fund` | Phase 0 펀드매니저 (루나) | 🔧 DEV |

---

## 최근 변경 (2026-03-08)

- 루나팀: 자본 관리 완전체 (capital-manager.js — 잔고 체크/포지션 사이징/서킷 브레이커)
- 루나팀: 시그널 융합 + LLM 자기반성 주간 리뷰 (confidence score 기반 가중 의사결정)
- 루나팀: 네메시스 동적 TP/SL Phase 2 실적용
- 루나팀: 분석팀 확장 (소피아 Fear&Greed + 아리아 MTF)
- 루나팀: LLM 재시도 + 시맨틱 캐싱 (Groq Scout 전용)
- 클로드팀: 덱스터 Phase 2~3 완전체 (클로드 팀장 → 독터 역할 분리, Emergency 폴백)
- 스카팀: 에러 핸들링 보강 (state-bus/pickko)
- n8n: 6개 워크플로우 (팀 제이 3 + 스카 3) + fan-out → 순차 체인 전환
- RAG: pgvector 마이그레이션 + 자동 수집 파이프라인 (Python rag-system deprecated)
- 코어: pg-pool 자동 재연결 + telegram Rate Limit/Throttle/배치

---

## 구축 단계

| Phase | 내용 | 상태 |
|-------|------|------|
| **Phase 1** | 스카팀 OPS + SQLite + 공유 인프라 + iPad 접속 | ✅ 완료 |
| **Phase 1-B** | 스카팀 고도화 v3.0 (폴더구조·state-bus·덱스터 ska 체크) | ✅ 완료 (2026-03-03) |
| **Phase 2** | 클로드팀 구축 (덱스터 Phase 3 + 아처 v2.0 + 독터 + 팀장) | ✅ 완료 (2026-03-08) |
| **Phase 3-A** | 루나팀 크립토 LIVE 자동매매 (바이낸스 Spot + 자본관리) | ✅ OPS (2026-03-08) |
| **Phase 3-B** | 루나팀 국내외주식 PAPER (KIS) | 🧪 PAPER 검증 중 |
| **Phase 3-C** | 루나팀 국내외주식 LIVE 전환 | ⏳ 30일 PAPER 검증 후 |
| **Phase 4** | 맥미니 M4 Pro 이전 + 비서봇·업무봇·학술봇 | ⏳ 맥미니 도착 후 (4월 중순) |

---

## iPad SSH 접속

```bash
# Termius SSH
로컬:      192.168.45.176:22
외부(Tailscale): 100.124.124.65:22

# 유용한 alias
ska       # 스카봇 전용 작업
skalog    # 스카 OPS 로그
skastatus # launchd 스카 서비스 상태
bootlog   # 스카 BOOT 시간 확인
```

---

## 맥북 재부팅 절차

```bash
# 재부팅 전 (자동화)
bash scripts/pre-reboot.sh

# 재부팅 후 약 65초 내 텔레그램 상태 알림 자동 수신
tail -f /tmp/post-reboot.log  # 수동 확인

# 클로드팀 수동 재시작
launchctl kickstart -k gui/$UID/ai.claude.dexter
launchctl kickstart -k gui/$UID/ai.claude.dexter.daily
```

---

[전체 설계서 → docs/SYSTEM_DESIGN.md](./docs/SYSTEM_DESIGN.md)
