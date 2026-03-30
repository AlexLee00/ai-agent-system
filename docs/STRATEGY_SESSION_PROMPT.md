# 팀 제이 — 전략 기획 세션 프롬프트 (2026-03-30 업데이트)

> 이전 채팅에서 전환됨. 프로젝트 지식 파일 참조.
> Desktop Commander: 맥 스튜디오 (Alexui-MacStudio.local) 연결
> Tailscale: 맥 스튜디오(REDACTED_TAILSCALE_IP) ↔ 맥북 에어(100.66.201.86)

---

## 역할 원칙 (불변)

- **메티(Meti)** = 기획 + 설계 + 코드 점검. 코드 직접 수정 절대 금지.
- **코덱스(Codex)** = 프롬프트 기반 코드 구현.
- 모든 구현은 **맥북 에어(DEV)**에서 진행.
- OPS 직접 수정 필요 시: 메티 명시 → 프롬프트 → 코덱스 → 메티 검증 → 마스터 승인.
- 참조: `docs/ROLE_PRINCIPLES.md`

---

## 완료된 성과 요약

### Tier 0 — ✅ 전부 완료 (2026-03-28)

* P1 코드 수정 7/7 + PnL 보정 0건 MISMATCH
* P1-10 EXIT 전용 경로: 구현 + 검증 완료 (SELL 4건, LIVE 2건 normal_exit)
* 맥 스튜디오 운영 전환 + 재부팅 테스트 + 전 팀 정상 가동
* GitHub Public 전환 + BFG 보안 정리 + API 키 재발급
* 배포 체계 (deploy.sh cron 5분 + GitHub Actions CI)
* n8n 자격증명 복구 + secrets.json 이관 + OpenClaw 복구
* naver-monitor 정상 가동 확인

### Tier 1 — ✅ 5/5 완료 (2026-03-28)

* 루나팀: 최소 거래 수량 스킵 처리 (skipped_below_min)
* 루나팀: sentinel 래퍼 (sophia+hermes → SENTINEL 통합)
* 루나팀: EXIT 결과 → ENTRY 연결 (reclaimed USDT 컨텍스트)
* 공통 모듈 추출 (packages/core/lib/telegram + db)
* 클로드팀: Dexter heartbeat 모니터링

### DEV↔OPS 환경 분리 — ✅ 완료 (2026-03-29~30)

* P1: env.js 공용 환경 계층 (MODE/PAPER_MODE/Hub 변수/서비스 플래그)
* P2: CI/CD (deploy job + smart-restart.sh + .env 체계)
* P3: Resource API Hub (포트 7788, health/pg/n8n/services/env/secrets)
* P4: DEV 셋업 (setup-dev.sh + sync-dev-secrets.sh)
* 맥북 에어 완성: Homebrew + Node 25 + PG 17 + Python 3.12 + Claude Code + SSH
* Tailscale 양방향 연결 (SSH 터널 불필요)

### P5 시크릿 Hub 커넥터 — ✅ Phase A~D 완료 (2026-03-30)

* hub-client.js, llm-keys.js initHubConfig, investment/secrets.js initHubSecrets
* Hub secrets 5카테고리 (llm/telegram/exchange/reservation/config)
* Hub 원본 반환 (paper 강제 제거), OPS trading_mode=live 유지
* ai.env.setup.plist Hub 변수 3개 설정
* Phase D: 에이전트 진입점 Hub 커넥터 연결 완료
* llm-control 서비스 계층 리팩터링 + runtime-config 공용화
* E2E 47/47 통과, 체크리스트 41/42 통과

---

## 현재 시스템 상태

```
전 팀 정상 가동:
  루나팀:  ✅ EXIT 경로 작동, 5분 주기 사이클
  스카팀:  ✅ naver-monitor + 픽코 자동 예약
  클로드팀: ✅ commander + dexter + health-dashboard
  블로팀:  ✅ node server + mark-published API
  워커팀:  ✅ web/nextjs/lead/task-runner
  허브:   ✅ resource-api (uptime 7339s, PG+n8n OK)

인프라:
  맥 스튜디오: 24/7 운영, Hub(:7788), PG, n8n, OpenClaw
  맥북 에어: DEV 환경 완성, Tailscale 연결
  배포: git push → 5분 cron 자동 pull + GitHub Actions CI
  시크릿: Hub 1순위 → 로컬 config.yaml 폴백

네트워크:
  Tailscale: 맥 스튜디오(REDACTED_TAILSCALE_IP) ↔ 맥북 에어(100.66.201.86)
  SSH: 양방향 비밀번호 없이 연결
  Hub: DEV → http://REDACTED_TAILSCALE_IP:7788 (Tailscale 직접)
```

---

## 즉시 해야 할 작업 (이번 주)

```
[ ] P5 Phase E: reservation 진입점 Hub 커넥터 (프롬프트 준비됨: docs/CODEX_PHASE_E_RESERVATION.md)
[ ] config.yaml 물리 통합 (reservation/worker secrets.json 흡수) → Hub 코드 단순화
[ ] n8n 자격증명 재입력 (PostgreSQL+Telegram, UI에서)
[ ] 블로팀: 네이버 실전 발행 1건 확인
[ ] 워커팀: telegram_bot_token 설정
```

---

## 다음 전략 기획 우선순위

### Tier 2 — 2~4주 (기능 확장)

```
[ ] 루나팀 Phase 3: Chronos VectorBT 백테스팅
[ ] 루나팀 Phase 3: 검증 3단계 (Shadow → Confirmation → Live)
[ ] 루나팀 Phase 4: DCA 전략
[ ] Ollama 설치 + RAG 임베딩 로컬 전환 (Mac Studio GPU 활용)
[ ] ComfyUI 설치 + 이미지 비용 $0 전환
[ ] TS Phase 1: TypeScript 강화
```

### Tier 3 — 5~8주 (플랫폼 확장)

```
[ ] 루나팀 Phase 4: 펀딩레이트 + 그리드
[ ] 루나팀 Phase 5: SaaS 확장

[ ] 블로팀 본격 개발 (Node.js 120강 33강 진행 중)
[ ] 비디오팀 Phase 3 (Twick SDK + AI 편집)
[ ] 워커팀 SaaS 개발 재개
[ ] TS Phase 2: Elixir 오케스트레이션
[ ] TS Phase 3: Python 마이크로서비스
[ ] Cloudflare Tunnel + 도메인
[ ] Docker 하이브리드 전략 구현
```

### 운영 이슈 (보류)

```
[!] n8n 자격증명 복호화 에러 → UI에서 재입력 필요
[!] CalDigit TS4 이더넷 미인식 → A/S 예정, WiFi 사용 중
[!] 맥북 프로 M1 Pro → 판매 예정
```

---

## 핵심 참조

```
레포: AlexLee00/ai-agent-system (Public)
DB: /opt/homebrew/opt/postgresql@17/bin/psql -U alexlee -d jay

문서:
  docs/OPUS_FINAL_HANDOFF.md            ← 최종 인수인계
  docs/ROLE_PRINCIPLES.md               ← 역할 분담 원칙 [불변]
  docs/DEV_ENV_SETUP_MACBOOK_AIR.md     ← DEV 셋업 가이드
  docs/CODEX_PHASE_E_RESERVATION.md     ← 다음 코덱스 프롬프트

노션:
  메인 허브: 31fff93a809a81468d84c5f74b3485e4
  루나팀 재설계: 331ff93a809a81cb86e5faebb24faf1d
  소스코드 분석: 325ff93a809a81899098e3b15401b06f
```

---

## 팀 구성

| 팀 | 역할 | 상태 |
|----|------|------|
| 스카팀 | 스터디카페 예약/키오스크 관리 | ✅ 운영 중 |
| 루나팀 | 암호화폐·주식 자동매매 | ✅ 운영 중 (재설계 대기) |
| 클로드팀 | 시스템 모니터링 (Dexter) | ✅ 운영 중 |
| 블로팀 | 네이버 블로그 자동화 | ✅ 기본 운영 (본격 개발 대기) |
| 워커팀 | 비즈니스 관리 SaaS | ✅ 운영 중 |
| 비디오팀 | YouTube 영상 편집 자동화 | 📋 Phase 3 기획 완료 |
| 허브 | Resource API Hub (OPS 프록시) | ✅ 운영 중 |

---

## 변경 이력

| 날짜 | 변경 |
|------|------|
| 2026-03-28 | Tier 0 + Tier 1 완료 |
| 2026-03-29 | DEV↔OPS 환경 분리 (P1~P4) |
| 2026-03-30 | P5 시크릿 Hub 커넥터 + Phase D + Tailscale + 역할 원칙 |
