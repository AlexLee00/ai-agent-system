# 🤖 멀티 에이전트 AI 봇 시스템 설계서

> 최초 작성: 2026년 2월 22일
> 최종 업데이트: 2026년 2월 23일
> 목적: 맥미니 M4 Pro 기반 로컬 AI 멀티 에이전트 시스템 구축

---

## 1. 시스템 개요

### 핵심 철학

> 사용자는 **메인 봇(팀장)에게만 지시**하고, 메인 봇이 알아서 팀원 봇에게 업무를 분배하고 결과를 취합하여 보고한다.

### 전체 구조도

```
👤 사용자
    │
    ▼ 지시 (자연어)
┌─────────────────────────────┐
│     🤖 메인 봇 (팀장)         │
│     - 지시 해석               │
│     - 업무 분배               │
│     - 결과 취합 & 보고         │
└──────────────┬──────────────┘
               │
    ┌──────────┼──────────────────────┐
    │          │          │           │
    ▼          ▼          ▼           ▼           ▼
📅 예약봇  🗓️ 비서봇  💼 업무봇  🎓 학술봇  ⚖️ 판례봇
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
| 운영체제 | macOS           |

### 기기 운용 방식

| 기기         | 역할                   | 상태       |
|------------|----------------------|----------|
| 🖥️ 맥미니    | AI 봇 서버 24시간 운용 (집 고정) | ⏳ 구매 예정  |
| 💻 맥북 에어 M3 | 이동형 / OpenClaw + claude.ai/code | ✅ 현재 사용 중 |
| 📱 아이패드   | 이동형 / OpenClaw WebChat + Claude Remote 앱 | ✅ 사용 가능  |
| 📱 핸드폰    | 텔레그램 봇으로 알림 및 명령    | ✅ 연결 완료  |

---

## 3. 소프트웨어 스택

| 구성요소            | 도구              | 역할                     | 상태        |
|-----------------|-----------------|------------------------|-----------|
| LLM 엔진          | Ollama          | 로컬 LLM 모델 실행            | ⏳ 맥미니 후   |
| AI 에이전트 게이트웨이   | OpenClaw        | 멀티채널 AI 에이전트 허브         | ✅ 운영 중    |
| 봇 프레임워크         | n8n             | 멀티 에이전트 워크플로우 관리        | ⏳ 맥미니 후   |
| 원격 접속           | Tailscale       | 외부에서 맥미니 봇 접속           | ⏳ 맥미니 후   |
| 클로드코드 모니터링      | Claude Remote   | 아이패드에서 클로드코드 원격 제어      | ✅ 사용 가능   |
| 클로드코드 원격 실행     | claude.ai/code  | 브라우저 기반 클로드코드 실행        | ✅ 사용 가능   |
| 브라우저 자동화        | Playwright      | 네이버 스마트플레이스 / 픽코 자동화    | ✅ OPS 운영 중 |
| 핸드폰 알림          | 텔레그램 봇          | 예약 알림 및 명령 수신           | ✅ 연결 완료   |
| 지식 베이스          | RAG (ChromaDB)  | 예약 이력 저장 + 질의응답         | ✅ 운영 중    |
| 컨텍스트 관리         | deploy-context.js | 봇 기억 배포 + 역동기화        | ✅ 운영 중    |
| 자동 백업           | launchd         | 자정 컨텍스트 자동 보존 (git commit) | ✅ 운영 중    |

---

## 4. OpenClaw 현재 설정 (2026-02-23 기준)

### LLM 엔진 구성 (Fallback Chain)

| 순서          | 모델                                    | 역할              | 응답속도  |
|-------------|---------------------------------------|-----------------|-------|
| Primary     | `google-gemini-cli/gemini-2.0-flash`  | 기본 엔진 (무료 API)   | ~7초   |
| Fallback #1 | `anthropic/claude-haiku-4-5`          | Gemini 장애 시 전환   | 빠름    |
| Fallback #2 | `ollama/qwen2.5:7b`                   | 비상용 (Telegram 불가) | ~4분   |

> ⚠️ Ollama Homebrew 빌드는 M1 MacBook에서 MLX GPU 가속 안됨 → Telegram 봇에 사용 불가

### 텔레그램 봇

- 봇: `@SCAFE8282_BOT`
- 사장님 chat_id: `***REMOVED***`
- 상태: ✅ 정상 연결

---

## 5. 봇 구성 상세

### 5-1. 📅 예약관리봇 - 스카 (Ska) ✅ OPS 실운영 중

| 항목 | 내용 |
|------|------|
| 모델 | google-gemini-cli/gemini-2.0-flash |
| 채널 | 텔레그램 (@SCAFE8282_BOT) |
| 상태 | **OPS 모드 실운영 중** |
| 파싱 도구 | Playwright (헤드리스) |
| 대상 플랫폼 | 네이버 스마트플레이스 → 픽코 키오스크 |

**시스템 흐름**

```
[네이버 스마트플레이스]
        ↓ 신규 예약 감지 (5분 주기)
[naver-monitor.js] ← OPS 모드
        ↓ sendAlert() → .pickko-alerts.jsonl
        ↓ runPickko() 자동 호출
[pickko-accurate.js] ← Stage [1-9] 자동 실행
        ↓
[픽코 키오스크] ← 예약 + 0원 현금 결제 완료
        ↓ Heartbeat (30분)
[Telegram] ← 사장님에게 결과 알람
        ↓
[RAG API] ← 예약 이력 저장 (http://localhost:8100)
```

**DEV / OPS 모드 분리 규칙 (절대 규칙)**

```
DEV 모드: 화이트리스트 2명만 테스트
  - 이재룡 (010-3500-0586) 사장님
  - 김정민 (010-5435-0586) 부사장님
  - 데이터: naver-seen-dev.json

OPS 모드: 사장님 협의 후 전환. 모든 고객 번호 처리.
  - 데이터: naver-seen.json (실제 완료 예약만 보존)
  - 오류 발생 시: 자동 알람 → DEV 전환 → 재협의 (자체 해결 금지)
```

**핵심 파일**

| 파일 | 역할 | 상태 |
|------|------|------|
| `src/naver-monitor.js` | 네이버 모니터링 + 픽코 트리거 | ✅ OPS 실행 중 |
| `src/pickko-accurate.js` | 픽코 자동 예약 Stage [1-9] | ✅ 완성 |
| `src/start-ops.sh` | OPS 자동 재시작 루프 (2시간) | ✅ 완성 |
| `lib/validation.js` | 전화번호/날짜/시간 정규식 변환 | ✅ 완성 |
| `naver-seen.json` | OPS 예약 완료 저장소 | ✅ 운영 중 |
| `naver-seen-dev.json` | DEV 테스트 저장소 | ✅ 분리 완료 |
| `.pickko-alerts.jsonl` | 알람 저장소 (48시간 자동 정리) | ✅ 운영 중 |

**실제 등록 완료 예약**

| 예약ID | 고객번호 | 날짜 | 시간 | 상태 |
|--------|----------|------|------|------|
| 1165071422 | 010-4214-0104 | 2026-02-28 | 16:00~18:00 | completed (auto) |

---

### 5-2. 🤖 메인봇 (팀장 / 오케스트레이터)

| 항목 | 내용 |
|----|------|
| 모델 | qwen2.5:32b (맥미니 설치 후) |
| 상태 | ⏳ Phase 3 구축 예정 |
| 역할 | 지시 해석, 업무 분배, 결과 취합 |

---

### 5-3. 🗓️ 개인비서봇

| 항목 | 내용 |
|----|------|
| 모델 | qwen2.5:14b |
| 역할 | 일정 관리 및 개인 업무 보조 |
| 상태 | ⏳ Phase 3 구축 예정 |

---

### 5-4. 💼 업무봇

| 항목 | 내용 |
|----|------|
| 모델 | qwen2.5:32b |
| 역할 | 기획 및 업무 종합 보조 |
| 상태 | ⏳ Phase 3 구축 예정 |

---

### 5-5. 🎓 학술보조봇

| 항목    | 내용 |
|-------|------|
| 모델    | Deepseek-r1:32b |
| 역할    | 박사 논문 작성 및 연구 보조 |
| 연구 분야 | SE 기반 소프트웨어 감정평가 |
| 상태    | ⏳ Phase 4 구축 예정 |

---

### 5-6. ⚖️ 판례봇

| 항목    | 내용 |
|-------|------|
| 모델    | Deepseek-r1:32b |
| 역할    | 국내외 판례 서칭 및 분석 |
| 주요 목적 | 논문 근거 자료 수집 |
| 상태    | ⏳ Phase 4 구축 예정 |

---

## 6. 컨텍스트 관리 시스템 ✅ (2026-02-23 구축 완료)

봇들이 모델 교체 / 재시작 후에도 이전 기억을 이어받아 연속 작업이 가능한 구조.

### 구조

```
bots/
├── registry.json               ← 전체 봇 등록부
└── {bot}/
    └── context/                ← 컨텍스트 소스 (git 관리)
        ├── IDENTITY.md         ← 봇 정체성 (역할/규칙)
        ├── MEMORY.md           ← 운영 기억 (명령/주의사항)
        ├── DEV_SUMMARY.md      ← 개발 현황 요약
        └── HANDOFF.md          ← 인수인계 (최신 작업)

scripts/
├── deploy-context.js           ← 배포/역동기화 스크립트
└── nightly-sync.sh             ← 자정 자동 보존

~/.openclaw/workspace/
├── BOOT.md                     ← 게이트웨이 시작 시 자동 실행
├── IDENTITY.md / MEMORY.md ... ← 배포된 컨텍스트

~/.claude/projects/-Users-alexlee/memory/
├── MEMORY.md                   ← Claude Code 자동 로드
├── reservation-dev-summary.md  ← 봇별 토픽 파일
└── reservation-handoff.md
```

### 배포 흐름

```
context/ (소스)
    │
    ▼ node deploy-context.js --bot=reservation
    ├── → ~/.openclaw/workspace/ (스카봇 기억)
    │       + BOOT.md 자동 생성
    └── → ~/.claude/memory/ (Claude Code 기억)
            + MEMORY.md 봇 섹션 업데이트
```

### 자동 보존 흐름

```
게이트웨이 재시작 (모델 변경)
    └── BOOT.md 1단계: deploy-context.js --sync 실행
            → workspace → context/ 역동기화 (이전 세션 보존)
            → 이후 context 파일 읽기 시작

매일 00:00 (launchd)
    └── nightly-sync.sh
            → deploy-context.js --all --sync
            → git commit (변경사항만)
```

### 명령어

```bash
# 특정 봇 배포 (context/ → workspace)
node scripts/deploy-context.js --bot=reservation

# 역동기화 (workspace → context/)
node scripts/deploy-context.js --bot=reservation --sync

# 전체 봇 배포
node scripts/deploy-context.js --all

# 봇 목록 확인
node scripts/deploy-context.js --list
```

---

## 7. RAG 지식 베이스 ✅ (2026-02-23 구축 완료)

예약 이력을 자동 저장하고 질문에 답변하는 시스템.

| 항목 | 내용 |
|------|------|
| 서버 | `http://localhost:8100` (FastAPI + ChromaDB) |
| 시작 | `cd ~/projects/rag-system && .venv/bin/uvicorn api.main:app --port 8100` |
| Python | 3.12 전용 (3.14 호환 안됨) |
| 임베딩 | ollama/nomic-embed-text |
| 질의 | `POST /ask` → Ollama qwen2.5:7b가 RAG 기반 답변 |

```bash
# 예약 현황 질의
curl -s -X POST http://localhost:8100/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "오늘 예약 현황", "collection": "reservations"}'
```

---

## 8. 자동화 운영 시스템 ✅

| 항목 | 방식 | 주기 | 상태 |
|------|------|------|------|
| 네이버 모니터링 | naver-monitor.js | 5분 | ✅ OPS |
| OPS 자동 재시작 | start-ops.sh while loop | 2시간 | ✅ |
| Heartbeat 알람 | OpenClaw 내장 | 30분 | ✅ |
| 모니터 생존 체크 | Heartbeat 내 ps 확인 | 30분 | ✅ |
| 컨텍스트 보존 | nightly-sync.sh + launchd | 00:00 | ✅ |
| 모델 변경 시 sync | BOOT.md 1단계 지시 | 재시작마다 | ✅ |

---

## 9. 구축 단계별 진행 현황

### Phase 1 - ✅ 완료 (2026-02-23)

| 항목 | 상태 |
|------|------|
| OpenClaw 설치 | ✅ 완료 |
| Gemini / Claude / Ollama Fallback Chain 구성 | ✅ 완료 |
| 텔레그램 봇 연결 (@SCAFE8282_BOT) | ✅ 완료 |
| 예약관리봇 100% 완성 (Stage [1-9]) | ✅ 완료 |
| OPS 모드 실운영 전환 | ✅ 2026-02-22 23:37 |
| RAG 지식 베이스 구축 | ✅ 완료 |
| 컨텍스트 관리 시스템 구축 | ✅ 완료 |
| 자정 자동 보존 시스템 | ✅ 완료 |
| 모델 변경 시 자동 컨텍스트 보존 | ✅ 완료 |

### Phase 2 - 맥미니 구매 후

| 항목 | 상태 |
|------|------|
| 맥미니 M4 Pro 12코어 64GB 1TB 구매 | ⏳ 대기 |
| Ollama + Open WebUI + n8n 세팅 | ⏳ 대기 |
| Tailscale 원격 접속 구성 | ⏳ 대기 |
| 전체 시스템 맥미니 이전 | ⏳ 대기 |

### Phase 3 - 봇 순차 구축

| 항목 | 상태 |
|------|------|
| 예약관리봇 맥미니 이전 및 안정화 | ⏳ 대기 |
| 개인비서봇 구축 | ⏳ 대기 |
| 업무봇 구축 | ⏳ 대기 |
| 메인봇 구축 및 연동 | ⏳ 대기 |

### Phase 4 - 학술 시스템 구축

| 항목 | 상태 |
|------|------|
| 학술보조봇 구축 | ⏳ 대기 |
| 판례봇 구축 (국내외 데이터소스 연동) | ⏳ 대기 |
| KCI 논문 작성 워크플로우 완성 | ⏳ 대기 |
| 박사학위 논문 지원 시스템 완성 | ⏳ 대기 |

---

## 10. 유지보수 백로그

현재 미적용 또는 추후 개선이 필요한 항목들.

### 🔴 높은 우선순위

| ID | 항목 | 내용 | 관련 파일 |
|----|------|------|--------|
| M-001 | OpenClaw cron 주기적 sync | 현재 BOOT.md 기반(재시작마다)만 있음. OpenClaw 내장 cron으로 1~2시간 주기 `--sync` 추가 필요. 포맷 확인 후 `~/.openclaw/cron/jobs.json` 에 추가 | `cron/jobs.json` |
| M-002 | IS-001 네이버 홈화면 복귀 이슈 | 캘린더 → 홈화면 복귀 자동화 미완성. 낮은 발생빈도로 보류 중 | `naver-monitor.js` |
| M-003 | RAG 서버 자동 시작 | 현재 수동 실행. launchd plist 추가하여 부팅 시 자동 시작 필요 | `rag-system/` |

### 🟡 중간 우선순위

| ID | 항목 | 내용 |
|----|------|------|
| M-004 | OpenClaw model_change 훅 | OpenClaw가 향후 `model_change` 이벤트 훅을 지원할 경우, BOOT.md 방식 대신 이벤트 기반 sync로 전환 |
| M-005 | 다봇 컨텍스트 표준화 | 새 봇 추가 시 `registry.json` 등록 + `context/` 디렉토리 생성을 자동화하는 CLI (`scripts/new-bot.js`) |
| M-006 | 컨텍스트 diff 알림 | 역동기화 시 context/ 변경사항을 Telegram으로 요약 알림 |
| M-007 | naver-seen.json 백업 | 운영 데이터 파일을 주기적으로 별도 백업 (git 외 추가 백업) |

### 🟢 낮은 우선순위 / 맥미니 이전 후

| ID | 항목 | 내용 |
|----|------|------|
| M-008 | n8n 오케스트레이션 연동 | 맥미니 구매 후 n8n으로 멀티봇 워크플로우 구성 |
| M-009 | 로컬 LLM 전환 | 맥미니에서 Ollama qwen2.5 계열로 전환 (API 비용 절감) |
| M-010 | Tailscale 원격 접속 | 외부에서 맥미니 봇 접속 구성 |
| M-011 | 봇 대시보드 | 전체 봇 운영 현황을 한눈에 보는 웹 대시보드 (`apps/dashboard/`) |
| M-012 | registry.json 모델 최신화 | OpenClaw 모델 변경 시 `registry.json`의 `model.primary` 값도 동기화 |

---

## 11. 기기별 소통 방법

```
👤 사용자
    │
    ├── 📱 핸드폰     → 텔레그램 봇 (@SCAFE8282_BOT)  ✅
    ├── 📱 아이패드   → OpenClaw WebChat / Claude Remote 앱
    ├── 💻 맥북에어   → OpenClaw WebChat / claude.ai/code
    └── 🖥️ 맥미니    → 터미널 직접 (관리/설정)  ⏳
```

---

## 12. 모델별 메모리 사용량 예상 (맥미니 기준)

| 봇       | 모델              | 메모리 사용량    |
|---------|-----------------|------------|
| 메인봇     | qwen2.5:32b     | 약 20GB     |
| 예약관리봇   | qwen2.5:7b      | 약 5GB      |
| 개인비서봇   | qwen2.5:14b     | 약 9GB      |
| 업무봇     | qwen2.5:32b     | 약 20GB     |
| 학술봇     | Deepseek-r1:32b | 약 20GB     |
| 판례봇     | Deepseek-r1:32b | 약 20GB     |
| **여유**  |                 | **약 10GB** |
| **합계** |                 | **64GB** ✅ |

> 모든 봇이 동시에 풀로드 상태는 아니므로 실제 운용 시 64GB로 충분히 관리 가능

---

## 13. 자금 계획

| 항목           | 금액         | 상태      |
|--------------|------------|---------|
| 데스크탑 판매      | +180만원     | ✅ 완료    |
| 맥북 M1 Pro 판매 | +160만원     | 🔄 진행 중 |
| **총 예상 자금**  | **340만원**  |         |
| 맥미니 구매       | -302만원     | ⏳ 대기    |
| **잔여 예산**    | **38만원**   |         |

---

*본 문서는 시스템 구축 진행에 따라 지속 업데이트 예정*
*파일 위치: `~/projects/ai-agent-system/docs/SYSTEM_DESIGN.md`*
