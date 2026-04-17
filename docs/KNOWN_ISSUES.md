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
| KI-008 | loadPreScreenedFallback | 파일 기반 폴백 → RAG 전환 미완료 | 2026-03-11 | 보류 — 루나 노드화 Phase에서 처리 예정 |
| KI-009 | groq-sdk | Breaking change로 업그레이드 보류 중 | 2026-03-13 | 사용자 확인 후 별도 세션 처리 필요 |
| KI-010 | 스카팀 LLM | llama-4-scout 464ms — gpt-oss-20b 152ms 대비 3배 느림 | 2026-03-12 | 교체 검토 중 (gpt-oss-20b 또는 llama-3.1-8b) |
| KI-011 | 스카 shadow 비교 | `forecast_results`에 shadow 저장은 시작됐지만 actual 누적이 부족해 `shadowComparison.availableDays = 0` | 2026-03-18 | 며칠간 관찰 후 `primary vs shadow` 비교 시작 |
| KI-012 | 일일 운영 분석 자동화 | 일부 자동화 런타임에서 `health-report.js` 직접 실행 실패로 `fallback_probe_unavailable`이 발생 | 2026-03-18 | `daily-ops-report.js`로 보수 처리 중, 입력 안정화 추가 필요 |
| KI-013 | 워커 문서 재사용 품질 | 문서 재사용 이력과 결과 연결은 완료됐지만 수정량/품질 점수는 아직 없음 | 2026-03-18 | 재사용 후 수정량/확정률 분석 단계 예정 |
| KI-014 | 워커 모니터링 | LLM API 선택값은 저장되지만 변경 이력/호출 통계는 아직 없음 | 2026-03-18 | 운영 이력과 호출량 집계 후속 필요 |
| KI-015 | 투자 legacy 실패 이력 | 과거 `legacy_*` 실패는 일부만 구조화되어 `block_code`, `block_meta` 백필이 완전하지 않음 | 2026-03-18 | backfill 구조화 후속 필요 |
| KI-016 | SkaSupervisor | `bots/ska/scripts/log-report.js` JS→TS 전환 시 삭제됐으나 .ts 미생성. PortAgent 비활성화 상태 | 2026-04-17 | log-report.ts 재작성 필요 (launchd owner 없음) |
| KI-017 | ClaudeSupervisor | `bots/claude/scripts/speed-test.js` JS→TS 전환 시 삭제됐으나 .ts 미생성. PortAgent 비활성화 상태 | 2026-04-17 | speed-test.ts 재작성 필요 |
| ~~KI-018~~ | ~~다윈팀~~ | ~~autonomy-level L3 강등 (output_path_not_allowed:prototypes/ 에러)~~ | ~~2026-04-17~~ | ✅ 해결됨: implementor.ts prototypes/ 허용 + L4 리셋 (d8d42ab3) |

---

## 🔐 보안 감사 발견 (1차, 2026-04-17)

> 메티가 Desktop Commander로 OPS 소스 직접 분석하여 확인.
> 패치 프롬프트: `docs/codex/CODEX_SECURITY_AUDIT_01.md`

| ID | 심각도 | 컴포넌트 | 이슈 | 발견일 | 상태 |
|----|-------|----------|------|--------|------|
| SEC-001 | 🔴 HIGH | `bots/hub/src/hub.ts` | Hub `app.listen(PORT, '0.0.0.0')` — 전략 §9-2(loopback만 바인딩) 위반. lsof로 `*:7788` 확인됨. Bearer Token은 있으나 네트워크 레이어 방어 부재 | 2026-04-17 | ✅ 패치 완료 (커밋 `578260b2`, BIND_HOST 환경변수화) |
| SEC-002 | 🟡 MEDIUM | `bots/investment/config.yaml` | Public Git 리포에 실 KIS 계좌번호 및 USDT 지갑주소가 커밋됨. OSINT 공격 표면 | 2026-04-17 | ✅ 패치 완료 (working tree 제거 + secrets-store 이관 + 원격 히스토리 재작성 완료) |
| SEC-003 | 🟢 LOW-MED | `bots/hub/lib/sql-guard.ts` | 블랙리스트 방식. `pg_read_file`, `pg_ls_dir`, `dblink` 등 PostgreSQL 위험 함수 미차단. 주석(`--`, `/* */`) 기반 우회 가능성 | 2026-04-17 | ✅ 패치 완료 (SQL guard 강화 + readonly PG 풀 + live `hub_readonly@jay` 검증 완료) |
| SEC-004 | 🟡 MEDIUM | `bots/investment/team/hephaestos.ts:1535` | `executeSignal()`가 signal을 받을 때 네메시스 승인 여부(`nemesis_verdict`, `approved`, 타임스탬프 등) 재검증 가드 없음. 스크립트 직접 호출 시 네메시스 우회 가능 | 2026-04-17 | ✅ 패치 완료 (커밋 `3666d579`, `1ddcafbe` — BUY가드+SELL예외+stale체크+전경로nemesis_verdict주입) |
| SEC-005 | 🔴 CRITICAL | `docs/codex/CODEX_SECURITY_AUDIT_01.md` | `.gitignore`에 `docs/codex/` 등록됐으나 **이미 추적 중인 파일에는 효과 없음**. 커밋 `578260b2`에서 이 파일이 추가되면서 KIS 계좌번호(2건)와 USDT 주소(1건)가 Public Git에 노출. SEC-002 완전 무효화 수준 | 2026-04-17 | ✅ 패치 완료 (커밋 `1954bc76`+`4503d920` — 완전 격리. 마스터 히스토리 정리 + Elixir 브랜치 삭제로 종결) |
| SEC-006 | 🟡 MEDIUM | `bots/investment/shared/kis-client.ts:140` | `/tmp/kis-token-{paper,live}.json`에 access_token 평문 저장. `fs.writeFileSync` 권한 미지정 → umask 0022 기본 644. 24시간 유효 토큰 탈취 시 실매매 가능 | 2026-04-17 | ✅ 패치 완료 (토큰 캐시 600 강제 저장/보정) |
| SEC-007 | 🟢 LOW-MED | `bots/investment/shared/kis-client.ts:137,197` | 토큰 발급 실패·API 오류 시 KIS 서버 response body 전체가 Error 메시지로 전파. Sentry/telegram 등 상위 로깅으로 유출 잠재 통로 (실질 리스크 낮음) | 2026-04-17 | ✅ 패치 완료 (KIS 오류 메시지 최소화, msg_cd/msg1만 노출) |
| SEC-008 | 🟡 MEDIUM | `bots/investment/shared/upbit-client.ts:171` + `luna-commander.cjs:511` | `withdrawUsdtToAddress`가 실자금 출금 함수인데 cap·화이트리스트·승인 없음. `luna-commander`의 `HANDLERS.upbit_withdraw_only`가 외부 command 입력으로 트리거 가능 | 2026-04-17 | ⏳ 프롬프트 작성 (CODEX_SECURITY_AUDIT_03 Task 3) — 8차 세션 발견 |
| SEC-009 | 🟢 LOW | `bots/investment/shared/secrets.ts:207` | `secrets.json` 폴백 로드 시 파일 권한 미검증. Hub API 실패 시만 트리거되므로 실질 리스크 낮음. 로컬에 secrets.json 파일 부재 확인 (gitignore 보호) | 2026-04-17 | ✅ 패치 완료 (fallback 로드 전 600 권한 점검/보정) |
| SEC-010 | 🟢 LOW-MED | `bots/investment/shared/secrets.ts:235` | `hostname().includes('MacStudio')` 기반 live 차단. hostname은 이론상 변경 가능 but OPS 접근 자체가 필요하므로 실질 리스크 매우 낮음 | 2026-04-17 | ⬜ 9차 세션 발견 (OPS 접근 통제 강화로 우회 어려움, 우선순위 후순위) |
| SEC-011 | 🟢 LOW | `bots/investment/shared/secrets.ts:642` | `hasKisApiKey`가 `length > 5`만 검증. 실제 KIS 키는 36자 이상이므로 dummy/test 값이 통과할 수 있음 | 2026-04-17 | ✅ 패치 완료 (`length >= 16` 상향) |
| SEC-012 | 🟡 MEDIUM | `bots/orchestrator/src/router.ts:2096` (case 'upbit_withdraw') | Telegram `chat_id` 화이트리스트만으로 출금 가능. 세션 탈취 시 2차 인증 없이 자금 유출. **SEC-008의 3중 가드가 이 경로도 커버** → 실질적으로 같은 해결책 | 2026-04-17 | ⬜ 9차 세션 발견 (SEC-008 패치와 함께 자동 해결) |

---

## ✅ 해결됨

| ID | 컴포넌트 | 이슈 | 해결일 | 해결 방법 |
|----|----------|------|--------|----------|
| KI-F01 | openclaw.js | IPv6 `[::1]` 파싱 버그 → false positive CRITICAL 알림 | 2026-03-06 | bracket notation 파싱 추가 |
| KI-F05 | seed-three-teams.js | hermes 이름 충돌 — 기존 뉴스분석가와 새 스캘핑 실행 동명 | 2026-04-03 | hermes→swift 이름 변경 (a4ec4ce) |
| KI-F06 | hiring-contract.js | selectBestAgent 팀 격리 미흡 — 시그마팀 요청에 루나팀 에이전트 선택 | 2026-04-03 | team 주어지면 getAgentsByTeam 우선 (a4ec4ce) |
| KI-F07 | seed-three-teams.js | 새 role(analyst_short/long/watcher 등) exact match 실패 | 2026-04-03 | 7개 role → analyst 정규화 + DB UPDATE |
| KI-F08 | trade-journal-db.js | 에이전트 이름 하드코딩 컬럼(aria_signal/hermes_accurate) | 2026-04-03 | JSONB 동적 구조 전환 (Phase B-1 완료) |
| KI-F02 | dexter-quickcheck.js | v2 openclaw lsof 체크 false positive | 2026-03-06 | 중복 체크 제거 (launchd 충분) |
| KI-F03 | test-nlp-e2e.js | 스크립트 경로 `src/` 고정 → 파일 이동 후 0/27 실패 | 2026-03-06 | `SCRIPT_DIRS` 매핑 + resolveScript() |
| KI-F04 | 덱스터 | npm_audit false positive (duckdb→tar 취약점) | 2026-03-06 | `--clear-patterns --label=npm_audit` 이력 삭제 |
| KI-F05 | 스카 | 네이버 홈화면 복귀 문제 | 2026-03-03 | 현재 방식 유지 (낮은 우선순위) |
| KI-F06 | deps.js | `cfg.BOTS.invest` 오타 → npm audit 루나팀 cwd 오탐 | 2026-03-07 | `cfg.BOTS.investment` 수정 |
| KI-F07 | daily-report.js | `cfg.BOTS/DBS.invest` 오타 → dexter daily exit 1 | 2026-03-07 | `cfg.BOTS/DBS.investment` 수정 |
| KI-F08 | run-forecast.sh | macOS mktemp `.txt` 확장자 고정 파일명 버그 | 2026-03-07 | `XXXXXX` 패턴으로 수정 |
| KI-F09 | archer/analyzer.js | logLLMCall 미연동 → 아처 LLM 비용 미추적 | 2026-03-07 | logLLMCall 연동 추가 |
| KI-F10 | 전체 | DuckDB npm 취약점 (KI-003) + SQLite/DuckDB 2종 DB 분산 운영 복잡성 | 2026-03-07 | PostgreSQL 17 단일 DB로 통합 (4개 스키마: claude/reservation/investment/ska) |
| KI-F11 | llm-client.js | callOpenAIMini() 최종 폴백 누락 → 폴백 체인 미완성 | 2026-03-11 | ✅ 수정 완료 (2026-03-12) — 폴백 체인 완성 |
| KI-F12 | screening-monitor.js | 파일 기반 상태 관리 → DB 기반으로 전환 필요 | 2026-03-11 | ✅ 수정 완료 (2026-03-13) — DB 기반으로 전환 |
| KI-F13 | star.js | XSS escapeHtml 미적용 — 블로그 HTML 출력 취약 | 2026-03-11 | ✅ 수정 완료 (2026-03-13) — escapeHtml 적용 |
| KI-F14 | gemini 클라이언트 | maxTokens 4096 하드코딩 — 장문 출력 제한 | 2026-03-11 | ✅ 수정 완료 (2026-03-13) — 12000으로 수정 |
