# DEV_SUMMARY.md - 스카봇 개발 현황 요약

> **목적:** 모델 교체 후 빠른 컨텍스트 복원용. BOOT.md가 자동으로 읽음.
> **최종 업데이트:** 2026-02-26 (야간4)

---

## 🎯 프로젝트 한 줄 요약

**네이버 스마트플레이스 신규/취소 예약 → 픽코 키오스크 자동 동기화 봇 (스카)**
현재 상태: ✅ **OPS 모드 실운영 중 (예약 등록 + 취소 자동화 완료)**

---

## 🏗️ 시스템 구조

```
[네이버 스마트플레이스]
        ↓ 신규 예약 감지 (3분 주기)        ↓ 취소 감지 (리스트 비교 방식)
[naver-monitor.js] ← OPS 모드 실행 중 (PICKKO_CANCEL_ENABLE=1)
        ↓ sendAlert() → .pickko-alerts.jsonl 저장
        ↓ runPickko()                       ↓ runPickkoCancel()
[pickko-accurate.js]               [pickko-cancel.js]
   Stage [1-9] 자동 실행              취소 처리 [1-10]
        ↓                                   ↓
[픽코 키오스크] ← 예약 등록+결제 완료 / 취소 상태 변경
        ↓ Heartbeat (30분 주기)
[Telegram] ← 사장님에게 결과 알람 (new/completed/cancelled/error)
        ↓
[RAG API] ← 예약 이력 저장 (http://localhost:8100)
```

---

## 📁 핵심 파일

| 파일 | 역할 | 상태 |
|------|------|------|
| `src/naver-monitor.js` | 네이버 모니터링 + 픽코 트리거 (등록+취소) | ✅ OPS 실행 중 |
| `src/pickko-accurate.js` | 픽코 자동 예약 Stage [1→1.5→2~9]; [1.5] `syncMemberNameIfNeeded()` — 픽코↔네이버 이름 자동 동기화 (통합 타입 스킵, 비치명적) | ✅ 완성 |
| `src/pickko-cancel.js` | 픽코 자동 취소 Stage [1-10]; [6-B단계] 폴백: 0원/이용중 예약 → 수정→취소→저장; [7-B단계] 폴백: 결제대기 예약 → a.pay_view 없을 시 write→취소→저장 | ✅ 완성 |
| `src/pickko-verify.js` | 미검증 예약 재검증 + 자동 등록 (pending + completed/미검증 모두 포함) | ✅ 완성 |
| `src/pickko-daily-audit.js` | 당일 픽코 등록 사후 감사 (22:00+23:50 launchd) | ✅ 완성 |
| `src/pickko-kiosk-monitor.js` | 키오스크 예약 감지 → 네이버 예약불가 차단 (30분 주기 launchd) | ✅ 신규 완성 |
| `src/pickko-daily-summary.js` | 일일 예약 요약 + 매출 보고 (09:00/00:00 launchd); `--midnight` 플래그로 강제 자정 모드 가능 | ✅ 신규 완성 |
| `src/pickko-revenue-confirm.js` | 매출 컨펌 처리 CLI; 미컨펌 daily_summary → room_revenue 누적 + 텔레그램 발송 | ✅ 신규 완성 |
| `src/pickko-register.js` | 자연어 예약 등록 CLI (stdout JSON) | ✅ 완성 |
| `src/pickko-member.js` | 신규 회원 가입 CLI (stdout JSON) | ✅ 완성 |
| `src/start-ops.sh` | OPS 자동 재시작 루프 + 로그 관리 (1000줄 로테이션) | ✅ 업데이트 |
| `src/run-audit.sh` | pickko-daily-audit 실행 래퍼 (lock + 로테이션) | ✅ 완성 |
| `src/run-kiosk-monitor.sh` | pickko-kiosk-monitor 실행 래퍼 (lock + 로테이션) | ✅ 신규 |
| `lib/db.js` | SQLite 싱글턴 + 스키마 초기화 + 도메인 함수 전체 (reservations/cancelled_keys/kiosk_blocks/alerts/daily_summary/room_revenue); ALTER TABLE 마이그레이션 블록 포함 | ✅ 신규 |
| `lib/pickko-stats.js` | 픽코 매출통계 스크래퍼; fetchMonthlyRevenue/fetchDailyRevenue/fetchDailyDetail (일별 거래 스터디룸/일반 분리) | ✅ 신규 |
| `lib/crypto.js` | AES-256-GCM 암호화/복호화 + SHA256 kiosk 해시 키 (Node.js crypto 내장) | ✅ 신규 |
| `scripts/migrate-to-sqlite.js` | JSON → SQLite 1회 마이그레이션 스크립트 (완료 후 .bak 리네임) | ✅ 신규 |
| `lib/validation.js` | 전화번호/날짜/시간 정규식 변환 | ✅ 24:00 지원 |
| `lib/utils.js` | delay, log (공통 유틸) | ✅ |
| `lib/secrets.js` | loadSecrets() | ✅ |
| `lib/formatting.js` | toKoreanTime, pickkoEndTime, formatPhone | ✅ |
| `lib/files.js` | loadJson, saveJson (원자적 쓰기 tmp→rename) | ✅ |
| `lib/args.js` | parseArgs() | ✅ |
| `lib/browser.js` | getPickkoLaunchOptions, setupDialogHandler | ✅ |
| `lib/pickko.js` | loginToPickko(), fetchPickkoEntries() — 픽코 어드민 일괄 조회 공통 함수 | ✅ |
| `src/bug-report.js` | 버그·유지보수 추적 CLI; HANDOFF_FILE = `context/HANDOFF.md` 직접 참조 (deploy 순서 의존성 제거) | ✅ 수정 |
| `scripts/speed-test.js` | LLM API 속도 테스트 툴 (--apply로 openclaw.json 자동 반영) | ✅ |
| `secrets.json` | 네이버/픽코 로그인 정보 + db_encryption_key(64자 hex) + db_key_pepper | ✅ |

**경로:** `~/projects/ai-agent-system/bots/reservation/`

---

## 📋 개발 완료 단계 (pickko-accurate.js)

| Stage | 기능 | 구현 내용 |
|-------|------|----------|
| [1] 로그인 | 픽코 자동 로그인 | 헤드리스 모드 |
| **[1.5] 이름 동기화** | **픽코↔네이버 회원 이름 자동 수정** | **`syncMemberNameIfNeeded()`: study/write 모달 `li[mb_no]` 추출 → view 페이지 통합 감지 → "회원 정보 수정" 버튼으로 수정. 실패 시 비치명적 스킵** |
| [2] 페이지 이동 | 예약 등록 폼 | URL 직접 이동 |
| [3] 회원 검색 | 전화번호 입력 | 정규식 변환 적용 |
| [4] 회원 선택 | 모달 자동 처리 | 팝업 감지 + 클릭 |
| [5] 날짜 선택 | 날짜 입력 | 하이브리드 방식 |
| [6] 룸/시간 선택 | 시간표 클릭 | **4-Tier Fallback** |
| [7] 저장 | 예약 확인 | 표 기반 데이터 추출 |
| [8] 결제 | 현금 0원 처리 | 자동 결제 |
| [9] 완료 | 성공 확인 | URL 검증 |

**Stage [6] 4-Tier Fallback:**
```
Method-1: li[date][st_no][start][mb_no=""]  ← 가장 엄격
Method-2: li[date][st_no][start]
Method-3: li[st_no][start]
Method-4: li[start] 순회                    ← 최후 수단
```

---

## 🔐 DEV / OPS 모드 (절대 규칙)

```
DEV 모드: 화이트리스트 2명만 테스트
  - 이재룡 (010-3500-0586) 사장님
  - 김정민 (010-5435-0586) 부사장님

OPS 모드: 사장님 협의 후 전환. 모든 고객 번호 처리.
OPS 오류 발생 시: 자동 알람 → DEV 전환 → 재협의 (자체 해결 금지)
```

**OPS 모드 시작 명령:**
```bash
cd ~/projects/ai-agent-system/bots/reservation/src
nohup bash start-ops.sh > /dev/null 2>&1 &
# 로그: /tmp/naver-ops-mode.log (start-ops.sh 내부에서 자동 리디렉션 + 1000줄 로테이션)
```
> ⚠️ start-ops.sh 내부에서 환경변수 자동 설정 (MODE=ops PICKKO_ENABLE=1 OBSERVE_ONLY=0 등)

---

## 🔔 알람 시스템

- `sendAlert()` → `state.db` alerts 테이블 저장 (sent=true/false)
- `cleanupOldAlerts()` → resolved 48시간, 미해결 7일 초과 삭제 (DB prune)
- Heartbeat (30분 주기) → Telegram으로 일괄 전송

**알람 타입:** `new`(신규 감지) | `completed`(픽코 완료) | `cancelled`(취소 완료) | `error`(실패)

## 🗄️ 상태 DB 구조 (2026-02-26 마이그레이션)

**파일:** `~/.openclaw/workspace/state.db` (WAL 모드)

| 테이블 | 용도 | 암호화 |
|--------|------|--------|
| `reservations` | 네이버 예약 상태 추적 (구 naver-seen.json) | phone_raw_enc, name_enc |
| `cancelled_keys` | 취소 처리 중복 방지 키 | - |
| `kiosk_blocks` | 키오스크 예약불가 차단 상태 (구 pickko-kiosk-seen.json) | phone_raw_enc, name_enc |
| `alerts` | 텔레그램 알람 이력 (구 .pickko-alerts.jsonl) | - |
| `daily_summary` | 일별 매출 요약 (total_amount/room_amounts/pickko_total/pickko_study_room/general_revenue/confirmed) | - |
| `room_revenue` | 룸별 확정 매출 누적 (스터디룸A1/A2/B + 일반이용; PK: room+date) | - |

- 암호화: AES-256-GCM, 키 위치: `secrets.json → db_encryption_key`
- kiosk_blocks PK: SHA256(phoneRaw|date|start + pepper) — 전화번호 비노출
- **맥미니 이전 시 복사 대상:** `state.db` + `secrets.json` 2개만

---

## 🧠 RAG 지식 베이스 (2026-02-23 추가)

예약 이력을 자동 저장하고 질문에 답변하는 시스템.

- **서버:** `http://localhost:8100` (FastAPI + ChromaDB)
- **시작:** `cd ~/projects/rag-system && .venv/bin/uvicorn api.main:app --port 8100`
- **Python:** 3.12 전용 (3.14 호환 안됨)
- **임베딩:** ollama/nomic-embed-text
- **질의:** `POST /ask` → Ollama qwen2.5:7b가 RAG 기반 답변 생성

**예약 관련 질문 수신 시 반드시 /ask 먼저 호출:**
```bash
curl -s -X POST http://localhost:8100/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "오늘 예약 현황", "collection": "reservations"}'
```

---

## 🤖 OpenClaw 에이전트 구성 (2026-02-24 업데이트)

| 항목 | 값 |
|------|-----|
| 에이전트 이름 | 스카 (main) |
| 기본 모델 | `google-gemini-cli/gemini-2.5-flash` |
| Fallback 1 | `anthropic/claude-haiku-4-5` |
| Fallback 2 | `ollama/qwen2.5:7b` (느림, 비상용) |
| 채널 | Telegram (@SCAFE8282_BOT) |
| 사장님 chat_id | `***REMOVED***` |
| 워크스페이스 | `~/.openclaw/workspace/` |

**Ollama 주의:** Homebrew 빌드는 M1에서 MLX GPU 가속 안됨 → ~4분 응답, Telegram 봇에 사용 불가.

---

## 📊 개발 타임라인

| 날짜 | 작업 | 결과 |
|------|------|------|
| 2026-02-22 오전 | naver-monitor.js 재작성 | 네이버 파싱 10건 성공 |
| 2026-02-22 오후 | pickko-accurate.js Stage [6] 디버깅 | 4-Tier Fallback 완성 |
| 2026-02-22 21:53 | DEV 모드 전체 테스트 | Stage [1-9] 완전 성공 |
| 2026-02-22 22:00 | OPS/DEV 로직 분리 + 알람 시스템 | 코드 수정 완료 |
| 2026-02-22 23:37 | **OPS 모드 전환** (사장님 협의) | ✅ 실운영 시작 |
| 2026-02-23 오전 | RAG 시스템 구축 | ChromaDB + FastAPI 완성 |
| 2026-02-23 오전 | naver-monitor.js RAG 연동 | 예약 자동 저장 |
| 2026-02-23 오전 | OpenClaw Gemini 모델 전환 | 텔레그램 응답 정상화 |
| 2026-02-23 오전 | BOOT.md 자동 기억 복원 | 게이트웨이 재시작 시 자동 학습 |
| 2026-02-23 오후 | process.exit(0) 버그 수정 | 픽코 성공이 실패로 오인되던 문제 해결 |
| 2026-02-23 오후 | DEV/OPS 데이터 파일 분리 | naver-seen-dev.json / naver-seen.json |
| 2026-02-23 오후 | start-ops.sh 자동 재시작 루프 | cleanup_old() 구 프로세스 정리 포함 |
| 2026-02-23 오후 | naver-monitor.js 락 로직 개선 | 신규 시작 시 구 프로세스 자동 종료 |
| 2026-02-23 오후 | 컨텍스트 관리 시스템 구축 | registry.json + deploy-context.js |
| 2026-02-23 오후 | 자정 자동 보존 시스템 | nightly-sync.sh + launchd |
| 2026-02-23 오후 | **모델 변경 자동 컨텍스트 보존** | BOOT.md 1단계 sync 지시 + 테스트 완료 |
| 2026-02-24 새벽 | **픽코 자동 취소 기능 구현** | pickko-cancel.js 신규, naver-monitor.js 취소 감지 추가 |
| 2026-02-24 새벽 | validation.js 24:00 지원 | end=24:00 입력 허용 (23:00~24:00 마지막 슬롯) |
| 2026-02-24 새벽 | **OPS 취소 기능 활성화** | PICKKO_CANCEL_ENABLE=1, start-ops.sh 재시작 완료 |
| 2026-02-24 새벽 | 취소 감지 → 리스트 비교 방식 전환 | previousConfirmedList + 오늘 취소 탭 이중 감지 |
| 2026-02-24 새벽 | 보안인증 대기 30분 + 텔레그램 알림 | 원격 인증 처리 지원 |
| 2026-02-24 새벽 | 모니터링 주기 3분으로 변경 | NAVER_INTERVAL_MS=180000 |
| 2026-02-24 새벽 | 새로고침 버튼 selector 방식으로 수정 | 좌표 클릭 → btn_refresh selector |
| 2026-02-24 새벽 | Heartbeat 추가 (1시간 주기) | sendTelegramDirect, 09:00~22:00만 전송 |
| 2026-02-24 새벽 | log-report.sh 신규 생성 | 3시간마다 오류 분석 + 텔레그램 리포트 |
| 2026-02-24 새벽 | launchd ai.ska.log-report 등록 | 3시간(10800초) 주기 자동 실행 |
| 2026-02-24 오전 | **공유 라이브러리 리팩토링** | lib/ 7개 신규 (utils/secrets/formatting/files/args/browser/pickko) |
| 2026-02-24 오전 | 중복 코드 220줄 제거 | 4개 src 파일 → lib/ 추출, 문법 검사 통과, 봇 재시작 확인 |
| 2026-02-24 오전 | **pickko-verify 자동 스케줄링** | run-verify.sh + launchd ai.ska.pickko-verify (08:00/14:00/20:00) |
| 2026-02-24 낮 | 야간 알림 차단 + flushPendingAlerts | 09:00 첫 Heartbeat 시 보류 알림 일괄 발송 |
| 2026-02-24 낮 | CLAUDE_NOTES.md 시스템 구축 | 클로드→스카 전달 채널 파일 신규 |
| 2026-02-24 오후 | 모델 교체 | gemini-2.0-flash → gemini-2.5-flash |
| 2026-02-25 | **신규 스크립트 3종** | pickko-daily-audit, pickko-register, pickko-member 완성 + 테스트 |
| 2026-02-25 | **안정화 8건** | atomic write, rollback, pruneSeenIds, 사이클타임, 슬롯 3회 재시도 등 |
| 2026-02-25 | pickko-verify needsVerify() | completed+paid/auto 항목도 안전하게 검증 처리 |
| 2026-02-26 | **JSON → SQLite 마이그레이션 + 개인정보 암호화** | state.db 단일 파일, AES-256-GCM 암호화, 6개 JSON → 4개 DB 테이블 통합 |
| 2026-02-26 야간 | **pickko-daily-summary.js 신규** | 09:00 예약현황 / 00:00 마감 매출+컨펌 요청, fetchPickkoEntries(결제완료+endDate) + calcAmount(A1/A2 3500원, B 6000원/30분) |
| 2026-02-26 야간4 | **픽코 매출 분리 구현** | lib/pickko-stats.js 신규(fetchDailyDetail), daily_summary 테이블 pickko_total/pickko_study_room/general_revenue 추가, 00:00 보고에 일반이용 매출 표시, room_revenue 컨펌 시 일반이용 포함 |
| 2026-02-26 | **session-close 라이브러리 구축** | scripts/lib 모듈화 외 2건 |
| 2026-02-26 | **매출 통계 자연어 명령 추가 (pickko-stats-cmd.js)** | pickko-stats-cmd.js 신규: 날짜/주/월/누적 매출 조회 외 2건 |
| 2026-02-26 | **자연어 명령 E2E 테스트 + 통합 매핑 추가** | test-nlp-e2e.js 신규: 27케이스 100% 통과 외 1건 |
| 2026-02-26 | **텔레그램 알람 불가 처리 (pending queue)** | lib/telegram.js pending-telegrams.jsonl 대기큐, flushPendingTelegrams(), naver-monitor 시작 시 자동 재발송 |
| 2026-02-27 | **전체 시스템 공유 인프라 구축** | packages/core 공유 유틸리티 채우기 외 3건 |
| 2026-02-27 | **완전 백그라운드 모드 전환 (launchd + Pickko headless)** | lib/browser.js PICKKO_HEADLESS 환경변수 지원 외 2건 |
| 2026-02-27 | **시스템 설계 v2.0 + iPad 원격 접속 + 투자봇 설계** | SYSTEM_DESIGN.md v2.0 전면 개정 (봇별 LLM 확정·투자팀 3봇·메모리 할당) 외 8건 |
| 2026-02-27 | **BUG-007 수정 + BOOT 파일명 누출 방지** | BUG-007: protocolTimeout 30초 + Promise.race 8초 타임아웃 외 2건 |
| 2026-02-27 | **lib/args.js 불리언 플래그 지원 + bug-report.js parseArgs 통합** | lib/args.js: --key 불리언 플래그 지원 (next가 --로 시작하면 true) 외 1건 |
| 2026-02-27 | **BOOT 속도 최적화 — 7분→50초** | deployer.js generateOpenclawBoot: IDENTITY+MEMORY 인라인, --sync 제거, DEV_SUMMARY/HANDOFF BOOT 제외 외 1건 |
| 2026-02-27 | **BOOT 시간 재확인 — 54초 2회 연속 검증** | BOOT durationMs=54121 확인 (gemini-2.5-flash, 2회 연속) 외 2건 |
| 2026-02-27 | **코딩가이드 목적 재정의 + work-history/coding-guide 세션마감 자동화** | coding-guide.md: 핵심 원칙 섹션 추가, 목적 재정의 외 2건 |
| 2026-02-27 | **코딩가이드 Security by Design 전면 적용** | Security by Design 원칙 선언 (어기면 코드가 실행 안 되는 구조) 외 4건 |
| 2026-02-27 | **pre-commit 훅 설치 및 공유 인프라 플랜 완료 검증** | scripts/pre-commit 설치 (.git/hooks/ 등록 + chmod +x) 외 2건 |
| 2026-02-27 | **ST-001~003 완료 + ska 설계 + 백로그 전체 등록** | ST-001 state.db 자동 백업 (launchd 03:00 일일) 외 4건 |
| 2026-02-27 | **FE-002 룸별·시간대별 가동률 리포트 구현** | src/occupancy-report.js 신규: 룸별/시간대별 가동률 계산 외 3건 |
| 2026-02-27 | **FE-005 로그 rotation (copytruncate, 매일 04:05)** | scripts/log-rotate.js 신규: 10개 로그 copytruncate 방식 로테이션 외 3건 |
| 2026-02-27 | **FE-006 gemini-2.5-flash execute_tool 누출 버그 재테스트 — 버그 종결** | gemini-2.5-flash telegram run 6건 전수 검사 — execute_tool 텍스트 누출 0건 외 2건 |
| 2026-02-27 | **FE-009 health-check staleness 체크 추가 (naver-monitor 크래시루프 감지)** | health-check.js: checkNaverLogStaleness() 추가 — 15분 무활동 시 알림 외 2건 |
| 2026-02-27 | **FE-007 mosh 설치 및 아이패드 SSH 환경 개선 검토** | mosh 1.4.0 설치 완료 (brew install mosh) 외 3건 |
| 2026-02-27 | **FE-008 Claude Code 한글 버그 GitHub 이슈 #15705 코멘트 등록** | 기존 이슈 #15705 확인 (OPEN, 9개 코멘트, area:tui bug 레이블) 외 2건 |
| 2026-02-27 | **MD-006: data.go.kr API 키 발급 가이드** | secrets.json 플레이스홀더 4개 추가 외 2건 |
| 2026-02-27 | **픽코 타임아웃 근본 해결 + 자동 버그리포트 + ska-001 + SKA 통일** | pickko-accurate.js 7단계 page.click→evaluate (Runtime.callFunctionOn 타임아웃 근본 해결) 외 5건 |
| 2026-02-27 | **ska-005~008 완료 — 이브크롤링+launchd 스케줄링** | ska-005 이브크롤링(큐넷+수능) — 547건 upsert 343일 외 3건 |
| 2026-02-27 | **ska-006 완료 — Prophet 매출 예측 엔진** | forecast.py Prophet 기본 엔진 (daily/weekly/monthly 3모드) 외 4건 |
| 2026-02-27 | **ska-007 완료 — Prophet regressor exam_events 연동** | forecast.py prophet-v1→v2 업그레이드 외 3건 |
| 2026-02-27 | **ska-014/015: 대학교 크롤링 + 공무원 정적 캘린더** | ska-014: 가천대·단국대 죽전 시험기간 Playwright 크롤링 외 4건 |
| 2026-02-27 | **설계문서 v2.1: 레베카 LLM 제거 확정** | ska-design.md v2.1 업데이트 외 4건 |
| 2026-02-27 | **설계문서 v2.2: Phase 3/3+ 루프 자동화 로드맵** | Phase 3 목표 명확화 (진단→수동 적용, 반자동, 3개월+) 외 3건 |
| 2026-02-27 | **tmux Remote Control 설정 + LLM API 코드 개선** | tmux 설치 + ai.ska.tmux launchd 등록 (재부팅 자동 복구) 외 3건 |
| 2026-02-27 | **CL-006 코딩가이드 기준 전체 코드 리팩토링** | maskPhone/maskName 함수 추가 (lib/formatting.js) 외 5건 |
| 2026-02-27 | **pickko-daily-audit/summary 실행 시간 23:50으로 변경** | pickko-daily-audit 22:00→23:50 (plist 수정 + launchd 재등록) 외 1건 |
| 2026-02-28 | **pickko-daily-audit 스케줄 22:00 원복** | pickko-daily-audit 23:50→22:00 원복 (plist 수정 + launchd 재등록) |
| 2026-02-28 | **OpenClaw v2026.2.26 업데이트 및 재시작** | openclaw gateway restart (완전 중지 후 재시작) 외 2건 |
| 2026-02-28 | **스카 재부팅** | openclaw gateway restart → 스카 부팅 완료 (durationMs=59s) |
| 2026-02-28 | **매출 보고 일반이용 합산 수정** | pickko-daily-summary.js: 23:50 자동 보고 합계에 일반이용(스터디카페) 포함 외 3건 |
| 2026-02-28 | **미해결 알림 해제 + 매출 일반이용 합산 수정** | 픽코 취소 실패 알림 수동 resolved 처리 (2026-02-27 18:00 A2) 외 5건 |
| 2026-02-28 | **고아 프로세스 자동 정리 추가** | start-ops.sh cleanup_old()에 고아 tail -f 프로세스 자동 정리 추가 (2시간 재시작마다 실행) |
| 2026-02-28 | **Runtime.callFunctionOn 타임아웃 근본 수정 + DB 중복 레코드 정리** | pickko-accurate.js page.click→evaluate (회원선택 버튼) 외 3건 |
| 2026-02-28 | **23:50 generalRevenue 미수집 + 중복예약 표시 버그 수정** | isMidnight 버그 수정 (hourKST===0 → hourKST===23 외 9건 |
| 2026-02-28 | **CL-006 코딩가이드 리팩토링 완료 확인 + 백필 스크립트** | CL-006 플랜 전항목 완료 확인 (P0~P4 모두 이전 세션에서 구현됨) 외 2건 |
| 2026-03-01 | **새로고침 버튼 fix + 알림 컨텍스트 공유** | naver-monitor 새로고침 버튼 ElementHandle.click→evaluate() 수정 외 3건 |
| 2026-03-01 | **ETL actual_revenue 입금 기준 전환 + pickko_total 분석** | ETL actual_revenue: pickko_total(이용일) → total_amount(입금일) 기준 전환 외 3건 |
| 2026-03-01 | **BOOT 침묵 규칙 통일 + ETL total_amount 기준 변경** | BOOT.md 메시지 전송 규칙 제거(침묵 대기로 통일) 외 5건 |
| 2026-03-01 | **미컨펌 알림 날짜 버그 수정** | 미컨펌 알림 범위 최근 3일 이내로 제한 외 1건 |
| 2026-03-01 | **예약 오류 체크 - 픽코 CDP 타임아웃 원인 분석** | 픽코 예약 실패 원인 확인 (Runtime.callFunctionOn timed out) 외 2건 |
| 2026-03-01 | **스카 재시작 및 부팅 확인** | 스카 재시작 (PID 66467) 외 1건 |
| 2026-03-01 | **스카팀 루나팀 패턴 적용 ①②③** | DB Migration System (scripts/migrate.js + migrations/) 외 2건 |
| 2026-03-02 | **SKA-P05~P08 루나팀 패턴 적용 + deploy-ops.sh** | lib/error-tracker.js 연속 오류 카운터 (naver-monitor+kiosk-monitor 통합) 외 4건 |
| 2026-03-02 | **3중 가동/중지 lib/health.js + deploy-ops.sh** | lib/health.js 3중 가동(preflightSystemCheck/ConnCheck)+3중 중지(shutdownDB/Cleanup/registerShutdownHandlers) 외 4건 |
| 2026-03-02 | **하트비트 오늘예약현황 추가 + scar→ska 정리 + 절대규칙 등록** | getTodayStats() DB함수 추가 (네이버+키오스크 합계) 외 4건 |
| 2026-03-02 | **대리등록-네이버-예약불가-자동처리-로직-추가** | pickko-kiosk-monitor.js blockSlotOnly() + --block-slot 모드 추가 외 2건 |
| 2026-03-02 | **오늘-예약-검증-audit-today-구현** | auditToday() 함수 추가 (pickko-kiosk-monitor.js) 외 4건 |
| 2026-03-02 | **auditToday-failedList-차단실패-알림-추가** | blockNaverSlot false반환시 DB false positive 방지 확인 외 2건 |
| 2026-03-02 | **blockNaverSlot-avail소멸-보조확인-차단성공** | verifyBlockInGrid suspended만 확인하는 한계 발견 외 2건 |
| 2026-03-02 | **audit-date-내일날짜-검증-완료** | auditToday dateOverride 파라미터 추가 외 2건 |
| 2026-03-02 | **픽코취소-네이버해제-자동화-unblock-slot** | unblockNaverSlot avail-gone 버그 수정 (false positive return 제거) 외 3건 |
| 2026-03-02 | **취소-테스트-성공-avail-gone-복구-확인** | 이승호 B룸 18:00 취소 테스트 성공 (픽코취소+네이버해제) 외 1건 |
| 2026-03-02 | **예약 취소 E2E 완성 + TOOLS.md 취소/등록 도구 정비** | pickko-cancel-cmd.js 2단계 취소(픽코+네이버 해제) 완성 외 4건 |
| 2026-03-04 | **전체 봇 sendTelegram → publishToMainBot 전면 교체** | error-tracker.js 마지막 교체 완료 외 1건 |
| 2026-03-04 | **LLM키통합+알람버그수정+덱스터패턴학습** | packages/core/lib/llm-keys.js 공용 LLM 키 로더 외 3건 |
<!-- session-close:2026-03-04:llm키통합알람버그수정덱스터패턴학습 -->
<!-- session-close:2026-03-04:전체-봇-sendtelegram-publishtomai -->
<!-- session-close:2026-03-02:예약-취소-e2e-완성-toolsmd-취소등록-도구-정 -->
<!-- session-close:2026-03-02:취소테스트성공availgone복구확인 -->
<!-- session-close:2026-03-02:픽코취소네이버해제자동화unblockslot -->
<!-- session-close:2026-03-02:auditdate내일날짜검증완료 -->
<!-- session-close:2026-03-02:blocknaverslotavail소멸보조확인차단성공 -->
<!-- session-close:2026-03-02:audittodayfailedlist차단실패알림추가 -->
<!-- session-close:2026-03-02:오늘예약검증audittoday구현 -->
<!-- session-close:2026-03-02:대리등록네이버예약불가자동처리로직추가 -->
<!-- session-close:2026-03-02:하트비트-오늘예약현황-추가-scarska-정리-절대규칙 -->
<!-- session-close:2026-03-02:3중-가동중지-libhealthjs-deployopss -->
<!-- session-close:2026-03-02:skap05p08-루나팀-패턴-적용-deployopss -->
<!-- session-close:2026-03-01:스카팀-루나팀-패턴-적용 -->
<!-- session-close:2026-03-01:스카-재시작-및-부팅-확인 -->
<!-- session-close:2026-03-01:예약-오류-체크-픽코-cdp-타임아웃-원인-분석 -->
<!-- session-close:2026-03-01:미컨펌-알림-날짜-버그-수정 -->
<!-- session-close:2026-03-01:boot-침묵-규칙-통일-etl-total_amount -->
<!-- session-close:2026-03-01:etl-actual_revenue-입금-기준-전환-pi -->
<!-- session-close:2026-03-01:새로고침-버튼-fix-알림-컨텍스트-공유 -->
<!-- session-close:2026-02-28:cl006-코딩가이드-리팩토링-완료-확인-백필-스크립트 -->
<!-- session-close:2026-02-28:2350-generalrevenue-미수집-중복예약-표 -->
<!-- session-close:2026-02-28:runtimecallfunctionon-타임아웃-근본- -->
<!-- session-close:2026-02-28:고아-프로세스-자동-정리-추가 -->
<!-- session-close:2026-02-28:미해결-알림-해제-매출-일반이용-합산-수정 -->
<!-- session-close:2026-02-28:매출-보고-일반이용-합산-수정 -->
<!-- session-close:2026-02-28:스카-재부팅 -->
<!-- session-close:2026-02-28:openclaw-v2026226-업데이트-및-재시작 -->
<!-- session-close:2026-02-28:pickkodailyaudit-스케줄-2200-원복 -->
<!-- session-close:2026-02-27:pickkodailyauditsummary-실행-시간- -->
<!-- session-close:2026-02-27:cl006-코딩가이드-기준-전체-코드-리팩토링 -->
<!-- session-close:2026-02-27:tmux-remote-control-설정-llm-api -->
<!-- session-close:2026-02-27:설계문서-v22-phase-33-루프-자동화-로드맵 -->
<!-- session-close:2026-02-27:설계문서-v21-레베카-llm-제거-확정 -->
<!-- session-close:2026-02-27:ska014015-대학교-크롤링-공무원-정적-캘린더 -->
<!-- session-close:2026-02-27:ska007-완료-prophet-regressor-ex -->
<!-- session-close:2026-02-27:ska006-완료-prophet-매출-예측-엔진 -->
<!-- session-close:2026-02-27:ska005008-완료-이브크롤링launchd-스케줄링 -->
<!-- session-close:2026-02-27:픽코-타임아웃-근본-해결-자동-버그리포트-ska001- -->
<!-- session-close:2026-02-27:md006-datagokr-api-키-발급-가이드 -->
<!-- session-close:2026-02-27:fe008-claude-code-한글-버그-github -->
<!-- session-close:2026-02-27:fe007-mosh-설치-및-아이패드-ssh-환경-개선 -->
<!-- session-close:2026-02-27:fe009-healthcheck-staleness-체크 -->
<!-- session-close:2026-02-27:fe006-gemini25flash-execute_to -->
<!-- session-close:2026-02-27:fe005-로그-rotation-copytruncate -->
<!-- session-close:2026-02-27:fe002-룸별시간대별-가동률-리포트-구현 -->
<!-- session-close:2026-02-27:st001003-완료-ska-설계-백로그-전체-등록 -->
<!-- session-close:2026-02-27:precommit-훅-설치-및-공유-인프라-플랜-완료- -->
<!-- session-close:2026-02-27:코딩가이드-security-by-design-전면-적용 -->
<!-- session-close:2026-02-27:코딩가이드-목적-재정의-workhistorycoding -->
<!-- session-close:2026-02-27:boot-시간-재확인-54초-2회-연속-검증 -->
<!-- session-close:2026-02-27:boot-속도-최적화-7분50초 -->
<!-- session-close:2026-02-27:libargsjs-불리언-플래그-지원-bugreport -->
<!-- session-close:2026-02-27:bug007-수정-boot-파일명-누출-방지 -->
<!-- session-close:2026-02-27:시스템-설계-v20-ipad-원격-접속-투자봇-설계 -->
<!-- session-close:2026-02-27:완전-백그라운드-모드-전환-launchd-pickko- -->
<!-- session-close:2026-02-27:전체-시스템-공유-인프라-구축 -->
<!-- session-close:2026-02-26:텔레그램-알람-불가-처리-pending-queue -->
<!-- session-close:2026-02-26:자연어-명령-e2e-테스트-통합-매핑-추가 -->
<!-- session-close:2026-02-26:매출-통계-자연어-명령-추가-pickkostatscmd -->
<!-- session-close:2026-02-26:sessionclose-라이브러리-구축 -->

---

## 🚀 현재 운영 상태 (2026-02-26)

```
⏸ naver-monitor.js    마이그레이션 후 일시 중단 → 재시작 필요
⏸ OpenClaw 게이트웨이  마이그레이션 후 일시 중단 → 재시작 필요
✅ Heartbeat           1시간 주기, 09:00~22:00 텔레그램 전송 (재시작 후 복구)
✅ pickko-cancel.js    네이버 취소 → 픽코 자동 취소 (PICKKO_CANCEL_ENABLE=1)
✅ pickko-verify.js    needsVerify() 기반 재검증 (자동: 08:00/14:00/20:00, launchd)
✅ pickko-daily-audit  당일 픽코 감사 (22:00+23:50 자동, launchd)
✅ pickko-register.js  자연어 예약 등록 CLI — 스카가 직접 실행 가능
✅ pickko-member.js    신규 회원 가입 CLI — 스카가 직접 실행 가능
✅ pickko-daily-summary  09:00 예약현황 / 00:00 마감 매출+컨펌 (launchd: ai.ska.pickko-daily-summary)
✅ lib/ 공유 라이브러리  10개 모듈 (pickko-stats.js 신규 추가)
✅ state.db            단일 SQLite, AES-256-GCM 암호화 (phone/name)
✅ RAG 서버            http://localhost:8100 정상
✅ BOOT.md             게이트웨이 재시작 시 자동 실행 + sync 자동 보존
✅ 자정 자동 보존       nightly-sync.sh + launchd (00:00 실행)
✅ log-report.sh       3시간 주기 오류 분석 리포트 (launchd: ai.ska.log-report)
```

**재시작 명령:**
```bash
launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway.plist
cd ~/projects/ai-agent-system/bots/reservation && nohup bash src/start-ops.sh > /dev/null 2>&1 &
```

## 📌 pickko-cancel.js 핵심 구현 노트 (2026-02-24)

- 픽코 검색 전화번호: **하이픈 포함** 필요 (`010-XXXX-XXXX`)
- 픽코 종료시간 = 네이버 종료시간 **-10분** (픽코 슬롯 계산 차이)
  - 예: 네이버 23:00 → 픽코 목록에 `23시 50분` 표시
- 목록 매칭: 1순위 (시작+종료 모두), 2순위 (시작만), 3순위 (전화번호 뒷 8자리)
- 취소 셀렉터: `input#sd_step-1` (value="-1"), 제출: `input[value="작성하기"]`
- 이미 취소 상태면 중복 처리 방지로 exit 0
- 병렬 실행 가능 (3개 브라우저 동시 테스트 성공)
- 세션 복구 문제: 브라우저 강제 종료 후 재시작 시 `Default/Current Session` 파일 삭제 필요
  ```bash
  rm -f ~/.openclaw/workspace/naver-profile/Default/"Current Session"
  rm -f ~/.openclaw/workspace/naver-profile/Default/"Current Tabs"
  ```

---

## 📋 업데이트 검토 목록 (미구현)

| 항목 | 설명 | 우선순위 |
|------|------|---------|
| IS-001 홈화면 복귀 이슈 | session/cookie 만료 처리 개선 | 낮음 |
| ~~pickko-verify.js 자동 스케줄링~~ | ✅ 완료 — launchd 08:00/14:00/20:00 | 완료 |
| ~~pickko-daily-audit~~ | ✅ 완료 — launchd 22:00+23:50 | 완료 |
| ~~pickko-register / pickko-member~~ | ✅ 완료 — 스카 CLI 명령 사용 가능 | 완료 |
| ~~픽코→네이버 예약 불가 처리~~ | ✅ 완료 — pickko-kiosk-monitor.js (30분 launchd, 차단+해제 자동화) | 완료 |
| ~~일일 예약 요약 자동 전송~~ | ✅ 완료 — pickko-daily-summary.js (09:00/00:00 launchd, 매출 분리 + 컨펌) | 완료 |
| 예약 중복 감지 알림 | 동일 시간대 중복 예약 즉시 경고 | 중간 |
| Playwright → 네이버 API | UI 변경 취약점 근본 해결 | 장기 검토 |
| 맥미니 이전 | M4 Pro 구매 후 전체 시스템 이전 | Phase 3 |
