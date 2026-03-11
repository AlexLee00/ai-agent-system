# 코딩 가이드 — ai-agent-system

> **목적**: 코드 분량이 늘어나도 일관성을 유지하고, 환경변수·라이브러리·모듈 단위로
> 클린 코드를 적용해 모든 봇 개발의 표준을 정의한다.
>
> **적용 범위**: 모든 봇 (`reservation`, `investment`, `secretary` …) + 공유 인프라 (`packages/`)
>
> **언제 참조**: 새 기능 추가 / 버그 수정 / 신규 봇 개발 / 코드 리뷰 전 **반드시** 참조.
>
> 마지막 업데이트: 2026-03-11

---

## 0. 핵심 원칙 (모든 코드에 예외 없이 적용)

### 클린 코드 원칙

| 원칙 | 내용 |
|------|------|
| **단일 책임** | 함수 하나 = 역할 하나. 50줄 넘으면 분리 검토 |
| **경로 상수화** | 경로 문자열 반복 금지. `WORKSPACE`, `DB_PATH` 상수 사용 |
| **원자적 쓰기** | 파일 저장은 `lib/files.js saveJson()` 사용 (직접 `writeFileSync` 금지) |
| **명시적 실패** | 에러는 삼키지 말고 로그 + 텔레그램 알림 |
| **DEV/OPS 분리** | `MODE=ops`일 때만 실제 실행. 기본은 DEV(관찰 전용) |
| **외부 격리** | 텔레그램·RAG 등 외부 호출은 반드시 `try/catch` 격리 |

### 솔루션화 원칙 (재사용성·공용성) ⭐ 핵심

> **동일·유사 코드는 라이브러리화·모듈화하여 공용으로 관리한다.**
> 솔루션 확장 시 개별 봇이 각자 구현하는 것이 아니라, 공유 라이브러리에서 옵션으로 선택하여 사용한다.

#### 라이브러리화 원칙

| 원칙 | 내용 | 예시 |
|------|------|------|
| **중복 제거** | 2개 이상 봇에서 동일 로직 → `lib/` 또는 `packages/core/`로 추출 | `telegram.js`, `secrets.js`, `health.js` |
| **공용 변수** | 매직 넘버·반복 문자열 → 상수로 선언 후 재사용 | `const MAX_RETRIES = 5` |
| **환경변수 공용화** | 봇 공통 제어 옵션은 환경변수로 노출 (하드코딩 금지) | `MODE`, `DRY_RUN`, `TELEGRAM_ENABLED` |
| **공유 인프라 우선** | 새 기능 구현 전 `packages/core` 에 있는지 먼저 확인 | `packages/playwright-utils` |

#### 모듈화 원칙

```
✅ 올바른 구조:
  lib/
  ├── secrets.js       ← 모든 봇 공통 시크릿 로더
  ├── telegram.js      ← 텔레그램 발송 (봇 무관 공용)
  ├── health.js        ← 헬스체크 (스카/루나 공용 패턴)
  ├── mode.js          ← DEV/OPS 모드 분기 (공용)
  └── error-tracker.js ← 연속 오류 카운터 (공용)

❌ 금지 패턴:
  각 봇이 sendTelegram 직접 구현 (복붙 금지)
  하드코딩된 파일 경로 반복 사용
  동일 함수를 봇마다 중복 작성
```

#### 옵션화 원칙

> 기능을 ON/OFF 할 수 있도록 옵션(플래그·환경변수)으로 설계한다.
> 하드코딩으로 기능을 고정하지 말고, 나중에 다른 봇·프로젝트에서 일부만 선택 사용할 수 있게 한다.

```javascript
// ✅ 옵션화 패턴 — 플래그로 기능 선택
function createHealthChecker({
  enableTelegram = true,   // 텔레그램 알림 ON/OFF
  enableAutoFix  = false,  // 자동 수정 ON/OFF
  reportOnly     = false,  // 무음 모드
} = {}) { ... }

// 봇마다 필요한 옵션만 선택
const checker = createHealthChecker({ enableAutoFix: true });  // 덱스터
const checker = createHealthChecker({ reportOnly: true });      // CI 테스트

// ✅ CLI 플래그로 실행 시 옵션 선택 (args.js 사용)
// node dexter.js --telegram --fix --full
```

```javascript
// ❌ 금지 패턴 — 기능이 하드코딩됨
function checkHealth() {
  sendTelegram(...);  // 항상 텔레그램 발송, 끌 수 없음
  autoFix(...);       // 항상 자동 수정, 테스트 불가
}
```

#### 공용 라이브러리 현황

| 라이브러리 | 위치 | 사용 봇 |
|-----------|------|---------|
| `telegram.js` | `lib/telegram.js` | 스카, 루나, 클로드팀 |
| `secrets.js` | `lib/secrets.js` (봇별) | 각 봇 |
| `health.js` | `lib/health.js` | 스카, 루나 |
| `mode.js` | `lib/mode.js` | 스카, 루나 |
| `error-tracker.js` | `lib/error-tracker.js` | 스카, 루나 |
| `status.js` | `lib/status.js` | 루나 |
| `args.js` | `lib/args.js` | 스카, 클로드팀 |
| `team-bus.js` | `bots/claude/lib/team-bus.js` | 클로드팀 전용 (덱스터↔아처 통신) |
| `playwright-utils` | `packages/playwright-utils/` | 스카 |
| `core` | `packages/core/` | 모든 봇 |

> **새 기능 추가 전 체크**: 유사 기능이 이미 lib/에 있는지 확인 → 없으면 추가 후 공용화

### 보안 원칙 (전체 봇 공통 필수)

| 원칙 | 내용 |
|------|------|
| **시크릿 금지** | 코드·환경변수·로그에 API키·비밀번호 절대 포함 금지. `secrets.json`만 사용 |
| **로그 마스킹** | 전화번호·이름·API키 로그 출력 시 반드시 마스킹 |
| **입력 검증** | 외부 입력(사용자·API·DB) 항상 검증 후 사용 |
| **인젝션 방지** | `spawn` 배열 방식 사용. `exec` 문자열 방식 금지 |
| **최소 권한** | API 키는 필요한 권한만. 출금·삭제 권한 기본 금지 |
| **감사 로그** | 중요 작업(주문·취소·변경)은 DB에 기록 — 추적 가능해야 함 |
| **암호화** | 개인정보·금융정보 DB 저장 시 AES-256-GCM 암호화 필수 |
| **gitignore** | `secrets.json`, `config.yaml`, `*.db`, `*.jsonl`, `.env` 커밋 절대 금지 |
| **설정 파일 분리** | API 키가 포함된 설정 파일(config.yaml 등)은 반드시 `.gitignore` 등록 후 `.example` 템플릿만 커밋 |

---

## 1. 파일 구조

### bots/reservation/ (스카봇 기준)

```
bots/reservation/
├── src/                            ← 실행 스크립트
│   ├── naver-monitor.js            메인 루프 (감지 + 오케스트레이션)
│   ├── pickko-accurate.js          픽코 신규 등록 Stage [1~9]
│   ├── pickko-cancel.js            픽코 취소 Stage [1~10]
│   ├── pickko-verify.js            미검증 예약 재검증 + 자동 등록
│   ├── pickko-daily-audit.js       당일 감사 (launchd 22:00+23:50)
│   ├── pickko-kiosk-monitor.js     키오스크 감지 → 네이버 차단/해제 (launchd 30분)
│   ├── pickko-daily-summary.js     일일 요약 + 매출 보고 (launchd 09:00/00:00)
│   ├── pickko-revenue-confirm.js   매출 컨펌 CLI
│   ├── pickko-register.js          NLP 예약 등록 CLI (stdout JSON)
│   ├── pickko-cancel-cmd.js        NLP 취소 CLI (stdout JSON)
│   ├── pickko-query.js             NLP 예약 조회 CLI (stdout JSON)
│   ├── pickko-stats-cmd.js         NLP 매출 통계 CLI (stdout JSON)
│   ├── pickko-ticket.js            NLP 이용권 추가 CLI (stdout JSON)
│   ├── pickko-member.js            NLP 회원 가입 CLI (stdout JSON)
│   ├── bug-report.js               버그/유지보수 추적 CLI
│   ├── start-ops.sh                OPS 자동 재시작 루프 (self-lock)
│   └── run-*.sh                    launchd 실행 래퍼 (lock + 로테이션)
├── lib/                            ← 공유 라이브러리
│   ├── args.js                     CLI 인수 파싱 (parseArgs)
│   ├── browser.js                  Playwright 런치 옵션 + 다이얼로그 핸들러
│   ├── cli.js                      NLP CLI 공통 래퍼
│   ├── crypto.js                   AES-256-GCM 암호화/복호화
│   ├── db.js                       SQLite 싱글턴 + 스키마 + 도메인 함수
│   ├── files.js                    loadJson / saveJson (원자적 쓰기)
│   ├── formatting.js               toKoreanTime / pickkoEndTime / formatPhone
│   ├── pickko.js                   loginToPickko / fetchPickkoEntries / findPickkoMember
│   ├── pickko-stats.js             픽코 매출 스크래퍼
│   ├── secrets.js                  loadSecrets()
│   ├── telegram.js                 Telegram Bot API 직접 발송 + pending queue
│   ├── utils.js                    delay / log
│   └── validation.js               전화번호/날짜/시간 정규화
├── scripts/
│   ├── session-close.js            세션 마감 자동화
│   ├── deploy-context.js           OpenClaw 컨텍스트 배포
│   ├── reload-monitor.sh           빠른 재시작 (문법 체크 → 재시작, E2E 없음)
│   └── lib/                        스크립트 공유 모듈
├── context/
│   ├── CLAUDE_NOTES.md             클로드 → 스카 행동 지침
│   └── BOOT.md                     게이트웨이 시작 시 자동 주입 컨텍스트
└── secrets.json                    인증 정보 (gitignore 필수)
```

### packages/ (멀티봇 공유 인프라)

```
packages/
├── core/               모든 봇 공유 유틸리티
└── playwright-utils/   Playwright 헬퍼
bots/_template/         새 봇 스캐폴딩
```

**핵심 원칙**: src/ 파일 추가 후 더 이상 사용하지 않으면 `archive/`로 이동.

---

## 2. 시크릿 & 보안 관리

> ### 🔒 Security by Design 원칙
>
> **보안은 "기억해서 지키는 규칙"이 아니라 "어기면 코드가 실행되지 않는 구조"로 만든다.**
>
> IT를 잘 모르는 사람도, 바쁜 상황에서도, 실수로라도 보안을 우회할 수 없게 코드 자체가 차단한다.
>
> - ❌ `secrets.json` 없이 봇 시작 → 즉시 종료
> - ❌ 필수 키 누락 → 즉시 종료
> - ❌ DEV 모드에서 실제 주문 → 즉시 거부 (코드 레벨)
> - ❌ 한도 초과 주문 → 즉시 거부 (설정값이 아닌 코드 레벨)
> - ❌ `secrets.json` git 추가 시도 → pre-commit hook이 차단

### 2-1. secrets.json 계층 구조

봇 종류에 따라 secrets.json을 **분리 저장**한다. 하나의 파일에 모든 시크릿을 몰아두지 않는다.

```
bots/reservation/secrets.json    ← 스카봇 전용 (네이버, 픽코, 텔레그램)
bots/investment/secrets.json     ← 투자봇 전용 (거래소 API, 텔레그램)
# 절대 루트에 secrets.json 두지 않을 것
```

### 2-2. secrets.json 키 목록 (봇별)

**스카봇 (`bots/reservation/secrets.json`)**
```json
{
  "naver_id": "",
  "naver_pw": "",
  "pickko_id": "",
  "pickko_pw": "",
  "naver_url": "",
  "pickko_url": "",
  "telegram_bot_token": "",
  "telegram_chat_id": "",
  "db_encryption_key": "",     // 64자 hex (AES-256-GCM 키)
  "db_key_pepper": ""          // SHA256 해시 pepper
}
```

**투자봇 (`bots/investment/secrets.json`)**
```json
{
  "binance_api_key": "",        // 거래 권한만, 출금 권한 ❌
  "binance_api_secret": "",
  "upbit_access_key": "",       // 거래 권한만, 출금 권한 ❌
  "upbit_secret_key": "",
  "telegram_bot_token": "",     // 투자봇 전용 별도 봇 토큰
  "telegram_chat_id": "",
  "db_encryption_key": "",      // 스카봇과 다른 키 사용
  "db_key_pepper": "",
  "max_order_usdt": 100,        // 최대 1회 주문 한도 (USDT) — 코드 아닌 설정으로 관리
  "max_position_usdt": 500      // 최대 포지션 한도 (USDT)
}
```

### 2-3. 시크릿 로딩 — 강제 검증 패턴

`lib/secrets.js`는 단순한 파일 로더가 아니라 **보안 게이트**다.
필수 키가 없거나 비어 있으면 봇 자체가 시작되지 않는다.

```javascript
// lib/secrets.js — 이렇게 구현되어야 한다
function loadSecrets(requiredKeys = []) {
  let secrets;
  try {
    secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8'));
  } catch {
    console.error('❌ secrets.json 없음 또는 파싱 실패 — 봇 시작 불가');
    process.exit(1);  // 여기서 무조건 종료
  }

  // 필수 키 누락 → 시작 불가
  for (const key of requiredKeys) {
    if (!secrets[key] || secrets[key] === '') {
      console.error(`❌ secrets.json 필수 키 누락: "${key}" — 봇 시작 불가`);
      process.exit(1);
    }
  }
  return secrets;
}

// ✅ 사용법 — 봇 시작 시 필수 키 명시
const SECRETS = loadSecrets([
  'binance_api_key', 'binance_api_secret',
  'telegram_bot_token', 'db_encryption_key'
]);
// → 위 키 중 하나라도 없으면 즉시 종료, 이후 코드 실행 불가
```

```javascript
// ❌ 절대 금지 패턴 3가지
const API_KEY = 'abc123...';              // 하드코딩
const API_KEY = process.env.BINANCE_KEY;  // 환경변수 (로그 노출 위험)
log(`key: ${SECRETS.binance_api_key}`);   // 로그 출력
```

### 2-4. 거래소 API 키 권한 원칙 (투자봇 필수)

| 권한 | 허용 | 이유 |
|------|------|------|
| 잔고 조회 | ✅ | 필수 |
| 주문 생성/취소 | ✅ | 필수 |
| **출금** | ❌ **절대 금지** | 탈취 시 전액 인출 가능 |
| **다른 주소로 전송** | ❌ **절대 금지** | 동일 이유 |
| IP 화이트리스트 | ✅ **필수 설정** | 맥미니 고정 IP or Tailscale IP만 허용 |

> 거래소 설정에서 API 키 생성 시 **출금 권한 체크 금지**, **IP 제한 필수**.

### 2-4-B. pre-commit hook — git 실수 자동 차단

사람이 실수로 `git add secrets.json`을 해도 커밋이 막힌다.

```bash
# .git/hooks/pre-commit (실행 권한 필요: chmod +x)
#!/bin/bash

BLOCKED=(
  "secrets.json"
  ".env"
  "state.db"
  "*.jsonl"
)

for pattern in "${BLOCKED[@]}"; do
  if git diff --cached --name-only | grep -q "$pattern"; then
    echo "❌ 보안 차단: '$pattern' 파일은 커밋할 수 없습니다."
    echo "   git reset HEAD $pattern 으로 스테이징을 취소하세요."
    exit 1
  fi
done
```

```bash
# 프로젝트 초기 1회 설정
cp scripts/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

> ⚠️ **사고 사례 (2026-03-03)**: `bots/investment/config.yaml`에 Anthropic·Groq·Binance 등 실제 API 키를 포함한 채로 4회 커밋됨. 원인: `.gitignore` 미등록 + pre-commit 훅이 `.yaml` 파일을 검사하지 않았음.
> - **수정**: pre-commit 훅 검사 대상에 `.yaml`, `.yml`, `.sh`, `.env` 추가
> - **교훈**: API 키가 포함될 수 있는 **모든 설정 파일**은 파일 생성 시점에 즉시 `.gitignore` 등록

### 2-5. gitignore 필수 항목

```gitignore
# 시크릿
**/secrets.json
**/*.env
**/.env*

# API 키 포함 설정 파일 — .example 파일만 커밋
bots/investment/config.yaml

# DB (개인정보 + 거래 데이터)
**/state.db
**/state.db-wal
**/state.db-shm

# 런타임 파일
**/*.jsonl
**/pending-telegrams.jsonl

# 로그 (거래 내역 포함 가능)
**/logs/
*.log
```

> **규칙**: API 키가 들어가는 파일을 새로 만들 때 → 파일 생성 직후 `.gitignore` 등록 → `.example` 파일 먼저 커밋 → 실제 키 입력

### 2-6. 키 노출 사고 대응 절차

API 키가 노출됐거나 의심될 때 즉시 실행:

```
1. 거래소 로그인 → API 관리 → 해당 키 즉시 삭제
2. 활성 주문 전체 취소
3. 텔레그램으로 사고 알림
4. 새 API 키 발급 (IP 제한 재확인)
5. secrets.json 교체 후 서비스 재시작
6. 거래 이력 확인 (무단 거래 여부)
```

---

---

## 3. 경로 관리

```javascript
const WORKSPACE = path.join(process.env.HOME, '.openclaw', 'workspace');

const DB_PATH     = path.join(WORKSPACE, 'state.db');       // SQLite DB
const LOCK_FILE   = path.join(WORKSPACE, 'naver-monitor.lock');
const PENDING_TG  = path.join(WORKSPACE, 'pending-telegrams.jsonl');
const LOG_DIR     = '/tmp/';                                 // 로그는 /tmp/
```

**맥미니 이전 시 복사 대상**: `state.db` + `secrets.json` 2개만.

---

## 4. 상태 관리 — SQLite (lib/db.js)

### DB 위치 및 구조

```
~/.openclaw/workspace/state.db  (WAL 모드)

reservations      네이버 예약 상태 추적
cancelled_keys    취소 처리 중복 방지
kiosk_blocks      키오스크 예약불가 차단 상태
alerts            텔레그램 알람 이력
daily_summary     일별 매출 요약
room_revenue      룸별 확정 매출 누적
```

### 사용 패턴

```javascript
const { getDb, getReservation, upsertReservation } = require('../lib/db');

// better-sqlite3는 동기 API — await 불필요
const db = getDb();  // 싱글턴, WAL 자동 설정

// 예약 조회
const row = getReservation(bookingId);

// 상태 업데이트
upsertReservation(bookingId, {
  status: 'completed',
  pickko_status: 'paid',
  updated_at: new Date().toISOString()
});
```

### 예약 상태 흐름

```
감지 → pending → processing → completed (pickko_status: paid → verified)
                            ↘ failed (retries 증가)
                                ↓ retries >= MAX_RETRIES(5)
                            포기 + 텔레그램 최종 알람
```

| status | 설명 |
|--------|------|
| `pending` | 감지됨, 픽코 등록 대기 |
| `processing` | pickko-accurate.js 실행 중 |
| `completed` | 픽코 등록 완료 |
| `failed` | 실패 (retries 증가) |

| pickko_status | 설명 |
|--------------|------|
| `null` | 처리 전 |
| `paid` | 등록+결제 완료 (미검증) |
| `verified` | pickko-verify.js 확인 완료 |
| `time_elapsed` | 시간 경과로 등록 생략 |
| `auto` | verify 중 자동 재등록 |
| `manual` | 수동 처리 |

### 암호화 규칙

- `phone_raw_enc`, `name_enc` 컬럼: AES-256-GCM 암호화 (`lib/crypto.js`)
- `kiosk_blocks` PK: SHA256(phoneRaw|date|start + pepper) — 전화번호 비노출
- 복호화 시 `decrypt(enc, key)` 사용

---

## 5. 텔레그램 알림 (lib/telegram.js)

### OpenClaw 우회 — Bot API 직접 호출

```javascript
const { sendTelegram, flushPendingTelegrams } = require('../lib/telegram');

// 메시지 발송 (3회 재시도, 실패 시 pending queue 저장)
await sendTelegram('✅ 예약 등록 완료: 홍길동 2026-03-01 A1 14:00~16:00');

// 재시작 시 보류 메시지 일괄 재발송
await flushPendingTelegrams();  // naver-monitor.js 시작 시 호출
```

### 알람 유실 방지 패턴

```
발송 시도 (3회) → 성공 → 완료
              ↘ 최종 실패 → pending-telegrams.jsonl 저장
                            → 재시작 시 flushPendingTelegrams() 자동 재발송
```

### 비활성화

```bash
TELEGRAM_ENABLED=0 node pickko-verify.js  # 테스트 시 발송 차단
```

---

## 6. CLI stdout JSON 컨벤션

NLP 명령용 CLI 스크립트는 반드시 stdout으로 JSON을 반환한다.

```javascript
// ✅ 올바른 패턴
console.log(JSON.stringify({ success: true, message: '예약 등록 완료.', data: { orderId: 930001 } }));
process.exit(0);

// 실패 시
console.log(JSON.stringify({ success: false, message: '회원 없음: 010-1234-5678' }));
process.exit(1);
```

### 이유

- 봇(LLM)이 결과를 JSON으로 파싱해서 자연어로 변환
- 사람이 직접 실행해도 읽을 수 있음
- `child_process.spawn` 부모 프로세스가 `stdout`으로 결과 수신

### 표준 필드

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `success` | boolean | ✅ | 성공 여부 |
| `message` | string | ✅ | 사용자에게 보여줄 메시지 |
| `data` | object | - | 추가 데이터 |

---

## 7. exit code 체계

| code | 의미 | naver-monitor 처리 |
|------|------|--------------------|
| `0` | 성공 | `completed/paid` |
| `1` | 일반 실패 | `failed`, retries++ |
| `2` | TIME_ELAPSED (시간 경과) | `completed/time_elapsed` (재시도 없음) |
| `99` | MAX_RETRIES 초과 포기 | 텔레그램 최종 알람 후 종료 |

---

## 8. args.js 사용법

```javascript
const { parseArgs } = require('../lib/args');
const args = parseArgs(process.argv.slice(2));

// --phone=010-1234-5678  → args.phone  = '010-1234-5678'
// --date=2026-03-01      → args.date   = '2026-03-01'
// --dry-run              → args['dry-run'] = true  (boolean flag)
// --name 홍길동           → args.name  = '홍길동'
```

**boolean flag**: 다음 인수가 `--`로 시작하거나 인수가 없으면 `true`로 파싱됨.

---

## 9. 프로세스 관리 (spawn 패턴)

```javascript
const { spawn } = require('child_process');

const child = spawn('node', [
  'pickko-accurate.js',
  `--phone=${booking.phone}`,
  `--date=${booking.date}`,
  `--start=${booking.start}`,
  `--end=${booking.end}`,
  `--room=${booking.room}`,
  `--name=${booking.name}`,
], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe']
});

child.stdout.on('data', d => process.stdout.write(d));
child.stderr.on('data', d => process.stderr.write(d));
child.on('close', (code) => {
  if (code === 0)  /* completed/paid */
  if (code === 2)  /* time_elapsed */
  if (code === 99) /* 포기 */
  else             /* failed, retries++ */
});
```

**주의**: `naveraPage.close()` 금지 — spawn 후 네이버 페이지 닫으면 detached Frame 오류.

---

## 10. Playwright 패턴

### 브라우저 실행 옵션

```javascript
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');

const browser = await puppeteer.launch(getPickkoLaunchOptions());
// PICKKO_HEADLESS=1 환경변수로 headless 모드 제어
```

### page.click() vs page.evaluate() 선택 기준

```javascript
// ✅ jQuery 이벤트 핸들러가 있는 요소는 page.evaluate() 사용
// (page.click()은 CDP callFunctionOn protocolTimeout 유발 가능)
await page.evaluate(() => {
  if (window.jQuery?.fn?.datepicker)
    window.jQuery('input#start_date').datepicker('show');
  else
    document.querySelector('input#start_date')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

// ✅ React SPA 날짜 피커는 page.mouse.click() 사용
await page.mouse.click(x, y);
```

### Playwright 셀렉터 폴백 체인

단일 셀렉터에 의존하지 말 것. 항상 폴백 체인을 구성한다.

```javascript
// 예: pickko-accurate.js Stage [6] 4-Tier Fallback
const selectors = [
  `li[date="${date}"][st_no="${stNo}"][start="${start}"][mb_no=""]`,
  `li[date="${date}"][st_no="${stNo}"][start="${start}"]`,
  `li[st_no="${stNo}"][start="${start}"]`,
  null  // Method-4: li[start] 전체 순회
];
for (const sel of selectors) {
  const el = sel ? await page.$(sel) : await findByIterating(page, start);
  if (el) { await el.click(); break; }
}
```

---

## 11. launchd 패턴

### plist 파일 위치

```
~/Library/LaunchAgents/ai.ska.{서비스명}.plist
```

### 스케줄 plist 예시 (pickko-verify: 08:00/14:00/20:00)

```xml
<key>StartCalendarInterval</key>
<array>
  <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>
  <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>0</integer></dict>
  <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>0</integer></dict>
</array>
```

### 인터벌 plist 예시 (kiosk-monitor: 30분)

```xml
<key>StartInterval</key><integer>1800</integer>
```

### KeepAlive plist 예시 (naver-monitor: 상시 실행)

```xml
<key>KeepAlive</key><true/>
```

### launchctl 명령

```bash
# 등록
launchctl load ~/Library/LaunchAgents/ai.ska.{서비스}.plist

# 해제
launchctl unload ~/Library/LaunchAgents/ai.ska.{서비스}.plist

# 상태 확인
launchctl list | grep ai.ska
```

### 빠른 재시작 — reload-monitor.sh

코드 수정 후 E2E 테스트(~3분) 없이 빠르게 재시작할 때 사용.
**직접 `launchctl unload/load` 금지** — 문법 오류 검증 없이 즉시 반영되어 장애 유발 가능.

```bash
# ✅ 코드 수정 후 항상 이것으로 재시작
bash scripts/reload-monitor.sh
# → 문법 체크 → 정지 → 재시작 → PID 확인 순으로 자동 처리

# ❌ 절대 금지 — 문법 오류 검증 없이 즉시 반영
launchctl unload ~/Library/LaunchAgents/ai.ska.naver-monitor.plist
launchctl load  ~/Library/LaunchAgents/ai.ska.naver-monitor.plist
```

### 실행 래퍼 (run-*.sh) 필수 패턴

```bash
LOCK="/tmp/{서비스}.lock"
LOG="/tmp/{서비스}.log"

[ -f "$LOCK" ] && ps -p $(cat "$LOCK") > /dev/null 2>&1 && exit 0  # 중복 실행 방지
echo $$ > "$LOCK"
trap "rm -f '$LOCK'" EXIT

# 로그 로테이션 (1000줄)
if [ -f "$LOG" ] && [ $(wc -l < "$LOG") -gt 1000 ]; then
  tail -500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

node /path/to/script.js >> "$LOG" 2>&1
```

---

## 12. OpenClaw / LLM 연동 패턴

### BOOT.md 컨텍스트 설계 원칙

```
❌ 파일 읽기 지시 (--sync, read DEV_SUMMARY.md 등) → API 왕복 증가 → 느림
✅ 핵심 컨텍스트 BOOT.md에 인라인 포함 → 2턴, 54초
```

**BOOT.md 포함 항목**: IDENTITY + MEMORY (현재 상태 + 핵심 지침)
**BOOT.md 제외 항목**: DEV_SUMMARY, HANDOFF (봇이 필요할 때 별도 요청)

### CLAUDE_NOTES.md 패턴

클로드(개발자 AI)가 봇(스카)에게 행동 지침을 전달하는 전용 파일.

```
변경 사항 → CLAUDE_NOTES.md 업데이트 → deploy-context.js 실행 → BOOT.md 재생성
```

봇 행동이 달라지는 코드 변경 시 CLAUDE_NOTES.md의 행동 지침 테이블 반드시 업데이트.

### deploy-context.js 실행 시점

```bash
# 코드 변경 후 봇 재배포 시
node scripts/deploy-context.js --bot=reservation
```

### 세션 마감 자동화

```bash
node scripts/session-close.js \
  --bot=reservation \
  --title="기능명" \
  --type=feature \        # feature / fix / refactor / config
  --items="항목A|항목B" \
  --files="a.js|b.js"
```

### Anthropic SDK 직접 호출 패턴 (Python)

OpenClaw를 통하지 않고 Python 코드에서 Claude API를 직접 호출할 때 (forecast.py 월간 진단 등):

```python
import anthropic

client = anthropic.Anthropic(api_key=os.environ['ANTHROPIC_API_KEY'])

resp = client.messages.create(
    model='claude-haiku-4-5-20251001',   # 고빈도·단순 분석 → Haiku
    max_tokens=500,
    temperature=0.1,                     # 분석용 — 낮은 온도로 일관된 결과
    system=[
        {
            "type": "text",
            "text": "역할 정의 (정적 텍스트)",
            "cache_control": {"type": "ephemeral"},  # Prompt Caching (5분 TTL)
        }
    ],
    messages=[{'role': 'user', 'content': user_content}],
)
result = resp.content[0].text.strip()
```

**에러 처리 — 구체적으로 분기:**
```python
except anthropic.RateLimitError:
    return '(API 한도 초과 — 잠시 후 재시도)'
except anthropic.AuthenticationError:
    return '(ANTHROPIC_API_KEY 인증 실패)'
except Exception as e:
    return f'(LLM 호출 실패: {e})'
```

**Prompt Caching 원칙:**
- 정적인 system 프롬프트(역할 정의, 규칙 등)에만 `cache_control` 적용
- 동적 데이터(사용자 입력, 실시간 지표)는 캐싱 대상 아님
- 캐시 읽기 비용: 입력 토큰의 10% (최대 90% 절감)

**temperature 가이드:**
| 용도 | temperature |
|------|------------|
| 분석·진단·JSON 추출 | 0.0~0.2 |
| 일반 응답·요약 | 0.3~0.7 |
| 창의적 생성 | 0.8~1.0 |

---

## 13. 모델 선택 가이드

### 현재 OpenClaw 스택 (스카봇)

| 순서 | 모델 | 용도 | TTFT | 비용 |
|------|------|------|------|------|
| Primary | `google-gemini-cli/gemini-2.5-flash` | 기본 | ~608ms | 무료 (Google OAuth) |
| Fallback 1 | `anthropic/claude-haiku-4-5` | 빠른 응답 | ~300ms | 유료 |
| Fallback 2 | `ollama/qwen2.5:7b` | 비상용 | ~811ms | 로컬 |

### 속도 테스트 결과 (2026-02-26)

| 모델 | TTFT | 상태 |
|------|------|------|
| `groq/llama-3.1-8b-instant` | 203ms | 무료, Phase 3 교체 검토 |
| `groq/llama-4-scout-17b` | 211ms | 무료 |
| `groq/llama-3.3-70b-versatile` | 225ms | 무료 |
| `gemini-2.5-flash` | 608ms | 현재 primary |
| `ollama/qwen2.5:7b` | 811ms | 로컬 (MLX 미지원) |

### 봇별 권장 모델 (LLM_DOCS 기준)

| 봇 | Primary | Fallback | 이유 |
|----|---------|---------|------|
| 스카봇 (OpenClaw) | `gemini-2.5-flash` | `claude-haiku-4-5` | 무료 OAuth, 고빈도 |
| 스카봇 LLM 진단 (직접 호출) | `claude-haiku-4-5-20251001` | — | 저비용, 분석 충분 |
| 클로드팀 아처 (주간 기술 분석) | `claude-sonnet-4-6` | — | 복잡한 패치 티켓 생성 |
| 클로드팀 덱스터 (일일 리포트) | `claude-haiku-4-5-20251001` | — | 비용 최적화 |
| 미래 투자봇 오케스트레이터 | `claude-sonnet-4-6` | `gemini-2.5-flash` | 복잡한 멀티에이전트 결정 |
| 미래 투자봇 분석가 (고빈도) | `groq/llama-3.3-70b` | `claude-haiku-4-5` | 속도 3배, 무료 |

### Claude 모델 ID (최신)

| 모델 | 컨텍스트 | 용도 |
|------|---------|------|
| `claude-opus-4-6` | 200K | 최고 성능, 복잡한 추론 |
| `claude-sonnet-4-6` | 200K | 오케스트레이터 권장 |
| `claude-haiku-4-5-20251001` | 200K | 고빈도 봇, 분석 (권장) |

### 모델 교체 CLI

```bash
openclaw models set google-gemini-cli/gemini-2.5-flash
# prefix 주의: google-gemini-cli/ (일반 gemini/ 아님)
```

### Gemini-2.5-flash 알려진 quirks

- `streamMode`: `"partial"` | `"block"` (권장) | `"off"` (전송 차단)
- `<execute_tool>` 텍스트 누출 버그 → **종결** (2026-02-27 전수 검사 0건 확인)
- Ollama 맥북 M3: Homebrew 빌드는 MLX GPU 가속 미지원 → CPU 전용, 봇용 사용 불가

---

## 14. DEV / OPS 분리

```bash
# DEV (기본, 픽코 실행 차단)
node src/naver-monitor.js

# OPS (운영, 픽코 실행 허용) — start-ops.sh가 자동 설정
MODE=ops PICKKO_ENABLE=1 OBSERVE_ONLY=${OBSERVE_ONLY:-0} PICKKO_CANCEL_ENABLE=1 PICKKO_HEADLESS=1 \
  node src/naver-monitor.js
```

| 환경변수 | 기본 | 설명 |
|---------|------|------|
| `MODE` | `dev` | `ops`일 때만 픽코 실행 |
| `PICKKO_ENABLE` | `0` | `1`이어야 픽코 활성화 |
| `OBSERVE_ONLY` | `0` | `1`이면 화이트리스트 번호만 실행 (관찰 모드) |
| `PICKKO_CANCEL_ENABLE` | `0` | `1`이어야 자동 취소 |
| `PICKKO_HEADLESS` | `0` | `1`이면 완전 headless |

> **OBSERVE_ONLY 설정 방법**: `start-ops.sh`는 `${OBSERVE_ONLY:-0}` 패턴 사용.
> plist `EnvironmentVariables`에 `OBSERVE_ONLY=1` 추가 → 화이트리스트 모드 활성화.
> plist에서 제거하면 기본값 `0` (전체 OPS) 복원.
> **하드코딩(`OBSERVE_ONLY=0`) 절대 금지** — plist 설정이 무시되어 오취소 유발.

**DEV 화이트리스트**: 이재룡 010-3500-0586 / 김정민 010-5435-0586

---

## 15. 개인정보 보호

### 암호화 패턴 (lib/crypto.js)

```javascript
const { encrypt, decrypt, hashKioskKey } = require('../lib/crypto');
const key = Buffer.from(SECRETS.db_encryption_key, 'hex');

// 저장 시
const nameEnc = encrypt(name, key);          // AES-256-GCM → base64

// 읽을 때
const name = decrypt(nameEnc, key);

// kiosk_blocks PK (전화번호 비노출)
const blockKey = hashKioskKey(phoneRaw, date, start, SECRETS.db_key_pepper);
```

### 규칙

- `phone_raw_enc`, `name_enc`: DB 저장 시 반드시 암호화
- 로그에 전화번호 마스킹: `phone.slice(0,3) + '****' + phone.slice(-4)`
- 개인정보 포함 파일 gitignore 필수 (`state.db`, `secrets.json`, `*.jsonl`)

---

## 16. 시큐어 코딩

### 16-A. 투자봇 전용 보안 수칙 ⚠️

> 실제 자금이 오가는 코드. 아래 수칙은 **선택이 아닌 필수**.

#### 주문 실행 전 이중 검증

```javascript
// ✅ 필수 패턴 — 주문 직전 가드 체크
function validateOrder(order, secrets) {
  // 1. 한도 초과 차단
  if (order.usdt > secrets.max_order_usdt) {
    throw new Error(`주문 한도 초과: ${order.usdt} > ${secrets.max_order_usdt} USDT`);
  }
  // 2. OPS 모드 확인
  if (process.env.MODE !== 'ops') {
    throw new Error('DEV 모드에서는 실제 주문 불가. MODE=ops 필요.');
  }
  // 3. 심볼 화이트리스트 확인
  const ALLOWED_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
  if (!ALLOWED_SYMBOLS.includes(order.symbol)) {
    throw new Error(`허용되지 않은 심볼: ${order.symbol}`);
  }
}
```

#### 킬 스위치 (긴급 전체 청산)

```javascript
// 모든 투자봇 모듈에 킬 스위치 체크 포함
const KILL_SWITCH_FILE = path.join(WORKSPACE, 'KILL_SWITCH');

function checkKillSwitch() {
  if (fs.existsSync(KILL_SWITCH_FILE)) {
    log('🚨 킬 스위치 활성화 — 모든 주문 중단');
    // 활성 포지션 전체 시장가 청산
    await closeAllPositions();
    process.exit(99);
  }
}
// 주문 루프마다 호출
```

```bash
# 긴급 상황 시 킬 스위치 활성화
touch ~/.openclaw/workspace/KILL_SWITCH
```

#### 거래 감사 로그 (Audit Trail)

```javascript
// ✅ 모든 주문 시도를 DB에 기록 — 성공/실패 무관
await logTrade({
  timestamp: new Date().toISOString(),
  symbol: order.symbol,
  side: order.side,          // 'BUY' | 'SELL'
  qty: order.qty,
  price: order.price,
  status: 'attempted',       // → 'filled' | 'rejected' | 'error'
  orderId: null,             // 거래소 응답 후 업데이트
  reason: order.reason,      // LLM 판단 근거 (간략)
});
```

#### 포지션 한도 초과 방지

```javascript
// 신규 주문 전 현재 포지션 합산 확인
const totalExposure = await getTotalPositionUsdt();
if (totalExposure + order.usdt > secrets.max_position_usdt) {
  await sendTelegram(`⚠️ 포지션 한도 도달: ${totalExposure} USDT — 주문 취소`);
  return;
}
```

#### 텔레그램 주문 확인 알림 (실거래 필수)

```javascript
// ✅ 모든 체결 즉시 알림
await sendTelegram(
  `📊 주문 체결\n` +
  `${order.side} ${order.qty} ${order.symbol}\n` +
  `체결가: $${fill.price}\n` +
  `금액: $${fill.usdt} USDT\n` +
  `포지션: $${totalExposure} USDT`
);
```

#### DEV 모드 강제 시뮬레이션 (우회 불가 구조)

```javascript
// ✅ DEV 모드 차단은 개별 함수가 아닌 Exchange 클래스 레벨에서 적용
// → 어떤 코드도 실수로 실거래 API를 호출할 수 없음
class SafeExchange {
  constructor(secrets) {
    this._isOps = process.env.MODE === 'ops';
    if (this._isOps) {
      log('⚠️ OPS 모드 — 실제 주문 활성화');
    } else {
      log('🔒 DEV 모드 — 모든 주문 시뮬레이션');
    }
    this._client = this._isOps ? new RealExchangeClient(secrets) : null;
  }

  async createOrder(order) {
    validateOrder(order, this._limits);  // 한도 검증 (여기서도 차단)
    if (!this._isOps) {
      return { simulated: true, orderId: `SIM-${Date.now()}`, ...order };
    }
    return await this._client.createOrder(order);
  }
}
// → new SafeExchange(secrets) 한 번만 생성하면
//   이후 모든 주문은 자동으로 DEV/OPS 분기 처리됨
```

---

### 16-B. 전체 봇 공통 보안 패턴

#### 로그 마스킹 (모든 봇 공통)

```javascript
// ✅ 개인정보·시크릿 로그 마스킹 필수
const maskPhone  = p  => p ? `${p.slice(0,3)}****${p.slice(-4)}` : '';
const maskKey    = k  => k ? `${k.slice(0,4)}...${k.slice(-4)}`  : '';
const maskEmail  = e  => e ? `${e.split('@')[0].slice(0,2)}***@${e.split('@')[1]}` : '';

log(`처리 중: ${maskPhone(phone)}`);    // 010****0586
log(`API Key: ${maskKey(apiKey)}`);     // abcd...wxyz

// ❌ 절대 금지
log(`전화번호: ${phone}`);
log(`API Key: ${SECRETS.binance_api_key}`);
console.log(SECRETS);
```

#### 입력 검증 (시스템 경계에서 반드시 실행)

```javascript
// ✅ 외부 입력은 항상 검증 후 사용 (LLM 출력, 사용자 입력, API 응답 포함)
function validateInput({ phone, date, amount }) {
  if (phone && !/^010-?\d{4}-?\d{4}$/.test(phone))
    throw new Error(`유효하지 않은 전화번호: ${maskPhone(phone)}`);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error(`유효하지 않은 날짜: ${date}`);
  if (amount !== undefined && (isNaN(amount) || amount < 0))
    throw new Error(`유효하지 않은 금액: ${amount}`);
}
```

#### 감사 로그 패턴 (중요 작업 필수)

```javascript
// ✅ 예약 등록·취소, 주문 실행 등 모든 중요 작업 기록
await db.run(`
  INSERT INTO audit_log (action, actor, target, result, detail, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`, [
  'pickko_register',          // 작업 종류
  'naver-monitor',            // 실행 주체
  maskPhone(phone),           // 대상 (마스킹)
  'success',                  // 결과
  JSON.stringify({ date, room, start }), // 상세 (개인정보 제외)
  new Date().toISOString()
]);
```

---

### 명령어 인젝션 방지

```javascript
// ✅ spawn 배열 방식
spawn('node', ['script.js', `--phone=${phone}`], { cwd: __dirname });

// ❌ exec 문자열 방식 (인젝션 가능)
exec(`node script.js --phone=${phone}`);
```

### Puppeteer XSS 방지

```javascript
// ✅ 인수 방식 (안전)
await page.$eval('input', (el, v) => { el.value = v; }, phone);

// ❌ 문자열 보간 (JS 인젝션)
await page.evaluate(`document.querySelector('input').value = '${phone}'`);
```

### 파일 원자적 쓰기 (lib/files.js)

```javascript
// ✅ saveJson 사용 — tmp → rename (원자적)
const { saveJson } = require('../lib/files');
saveJson(filePath, data);

// ❌ 직접 writeFileSync (kill -9 시 파일 손상)
fs.writeFileSync(filePath, JSON.stringify(data));
```

### 외부 서비스 격리

```javascript
// 텔레그램, RAG 등 외부 호출은 항상 try/catch로 격리
try {
  await ragSave(booking);
} catch (e) {
  log(`⚠️ RAG 저장 실패 (무시): ${e.message}`);
  // → 외부 오류가 메인 루프를 중단시키면 안 됨
}
```

---

## 17. 클로드팀 전용 패턴 (덱스터 + 아처)

> 클로드팀(bots/claude/)은 시스템 유지보수 전담팀이다.
> 스카팀·루나팀 코드를 **직접 수정하지 않고**, 점검·알림·패치 티켓 생성까지만 담당한다.

### 17-1. 팀 경계 규칙 (절대 준수)

```javascript
// ✅ 허용: 공유 secrets.json 읽기
const secrets = loadSecrets(['telegram_bot_token', 'telegram_chat_id']);

// ✅ 허용: 클로드팀 전용 DB — team-bus.js를 통해서만
const tb = require('../lib/team-bus');
tb.setStatus('dexter', 'running');

// ❌ 금지: 루나팀 DuckDB 직접 쿼리
const lunaDb = new Database(LUNA_DB_PATH);

// ❌ 금지: 스카팀 state.db 직접 접근 (dexter/ska.js 읽기 전용 제외)
const skaDb = new Database(SKA_STATE_DB);

// ❌ 금지: 다른 팀 소스파일 require
const oracle = require('../../invest/lib/oracle');
```

### 17-2. team-bus.js 사용 규칙

클로드팀 내부 통신은 반드시 `lib/team-bus.js`를 통한다. 직접 DB 쿼리 금지.

```javascript
const tb = require('../lib/team-bus');

// ✅ main() 시작/종료 시에만 상태 업데이트
async function main() {
  tb.setStatus('dexter', 'running', '시스템 점검');
  try {
    await run();
    tb.markDone('dexter');
  } catch (e) {
    tb.markError('dexter', e.message);
    throw e;
  }
}

// ✅ 팀간 메시지: 심각한 이슈 발견 시만 발송 (노이즈 최소화)
tb.sendMessage('dexter', 'archer', 'alert', 'high', '로그 오류 급증', detail);
tb.sendMessage('archer', 'dexter', 'alert', 'critical', 'CVE-2026-XXXX', cve);

// ❌ 금지: checks/*.js 내부에서 tb 직접 호출
// checks/bots.js, checks/ska.js 등에서 team-bus import 금지
```

### 17-3. 아처 서칭 범위 (확정)

```
✅ 수집 대상
  GitHub Releases API  — 의존성 업데이트 (claude-code, node, python, anthropic-sdk)
  npm Registry         — 패키지 최신 버전
  npm audit            — 보안 취약점 (CVE)
  웹 서칭 8개          — Anthropic 뉴스/API Changelog, OpenClaw, HuggingFace, AI 블로그

❌ 수집 금지 (루나팀 담당)
  BTC / ETH 가격       → 루나팀 oracle.js
  Fear & Greed Index   → 루나팀 oracle.js
```

### 17-4. PATCH_REQUEST.md 처리 규칙

```bash
# 위치: 항상 프로젝트 루트
~/projects/ai-agent-system/PATCH_REQUEST.md

# 아처가 생성 → Claude Code RC 세션이 자동 감지 → urgency 순 실행
# critical → high → medium → low

# 완료 후 반드시 삭제 (중복 실행 방지)
rm PATCH_REQUEST.md
```

```javascript
// urgency 정의
// critical — 보안 취약점, 서비스 중단 위험
// high     — API 호환성 변경, 주요 의존성 업데이트
// medium   — 성능 개선, 비필수 업데이트
// low      — 기술 트렌드 적용, 리팩토링

// 패치 커밋 메시지 형식
// git commit -m "patch: PATCH-001 better-sqlite3 보안 업데이트"
```

### 17-5. SESSION.md 업데이트 규칙

Claude Code RC 세션이 끊겼다가 재접속할 때 컨텍스트 복원에 사용한다.
**작업 완료 후 / 세션 중단 전 / 방향 전환 시** 반드시 갱신한다.

```markdown
# SESSION.md 형식

## 🔄 현재 작업
- [ ] 진행 중인 내용 (어디까지 했는지, 뭐가 남았는지)

## ✅ 완료된 작업
- [x] 완료된 내용 (커밋: abc1234, 2026-03-03)

## ➡️ 다음 작업 (재접속 시 여기서 시작)
1. 구체적인 첫 번째 행동
2. 두 번째 행동

## ⚠️ 주의사항
- 중단 이유, 주의할 점, 알아야 할 상황
```

### 17-6. 아처 HTTP 요청 패턴

```javascript
// ✅ Node.js 기본 https 모듈만 사용 (axios, node-fetch 금지)
const https = require('https');

function httpGet(hostname, path, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET',
        headers: { 'User-Agent': 'ai-agent-system/1.0' } },
      (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try   { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, raw: body }); }
        });
      }
    );
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ✅ 여러 소스 병렬 수집 — Promise.allSettled (하나 실패해도 전체 진행)
const results = await Promise.allSettled([
  fetchAllGithub(),
  fetchAllNpm(),
  fetchAllWebSources(),
  runNpmAudit(),
]);
```

### 17-7. Claude API 호출 패턴 (아처 분석)

```javascript
// ✅ JSON 응답 파싱 — 마크다운 코드블록 제거 후 파싱
function parseJsonResponse(text) {
  return JSON.parse(
    text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim()
  );
}
```

---

## 18. 새 기능 추가 체크리스트

### 공통

- [ ] `lib/secrets.js` 패턴으로 인증 정보 로드 (하드코딩 절대 금지)
- [ ] `WORKSPACE` 상수로 경로 처리
- [ ] DEV/OPS 분기 포함 (`MODE === 'ops'`)
- [ ] NLP CLI라면 stdout JSON 컨벤션 적용
- [ ] `lib/telegram.js`로 텔레그램 발송
- [ ] 개인정보 컬럼 암호화 (`lib/crypto.js`)
- [ ] 외부 호출 `try/catch` 격리
- [ ] 실패 시 retries 증가 + MAX_RETRIES 체크
- [ ] 개인정보 포함 파일 gitignore 확인
- [ ] 세션 마감 `node scripts/session-close.js --bot=<봇ID> ...`

### 클로드팀 봇 추가 체크리스트

- [ ] 팀 경계 확인 — 다른 팀 DB/소스 직접 접근 없음
- [ ] team-bus 연동 — main() 시작/종료 시 setStatus/markDone/markError
- [ ] team-bus 직접 DB 쿼리 금지 — lib/team-bus.js 함수만 사용
- [ ] 아처 서칭 범위 준수 — BTC/ETH/FearGreed 수집 코드 없음
- [ ] PATCH_REQUEST.md 위치 — 항상 프로젝트 루트
- [ ] 패치 완료 후 PATCH_REQUEST.md 삭제 로직 포함
- [ ] SESSION.md 업데이트 — 작업 완료/중단 시 갱신
- [ ] 외부 HTTP — Node.js https 모듈만 사용 (axios 등 금지)

### 투자봇 추가 체크리스트 ⚠️ (실거래 전 필수)

- [ ] 거래소 API 키: **출금 권한 없음** + **IP 화이트리스트** 설정 확인
- [ ] `validateOrder()` 가드: 한도·OPS모드·심볼 화이트리스트 검증
- [ ] 킬 스위치 체크 `checkKillSwitch()` 주문 루프에 포함
- [ ] 모든 주문 시도 감사 로그(Audit Trail) DB 기록
- [ ] 포지션 한도 초과 방지 로직 포함
- [ ] 체결 즉시 텔레그램 알림
- [ ] DEV 모드 시뮬레이션 반환 (실제 API 차단)
- [ ] `secrets.json` `max_order_usdt` / `max_position_usdt` 설정
- [ ] 실거래 전 **페이퍼 트레이딩** 1주일 이상 검증
- [ ] 백테스팅 결과 확인 (샤프비율 > 1.0, MDD < 20%)

---

## 변경 이력

| 날짜 | 내용 |
|------|------|
| 2026-02-24 | 최초 작성 (secrets, WORKSPACE, MAX_RETRIES, archive 패턴) |
| 2026-02-27 | 전면 업데이트 — SQLite/DB, telegram 직접 발송, CLI stdout JSON, args.js, exit code, launchd, OpenClaw/LLM 연동, 모델 비교표, 암호화 패턴 추가 |
| 2026-02-27 | **코딩가이드 목적 재정의 + work-history/coding-guide 세션마감 자동화** — coding-guide.md: 핵심 원칙 섹션 추가, 목적 재정의 외 2건 |
| 2026-02-27 | **코딩가이드 Security by Design 전면 적용** — Security by Design 원칙 선언 (어기면 코드가 실행 안 되는 구조) 외 4건 |
| 2026-02-27 | **pre-commit 훅 설치 및 공유 인프라 플랜 완료 검증** — scripts/pre-commit 설치 (.git/hooks/ 등록 + chmod +x) 외 2건 |
| 2026-02-27 | **ST-001~003 완료 + ska 설계 + 백로그 전체 등록** — ST-001 state.db 자동 백업 (launchd 03:00 일일) 외 4건 |
| 2026-02-27 | **FE-002 룸별·시간대별 가동률 리포트 구현** — src/occupancy-report.js 신규: 룸별/시간대별 가동률 계산 외 3건 |
| 2026-02-27 | **FE-005 로그 rotation (copytruncate, 매일 04:05)** — scripts/log-rotate.js 신규: 10개 로그 copytruncate 방식 로테이션 외 3건 |
| 2026-02-27 | **FE-006 gemini-2.5-flash execute_tool 누출 버그 재테스트 — 버그 종결** — gemini-2.5-flash telegram run 6건 전수 검사 — execute_tool 텍스트 누출 0건 외 2건 |
| 2026-02-27 | **FE-009 health-check staleness 체크 추가 (naver-monitor 크래시루프 감지)** — health-check.js: checkNaverLogStaleness() 추가 — 15분 무활동 시 알림 외 2건 |
| 2026-02-27 | **FE-007 mosh 설치 및 아이패드 SSH 환경 개선 검토** — mosh 1.4.0 설치 완료 (brew install mosh) 외 3건 |
| 2026-02-27 | **FE-008 Claude Code 한글 버그 GitHub 이슈 #15705 코멘트 등록** — 기존 이슈 #15705 확인 (OPEN, 9개 코멘트, area:tui bug 레이블) 외 2건 |
| 2026-02-27 | **MD-006: data.go.kr API 키 발급 가이드** — secrets.json 플레이스홀더 4개 추가 외 2건 |
| 2026-02-27 | **픽코 타임아웃 근본 해결 + 자동 버그리포트 + ska-001 + SKA 통일** — pickko-accurate.js 7단계 page.click→evaluate (Runtime.callFunctionOn 타임아웃 근본 해결) 외 5건 |
| 2026-02-27 | **ska-005~008 완료 — 이브크롤링+launchd 스케줄링** — ska-005 이브크롤링(큐넷+수능) — 547건 upsert 343일 외 3건 |
| 2026-02-27 | **ska-006 완료 — Prophet 매출 예측 엔진** — forecast.py Prophet 기본 엔진 (daily/weekly/monthly 3모드) 외 4건 |
| 2026-02-27 | **ska-007 완료 — Prophet regressor exam_events 연동** — forecast.py prophet-v1→v2 업그레이드 외 3건 |
| 2026-02-27 | **ska-014/015: 대학교 크롤링 + 공무원 정적 캘린더** — ska-014: 가천대·단국대 죽전 시험기간 Playwright 크롤링 외 4건 |
| 2026-02-27 | **설계문서 v2.1: 레베카 LLM 제거 확정** — ska-design.md v2.1 업데이트 외 4건 |
| 2026-02-27 | **설계문서 v2.2: Phase 3/3+ 루프 자동화 로드맵** — Phase 3 목표 명확화 (진단→수동 적용, 반자동, 3개월+) 외 3건 |
| 2026-02-27 | **LLM API 코드 개선 (docs 기준)** — forecast.py `_call_llm_diagnosis`: system 파라미터 분리 + Prompt Caching + temperature=0.1 + 에러 세분화 / coding-guide 섹션 12/13: Anthropic SDK 직접 호출 패턴 추가, temperature 가이드, 봇별 권장 모델 표 추가 |
| 2026-02-27 | **tmux Remote Control 설정 + LLM API 코드 개선** — tmux 설치 + ai.ska.tmux launchd 등록 (재부팅 자동 복구) 외 3건 |
| 2026-02-27 | **CL-006 코딩가이드 기준 전체 코드 리팩토링** — maskPhone/maskName 함수 추가 (lib/formatting.js) 외 5건 |
| 2026-02-27 | **pickko-daily-audit/summary 실행 시간 23:50으로 변경** — pickko-daily-audit 22:00→23:50 (plist 수정 + launchd 재등록) 외 1건 |
| 2026-02-28 | **pickko-daily-audit 스케줄 22:00 원복** — pickko-daily-audit 23:50→22:00 원복 (plist 수정 + launchd 재등록) |
| 2026-02-28 | **OpenClaw v2026.2.26 업데이트 및 재시작** — openclaw gateway restart (완전 중지 후 재시작) 외 2건 |
| 2026-02-28 | **스카 재부팅** — openclaw gateway restart → 스카 부팅 완료 (durationMs=59s) |
| 2026-02-28 | **매출 보고 일반이용 합산 수정** — pickko-daily-summary.js: 23:50 자동 보고 합계에 일반이용(스터디카페) 포함 외 3건 |
| 2026-02-28 | **미해결 알림 해제 + 매출 일반이용 합산 수정** — 픽코 취소 실패 알림 수동 resolved 처리 (2026-02-27 18:00 A2) 외 5건 |
| 2026-02-28 | **고아 프로세스 자동 정리 추가** — start-ops.sh cleanup_old()에 고아 tail -f 프로세스 자동 정리 추가 (2시간 재시작마다 실행) |
| 2026-02-28 | **Runtime.callFunctionOn 타임아웃 근본 수정 + DB 중복 레코드 정리** — pickko-accurate.js page.click→evaluate (회원선택 버튼) 외 3건 |
| 2026-02-28 | **23:50 generalRevenue 미수집 + 중복예약 표시 버그 수정** — isMidnight 버그 수정 (hourKST===0 → hourKST===23 외 9건 |
| 2026-02-28 | **CL-006 코딩가이드 리팩토링 완료 확인 + 백필 스크립트** — CL-006 플랜 전항목 완료 확인 (P0~P4 모두 이전 세션에서 구현됨) 외 2건 |
| 2026-03-01 | **새로고침 버튼 fix + 알림 컨텍스트 공유** — naver-monitor 새로고침 버튼 ElementHandle.click→evaluate() 수정 외 3건 |
| 2026-03-01 | **ETL actual_revenue 입금 기준 전환 + pickko_total 분석** — ETL actual_revenue: pickko_total(이용일) → total_amount(입금일) 기준 전환 외 3건 |
| 2026-03-01 | **BOOT 침묵 규칙 통일 + ETL total_amount 기준 변경** — BOOT.md 메시지 전송 규칙 제거(침묵 대기로 통일) 외 5건 |
| 2026-03-01 | **미컨펌 알림 날짜 버그 수정** — 미컨펌 알림 범위 최근 3일 이내로 제한 외 1건 |
| 2026-03-01 | **예약 오류 체크 - 픽코 CDP 타임아웃 원인 분석** — 픽코 예약 실패 원인 확인 (Runtime.callFunctionOn timed out) 외 2건 |
| 2026-03-01 | **스카 재시작 및 부팅 확인** — 스카 재시작 (PID 66467) 외 1건 |
| 2026-03-01 | **투자팀봇 Phase1 구현 및 검증** — bots/invest 전체 구현 (20파일) 외 8건 |
| 2026-03-01 | **투자봇 DEV/OPS 분리 + 3중 체크 시스템** — lib/mode.js DEV/OPS 모드 분리 외 5건 |
| 2026-03-01 | **덱스터 구현 완료 + 일일보고 + 픽스 로그** — 덱스터(Dexter) 클로드팀 점검봇 구현 (8개 체크 모듈) 외 7건 |
| 2026-03-01 | **아처(Archer) 기술 인텔리전스 봇 구현 완료** — lib/archer/config.js 외 8건 |
| 2026-03-01 | **KIS 국내주식 실행봇 크리스 구현** — lib/kis.js KIS Open API 클라이언트 신규 (토큰캐시·OHLCV·매수매도·잔고) 외 5건 |
| 2026-03-01 | **스카팀 루나팀 패턴 적용 ①②③** — DB Migration System (scripts/migrate.js + migrations/) 외 2건 |
| 2026-03-01 | **KIS 실전+모의투자 키 이중화 + API 연결 검증** — secrets.json: kis_paper_app_key/secret 분리 저장 외 4건 |
| 2026-03-01 | **KIS API 연동 완료 및 파이프라인 활성화** — VTS 포트 29443 수정 (기존 9443 오류) 외 4건 |
| 2026-03-01 | **포캐스트 0원 버그 수정 (공휴일 Prophet 과보정)** — forecast.py yhat≤0 폴백 (yhat_upper*0.5 + confidence=0.15) 외 3건 |
| 2026-03-02 | **SKA-P05~P08 루나팀 패턴 적용 + deploy-ops.sh** — lib/error-tracker.js 연속 오류 카운터 (naver-monitor+kiosk-monitor 통합) 외 4건 |
| 2026-03-02 | **3중 가동/중지 lib/health.js + deploy-ops.sh** — lib/health.js 3중 가동(preflightSystemCheck/ConnCheck)+3중 중지(shutdownDB/Cleanup/registerShutdownHandlers) 외 4건 |
| 2026-03-02 | **하트비트 오늘예약현황 추가 + scar→ska 정리 + 절대규칙 등록** — getTodayStats() DB함수 추가 (네이버+키오스크 합계) 외 4건 |
| 2026-03-02 | **OpenClaw 공식문서 검토 + 속도테스트 프로바이더 등록 + LLM_DOCS Cerebras/SambaNova 추가** — 루나팀 분석가 프로바이더 분산(onchain→cerebras, sentiment→sambanova) 외 6건 |
| 2026-03-02 | **OpenClaw OC-001~009 보안·설정 개선 전체 완료** — OC-001 qwen CRITICAL 제거(fallbacks에서 제거) 외 8건 |
| 2026-03-02 | **루나팀 다중심볼+KIS통합강화** — 절대규칙 업데이트(루나팀=암호화폐·국내외주식) 외 4건 |
| 2026-03-02 | **registry.json 현황 업데이트 + KIS Yahoo폴백** — registry.json 루나팀 실제 상태 반영(온체인·뉴스·감성 dev로 정정) 외 3건 |
| 2026-03-02 | **LU-035리서처+LU-024리포터+ETH실매수** — LU-035 강세/약세 리서처 signal-aggregator 통합 완성 외 3건 |
| 2026-03-02 | **LU-030펀드매니저+LU-036리스크매니저v2** — LU-030 fund-manager.js — sonnet-4-6 포트폴리오 오케스트레이터 (30분 launchd) 외 2건 |
| 2026-03-02 | **LU-037-백테스팅엔진** — LU-037 scripts/backtest.js — TA전략 역사적 검증 엔진 외 2건 |
| 2026-03-02 | **LU-038 몰리 v2 TP/SL 모니터 구현 완료** — upbit-bridge.js에 checkTpSl() 함수 추가 (진입가±3% 자동 청산) 외 3건 |
| 2026-03-02 | **CL-004 Dev/OPS 분리 구현 완료** — mode.js getModeSuffix() 추가 (DEV:-dev / OPS:'') 외 4건 |
| 2026-03-02 | **아처-리포트-봇팀-현황-섹션-추가** — fetcher.js fetchLunaStats+fetchSkaStats 추가 외 3건 |
| 2026-03-02 | **대리등록-네이버-예약불가-자동처리-로직-추가** — pickko-kiosk-monitor.js blockSlotOnly() + --block-slot 모드 추가 외 2건 |
| 2026-03-02 | **오늘-예약-검증-audit-today-구현** — auditToday() 함수 추가 (pickko-kiosk-monitor.js) 외 4건 |
| 2026-03-02 | **auditToday-failedList-차단실패-알림-추가** — blockNaverSlot false반환시 DB false positive 방지 확인 외 2건 |
| 2026-03-02 | **blockNaverSlot-avail소멸-보조확인-차단성공** — verifyBlockInGrid suspended만 확인하는 한계 발견 외 2건 |
| 2026-03-02 | **audit-date-내일날짜-검증-완료** — auditToday dateOverride 파라미터 추가 외 2건 |
| 2026-03-02 | **픽코취소-네이버해제-자동화-unblock-slot** — unblockNaverSlot avail-gone 버그 수정 (false positive return 제거) 외 3건 |
| 2026-03-02 | **솔루션화 원칙 추가** — Section 0에 "솔루션화 원칙(재사용성·공용성)" 신규 추가 — 라이브러리화·모듈화·옵션화·공용 변수/환경변수 원칙 체계화 |
| 2026-03-02 | **취소-테스트-성공-avail-gone-복구-확인** — 이승호 B룸 18:00 취소 테스트 성공 (픽코취소+네이버해제) 외 1건 |
| 2026-03-02 | **예약 취소 E2E 완성 + TOOLS.md 취소/등록 도구 정비** — pickko-cancel-cmd.js 2단계 취소(픽코+네이버 해제) 완성 외 4건 |
| 2026-03-03 | **클로드팀 고도화 반영** — 섹션 17 신규 (클로드팀 전용 패턴: team-bus 사용 규칙 / 아처 서칭 범위 / PATCH_REQUEST 처리 / SESSION.md 규칙 / HTTP 패턴 / Claude API 패턴), 섹션 18 체크리스트에 클로드팀 항목 추가, 공용 라이브러리 표에 team-bus.js 추가, 봇별 권장 모델 표에 아처/덱스터 추가 |
| 2026-03-03 | **배포 프로세스 안전화 + OBSERVE_ONLY 수정** — start-ops.sh `OBSERVE_ONLY=0` → `${OBSERVE_ONLY:-0}` (plist 환경변수 무시 버그 수정, 17건 오취소 재발 방지) / scripts/reload-monitor.sh 신규 (문법 체크→재시작, 직접 launchctl 금지 가이드 추가) / §1·§11·§14 코딩가이드 반영 |
| 2026-03-02 | **봇 이름 변수화 완료** — dexter.js/reporter.js/autofix.js BOT_NAME='덱스터' 상수 추가 외 3건 |
| 2026-03-04 | **Phase 3 OPS 전환 + 투자 리포트 + 메모리 정리** — DuckDB WAL 버그 수정 (CHECKPOINT) 외 5건 |
| 2026-03-04 | **메인봇(오케스트레이터) 구현 완료** — DB 마이그레이션(token_usage 포함) 외 6건 |
| 2026-03-04 | **전체 봇 sendTelegram → publishToMainBot 전면 교체** — error-tracker.js 마지막 교체 완료 외 1건 |
| 2026-03-04 | **메인봇 문서화 + time-mode 연동 + 전체 sendTelegram 교체 완료** — MAINBOT.md 최신화 외 4건 |
| 2026-03-04 | **API 문서 분석 기반 개선사항 적용** — parse_mode HTML 추가 (telegram.js + mainbot.js) 외 2건 |
| 2026-03-04 | **LLM키통합+알람버그수정+덱스터패턴학습** — packages/core/lib/llm-keys.js 공용 LLM 키 로더 외 3건 |
| 2026-03-04 | **제이 중심 지휘 체계 + 루나팀 고도화** — 제이 OpenClaw 에이전트 전환 외 10건 |
| 2026-03-04 | **팀 기능 문서화 및 제이 NLP 고도화** — TEAMS.md 문서 작성 외 6건 |
| 2026-03-04 | **제이↔클로드 통신·NLP자동개선·정체성유지시스템** — 제이↔클로드 직접 통신 채널 (ask_claude) 외 4건 |
| 2026-03-05 | **출금지연제 자동예약 + 덱스터 Phase C** — 출금지연제 delay 감지·ETA 계산·Telegram 안내 외 8건 |
| 2026-03-05 | **덱스터 Phase C 버그수정 + 업비트 출금지연 자동예약** — deps.js cd→cwd 수정 (launchd PATH 오류) 외 6건 |
| 2026-03-05 | **헬스체크 회복 로직 + 제이 할루시네이션 방지 + db-backup 수정** — health-check.js 회복 감지·알림·state 저장 로직 추가 외 4건 |
| 2026-03-05 | **취소 루틴 버그 수정 (블러/키 충돌)** — page.click(body)→Escape 키 수정(상세보기 블러 문제) 외 3건 |
| 2026-03-05 | **루나팀 국내/국외 모의투자 배포** — 국내장 모의투자 활성화 (ai.investment.domestic) 외 4건 |
| 2026-03-05 | **LLM 토큰 이력 DB 기록 + 거래 일지 스크립트** — llm-client.js Groq/OpenAI 토큰·응답시간 DB 기록 외 3건 |
| 2026-03-05 | **OpenClaw 업데이트 + 제이 RAG 연동 + e2e 데이터 정리** — OpenClaw 2026.2.26→2026.3.2 업데이트 외 2건 |
| 2026-03-05 | **예약 시간 파싱 버그 수정 + OpenClaw 복구 + 덱스터 오탐 수정** — naver-monitor 정오 종료시간 파싱 버그 수정 외 6건 |
| 2026-03-05 | **스카 pickko-query/cancel-cmd 경로 누락 버그 수정** — CLAUDE_NOTES.md 명령 테이블 절대경로 수정 외 1건 |
| 2026-03-06 | **미해결 알림 반복 + tool_code 누출 버그 수정** — pickko-alerts-resolve.js 신규 (수동 해결 CLI) 외 2건 |
| 2026-03-06 | **Day 4 — 루나팀 매매일지 시스템** — trade-journal-db.js 신규 (5개 테이블 + DB함수) 외 5건 |
| 2026-03-07 | **오탐 근본 수정 + Day 6 검증 완료** — markResolved() 추가 (ok 복귀 시 error 이력 자동 삭제) 외 2건 |
| 2026-03-07 | **PostgreSQL 단일 DB 통합 마이그레이션 완료 (Phase 5~6)** — forecast.py psycopg2 마이그레이션 외 6건 |
| 2026-03-07 | **3주차 구축 — 클로드(팀장) Sonnet Shadow + 장애주입 테스트 + LLM 졸업 엔진** — claude-lead-brain.js — Sonnet Shadow 판단 엔진 신규 외 7건 |
| 2026-03-08 | **Phase 1 — 루나팀 전환판단 + LLM졸업실전 + 덱스터팀장봇연동** — shadow-mode.js getTeamMode/setTeamMode 추가 외 14건 |
| 2026-03-08 | **루나팀 개선 3/3 — 소피아+아리아 고도화** — 소피아 Fear&Greed Index 추가 (alternative.me, 1시간 캐시) 외 5건 |
| 2026-03-08 | **클로드팀 완전체 개선 + 루나팀 자본관리** — team-bus.js 에러핸들링(try-catch 0→15개) 외 7건 |
| 2026-03-08 | **워커팀 Phase 1 기반 구축 완료** — worker 스키마+4개 테이블 외 6건 |
| 2026-03-08 | **Phase 3 소피/라이언/클로이 + OWASP 로그 + 웹 대시보드** — DB 마이그레이션 005 (6테이블) 외 11건 |
| 2026-03-09 | **RAG 완성 + 에이전트 오케스트레이션 Phase 2 + 보안패치** — RAG pgvector 전 컬렉션 완성 (9곳 Node.js + 2곳 Python) 외 5건 |
| 2026-03-09 | **네메시스 Phase 3 R/R 최적화** — analyze-rr.js 신규 — 8가지 TP/SL 시뮬레이션+봇정확도+RAG저장 외 3건 |
| 2026-03-09 | **클로드팀 개선 5가지 + 스카팀 개선 4가지** — bot-behavior.js 신규(독터 루프+실패율+루나급속) 외 8건 |
| 2026-03-10 | **블로그팀 소셜봇 + 이미지 생성 완성** — N40/N42 Gemini→OpenAI(gpt-4o-mini) 전환 외 7건 |
| 2026-03-10 | **동적 인사이트 4~6개 + 내부 링킹 과거만 + 소셜→스타** — bonus-insights.js 신규 (봇별 보너스 풀 + 랜덤 선택) 외 7건 |
| 2026-03-10 | **일자별 발행 스케줄 + 테스트 정책 + 도서리뷰 실제 도서 기반** — publish_schedule 테이블 마이그레이션(002-publish-schedule.sql) 외 4건 |
| 2026-03-11 | **강의 인스타 페어링 + 캐시 실패방지 + launchd INSTA 환경변수 + 이미지 medium 품질** — runLecturePost 강의 인스타 콘텐츠 페어링 추가 (BLOG_INSTA_ENABLED) 외 5건 |
| 2026-03-11 | **루나팀 국내외장 공격적 매매 전환 (2주 검증)** — luna.js MIN_CONFIDENCE/FUND_MIN_CONF 마켓별 객체 차등 외 9건 |
| 2026-03-11 | **블로그팀 차기 강의 시리즈 자동 선정** — curriculum-planner.js 신규 (종료 7강 전 트리거, HN+GitHub 트렌드, LLM 후보 3개, generateCurriculum) 외 4건 |
| 2026-03-11 | **전 팀 LLM 최적화 + 스크리닝 RAG 폴백 + 스카팀 재가동** — llm-client MINI_FIRST_AGENTS+callOpenAIMini 외 7건 |
| 2026-03-11 | **제이 무응답 4종 버그 수정** — mainbot.js await 누락(items is not iterable) 외 3건 |
| 2026-03-11 | **naver-monitor kst 누락 수정** — naver-monitor.js kst 임포트 누락 → 알람 전송 실패 수정 |
| 2026-03-11 | **젬스/포스 이어쓰기 중복 방지 + 중복실행 early-exit** — gems-writer.js 이어쓰기 800자 tail + LLM 재시작 감지 외 2건 |
<!-- session-close:2026-03-11:젬스포스-이어쓰기-중복-방지-중복실행-earlyexit -->
<!-- session-close:2026-03-11:navermonitor-kst-누락-수정 -->
<!-- session-close:2026-03-11:제이-무응답-4종-버그-수정 -->
<!-- session-close:2026-03-11:전-팀-llm-최적화-스크리닝-rag-폴백-스카팀-재가 -->
<!-- session-close:2026-03-11:블로그팀-차기-강의-시리즈-자동-선정 -->
<!-- session-close:2026-03-11:루나팀-국내외장-공격적-매매-전환-2주-검증 -->
<!-- session-close:2026-03-11:강의-인스타-페어링-캐시-실패방지-launchd-ins -->
<!-- session-close:2026-03-10:일자별-발행-스케줄-테스트-정책-도서리뷰-실제-도서-기 -->
<!-- session-close:2026-03-10:동적-인사이트-46개-내부-링킹-과거만-소셜스타 -->
<!-- session-close:2026-03-10:블로그팀-소셜봇-이미지-생성-완성 -->
<!-- session-close:2026-03-09:클로드팀-개선-5가지-스카팀-개선-4가지 -->
<!-- session-close:2026-03-09:네메시스-phase-3-rr-최적화 -->
<!-- session-close:2026-03-09:rag-완성-에이전트-오케스트레이션-phase-2-보안 -->
<!-- session-close:2026-03-08:phase-3-소피라이언클로이-owasp-로그-웹-대시 -->
<!-- session-close:2026-03-08:워커팀-phase-1-기반-구축-완료 -->
<!-- session-close:2026-03-08:클로드팀-완전체-개선-루나팀-자본관리 -->
<!-- session-close:2026-03-08:루나팀-개선-33-소피아아리아-고도화 -->
<!-- session-close:2026-03-08:phase-1-루나팀-전환판단-llm졸업실전-덱스터팀장 -->
<!-- session-close:2026-03-07:3주차-구축-클로드팀장-sonnet-shadow-장애주 -->
<!-- session-close:2026-03-07:postgresql-단일-db-통합-마이그레이션-완료- -->
<!-- session-close:2026-03-07:오탐-근본-수정-day-6-검증-완료 -->
<!-- session-close:2026-03-06:day-4-루나팀-매매일지-시스템 -->
<!-- session-close:2026-03-06:미해결-알림-반복-tool_code-누출-버그-수정 -->
<!-- session-close:2026-03-05:스카-pickkoquerycancelcmd-경로-누락- -->
<!-- session-close:2026-03-05:예약-시간-파싱-버그-수정-openclaw-복구-덱스터 -->
<!-- session-close:2026-03-05:openclaw-업데이트-제이-rag-연동-e2e-데이 -->
<!-- session-close:2026-03-05:llm-토큰-이력-db-기록-거래-일지-스크립트 -->
<!-- session-close:2026-03-05:루나팀-국내국외-모의투자-배포 -->
<!-- session-close:2026-03-05:취소-루틴-버그-수정-블러키-충돌 -->
<!-- session-close:2026-03-05:헬스체크-회복-로직-제이-할루시네이션-방지-dbback -->
<!-- session-close:2026-03-05:덱스터-phase-c-버그수정-업비트-출금지연-자동예약 -->
<!-- session-close:2026-03-05:출금지연제-자동예약-덱스터-phase-c -->
<!-- session-close:2026-03-04:제이클로드-통신nlp자동개선정체성유지시스템 -->
<!-- session-close:2026-03-04:팀-기능-문서화-및-제이-nlp-고도화 -->
<!-- session-close:2026-03-04:제이-중심-지휘-체계-루나팀-고도화 -->
<!-- session-close:2026-03-04:llm키통합알람버그수정덱스터패턴학습 -->
<!-- session-close:2026-03-04:api-문서-분석-기반-개선사항-적용 -->
<!-- session-close:2026-03-04:메인봇-문서화-timemode-연동-전체-sendtel -->
<!-- session-close:2026-03-04:전체-봇-sendtelegram-publishtomai -->
<!-- session-close:2026-03-04:메인봇오케스트레이터-구현-완료 -->
<!-- session-close:2026-03-04:phase-3-ops-전환-투자-리포트-메모리-정리 -->
<!-- session-close:2026-03-02:봇-이름-변수화-완료 -->
<!-- session-close:2026-03-02:예약-취소-e2e-완성-toolsmd-취소등록-도구-정 -->
<!-- session-close:2026-03-02:취소테스트성공availgone복구확인 -->
<!-- session-close:2026-03-02:픽코취소네이버해제자동화unblockslot -->
<!-- session-close:2026-03-02:auditdate내일날짜검증완료 -->
<!-- session-close:2026-03-02:blocknaverslotavail소멸보조확인차단성공 -->
<!-- session-close:2026-03-02:audittodayfailedlist차단실패알림추가 -->
<!-- session-close:2026-03-02:오늘예약검증audittoday구현 -->
<!-- session-close:2026-03-02:대리등록네이버예약불가자동처리로직추가 -->
<!-- session-close:2026-03-02:아처리포트봇팀현황섹션추가 -->
<!-- session-close:2026-03-02:cl004-devops-분리-구현-완료 -->
<!-- session-close:2026-03-02:lu038-몰리-v2-tpsl-모니터-구현-완료 -->
<!-- session-close:2026-03-02:lu037백테스팅엔진 -->
<!-- session-close:2026-03-02:lu030펀드매니저lu036리스크매니저v2 -->
<!-- session-close:2026-03-02:lu035리서처lu024리포터eth실매수 -->
<!-- session-close:2026-03-02:registryjson-현황-업데이트-kis-yahoo -->
<!-- session-close:2026-03-02:루나팀-다중심볼kis통합강화 -->
<!-- session-close:2026-03-02:openclaw-oc001009-보안설정-개선-전체-완 -->
<!-- session-close:2026-03-02:openclaw-공식문서-검토-속도테스트-프로바이더-등 -->
<!-- session-close:2026-03-02:하트비트-오늘예약현황-추가-scarska-정리-절대규칙 -->
<!-- session-close:2026-03-02:3중-가동중지-libhealthjs-deployopss -->
<!-- session-close:2026-03-02:skap05p08-루나팀-패턴-적용-deployopss -->
<!-- session-close:2026-03-01:포캐스트-0원-버그-수정-공휴일-prophet-과보정 -->
<!-- session-close:2026-03-01:kis-api-연동-완료-및-파이프라인-활성화 -->
<!-- session-close:2026-03-01:kis-실전모의투자-키-이중화-api-연결-검증 -->
<!-- session-close:2026-03-01:스카팀-루나팀-패턴-적용 -->
<!-- session-close:2026-03-01:kis-국내주식-실행봇-크리스-구현 -->
<!-- session-close:2026-03-01:아처archer-기술-인텔리전스-봇-구현-완료 -->
<!-- session-close:2026-03-01:덱스터-구현-완료-일일보고-픽스-로그 -->
<!-- session-close:2026-03-01:투자봇-devops-분리-3중-체크-시스템 -->
<!-- session-close:2026-03-01:투자팀봇-phase1-구현-및-검증 -->
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
