# DEV_SUMMARY.md - 스카봇 개발 현황 요약

> **목적:** 모델 교체 후 빠른 컨텍스트 복원용. BOOT.md가 자동으로 읽음.
> **최종 업데이트:** 2026-02-23

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
| `src/pickko-accurate.js` | 픽코 자동 예약 Stage [1-9] | ✅ 완성 |
| `src/pickko-cancel.js` | 픽코 자동 취소 Stage [1-10] | ✅ 완성 (2026-02-24) |
| `src/start-ops.sh` | OPS 자동 재시작 루프 | ✅ PICKKO_CANCEL_ENABLE=1 |
| `lib/validation.js` | 전화번호/날짜/시간 정규식 변환 | ✅ 24:00 지원 추가 |
| `secrets.json` | 네이버/픽코 로그인 정보 | ✅ |
| `.pickko-alerts.jsonl` | 알람 저장소 (48시간 자동 정리) | ✅ 운영 중 |
| `naver-bookings-full.json` | 네이버 파싱 데이터 | ✅ 운영 중 |

**경로:** `~/projects/ai-agent-system/bots/reservation/`

---

## 📋 개발 완료 단계 (pickko-accurate.js)

| Stage | 기능 | 구현 내용 |
|-------|------|----------|
| [1] 로그인 | 픽코 자동 로그인 | 헤드리스 모드 |
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
MODE=ops PICKKO_ENABLE=1 STRICT_TIME=1 NAVER_HEADLESS=1 \
TELEGRAM_ENABLED=1 NAVER_INTERVAL_MS=300000 \
OBSERVE_ONLY=0 \
node naver-monitor.js > /tmp/naver-ops-mode.log 2>&1 &
```
> ⚠️ OBSERVE_ONLY=0 필수! 없으면 화이트리스트 번호만 처리되고 실제 고객 예약은 스킵됨

---

## 🔔 알람 시스템

- `sendAlert()` → `.pickko-alerts.jsonl` 저장 (sent=true)
- `cleanupOldAlerts()` → 48시간 지난 알람 자동 삭제
- Heartbeat (30분 주기) → Telegram으로 일괄 전송

**알람 타입:** `new`(신규 감지) | `completed`(픽코 완료) | `cancelled`(취소 완료) | `error`(실패)

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

## 🤖 OpenClaw 에이전트 구성 (2026-02-23 확정)

| 항목 | 값 |
|------|-----|
| 에이전트 이름 | 스카 (main) |
| 기본 모델 | `google-gemini-cli/gemini-2.0-flash` |
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

---

## 🚀 현재 운영 상태 (2026-02-24)

```
✅ naver-monitor.js    OPS 모드, 3분 주기 실행 중 (PICKKO_CANCEL_ENABLE=1)
✅ Heartbeat           1시간 주기, 09:00~22:00 텔레그램 전송
✅ pickko-cancel.js    네이버 취소 → 픽코 자동 취소 (OPS 활성화됨)
✅ Telegram 봇         Gemini 2.0 Flash, 응답 ~7초
✅ RAG 서버            http://localhost:8100 정상
✅ OpenClaw 게이트웨이  PID 정상, CLI pairing 완료
✅ BOOT.md             게이트웨이 재시작 시 자동 실행 + sync 자동 보존
✅ 자정 자동 보존       nightly-sync.sh + launchd (00:00 실행)
✅ log-report.sh       3시간 주기 오류 분석 리포트 (launchd: ai.ska.log-report)
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

## 📋 향후 검토 중인 기능

- 추가 기능 업데이트 사장님 검토 중
- IS-001: 네이버 홈화면 복귀 이슈 (낮은 우선순위)
- 맥미니 M4 Pro 구매 후 전체 시스템 이전 예정
