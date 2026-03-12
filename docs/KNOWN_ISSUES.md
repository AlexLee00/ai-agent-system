# 알려진 이슈

> 현재 알려진 문제와 해결 상태 추적

---

## 🔴 미해결

| ID | 컴포넌트 | 이슈 | 발견일 | 우선순위 |
|----|----------|------|--------|---------|
| ~~KI-001~~ | ~~workspace-git.js~~ | ~~`.gitignore`에 `*.key` 패턴 없어서 warn 발생~~ | ~~2026-03-06~~ | ✅ 해결됨 (2026-03-07) |
| ~~KI-002~~ | ~~archer.js~~ | ~~`trackTokens()` 미적용 — LLM 비용 미추적~~ | ~~2026-03-06~~ | ✅ 해결됨 (2026-03-07) |
| ~~KI-003~~ | ~~bots/investment~~ | ~~npm audit high 5건: duckdb→node-gyp→tar 빌드타임 의존성~~ | ~~2026-03-06~~ | ✅ 해결됨 (2026-03-07) — PostgreSQL 마이그레이션으로 duckdb 제거 |

---

## 🟡 모니터링 중

| ID | 컴포넌트 | 이슈 | 발견일 | 상태 |
|----|----------|------|--------|------|
| KI-003 | 루나팀 | KIS PAPER 30일 검증 미완 | 2026-03-03 | 매일 로그 모니터링 |
| KI-004 | 전체 | 맥미니 이전 전 맥북 단일 서버 리스크 | 2026-03-03 | launchd KeepAlive로 완화 |
| KI-005 | 스카팀 kiosk-monitor | Navigation timeout (Puppeteer) 간헐적 발생 | 2026-03-11 | exit 1 → launchd 재기동으로 자동 복구 중 |
| KI-006 | 스카팀 naver-monitor | launchd PID 16035 SIGKILL(-9) 상태 유지 | 2026-03-12 | 재시작 필요 (수동 또는 다음 세션) |
| KI-007 | 스카팀 cancelled_keys | 010-3397-3384, 010-7184-8299, 010-2802-8575 2건 — Picco 취소 실패로 계속 감지됨 | 2026-03-12 | 실제는 픽코 미등록 건. cancelled_keys 정리 필요 |

---

## ✅ 해결됨

| ID | 컴포넌트 | 이슈 | 해결일 | 해결 방법 |
|----|----------|------|--------|----------|
| KI-F01 | openclaw.js | IPv6 `[::1]` 파싱 버그 → false positive CRITICAL 알림 | 2026-03-06 | bracket notation 파싱 추가 |
| KI-F02 | dexter-quickcheck.js | v2 openclaw lsof 체크 false positive | 2026-03-06 | 중복 체크 제거 (launchd 충분) |
| KI-F03 | test-nlp-e2e.js | 스크립트 경로 `src/` 고정 → 파일 이동 후 0/27 실패 | 2026-03-06 | `SCRIPT_DIRS` 매핑 + resolveScript() |
| KI-F04 | 덱스터 | npm_audit false positive (duckdb→tar 취약점) | 2026-03-06 | `--clear-patterns --label=npm_audit` 이력 삭제 |
| KI-F05 | 스카 | 네이버 홈화면 복귀 문제 | 2026-03-03 | 현재 방식 유지 (낮은 우선순위) |
| KI-F06 | deps.js | `cfg.BOTS.invest` 오타 → npm audit 루나팀 cwd 오탐 | 2026-03-07 | `cfg.BOTS.investment` 수정 |
| KI-F07 | daily-report.js | `cfg.BOTS/DBS.invest` 오타 → dexter daily exit 1 | 2026-03-07 | `cfg.BOTS/DBS.investment` 수정 |
| KI-F08 | run-forecast.sh | macOS mktemp `.txt` 확장자 고정 파일명 버그 | 2026-03-07 | `XXXXXX` 패턴으로 수정 |
| KI-F09 | archer/analyzer.js | logLLMCall 미연동 → 아처 LLM 비용 미추적 | 2026-03-07 | logLLMCall 연동 추가 |
| KI-F10 | 전체 | DuckDB npm 취약점 (KI-003) + SQLite/DuckDB 2종 DB 분산 운영 복잡성 | 2026-03-07 | PostgreSQL 17 단일 DB로 통합 (4개 스키마: claude/reservation/investment/ska) |
