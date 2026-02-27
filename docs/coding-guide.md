# 코딩 가이드 — ai-agent-system

> 새 기능 추가 / 버그 수정 / 신규 봇 개발 전 반드시 참조.
> 마지막 업데이트: 2026-02-27

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

## 2. 인증 정보 관리

### secrets.json 패턴

```javascript
// ✅ lib/secrets.js 사용
const { loadSecrets } = require('../lib/secrets');
const SECRETS = loadSecrets();
const NAVER_ID  = SECRETS.naver_id;
const PICKKO_ID = SECRETS.pickko_id;
```

### secrets.json 전체 키 목록

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
  "db_encryption_key": "",     // 64자 hex (AES-256 키)
  "db_key_pepper":    ""       // kiosk_blocks SHA256 해시 pepper
}
```

### 금지 패턴

```javascript
// ❌ 절대 금지
const NAVER_PW = 'password123';
```

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

### 모델 교체 CLI

```bash
openclaw models set google-gemini-cli/gemini-2.5-flash
# prefix 주의: google-gemini-cli/ (일반 gemini/ 아님)
```

### Gemini-2.5-flash 알려진 quirks

- `streamMode`: `"partial"` | `"block"` (권장) | `"off"` (전송 차단)
- `<execute_tool>` 텍스트 누출 버그 — 텔레그램으로 도구 호출 텍스트가 노출되는 이슈 (재테스트 필요)
- Ollama 맥북 M3: Homebrew 빌드는 MLX GPU 가속 미지원 → CPU 전용, 봇용 사용 불가

---

## 14. DEV / OPS 분리

```bash
# DEV (기본, 픽코 실행 차단)
node src/naver-monitor.js

# OPS (운영, 픽코 실행 허용) — start-ops.sh가 자동 설정
MODE=ops PICKKO_ENABLE=1 OBSERVE_ONLY=0 PICKKO_CANCEL_ENABLE=1 PICKKO_HEADLESS=1 \
  node src/naver-monitor.js
```

| 환경변수 | 기본 | 설명 |
|---------|------|------|
| `MODE` | `dev` | `ops`일 때만 픽코 실행 |
| `PICKKO_ENABLE` | `0` | `1`이어야 픽코 활성화 |
| `OBSERVE_ONLY` | `1` | `0`이어야 실제 등록/취소 |
| `PICKKO_CANCEL_ENABLE` | `0` | `1`이어야 자동 취소 |
| `PICKKO_HEADLESS` | `0` | `1`이면 완전 headless |

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

## 17. 새 기능 추가 체크리스트

- [ ] `lib/secrets.js` 패턴으로 인증 정보 로드
- [ ] `WORKSPACE` 상수로 경로 처리 (하드코딩 금지)
- [ ] DEV/OPS 분기 포함 (`MODE === 'ops'`)
- [ ] NLP CLI라면 stdout JSON 컨벤션 적용
- [ ] `lib/telegram.js`로 텔레그램 발송 (openclaw deliver 사용 금지)
- [ ] 개인정보 컬럼 암호화 (`lib/crypto.js`)
- [ ] 실패 시 retries 증가 + MAX_RETRIES(5) 체크
- [ ] Playwright 셀렉터 폴백 체인 구성
- [ ] launchd 등록 필요하면 run-*.sh 래퍼 + plist 작성
- [ ] 개인정보 포함 파일 gitignore 확인
- [ ] 테스트 후 `node scripts/deploy-context.js --bot=reservation`
- [ ] 세션 마감 `node scripts/session-close.js --bot=reservation ...`

---

## 변경 이력

| 날짜 | 내용 |
|------|------|
| 2026-02-24 | 최초 작성 (secrets, WORKSPACE, MAX_RETRIES, archive 패턴) |
| 2026-02-27 | 전면 업데이트 — SQLite/DB, telegram 직접 발송, CLI stdout JSON, args.js, exit code, launchd, OpenClaw/LLM 연동, 모델 비교표, 암호화 패턴 추가 |
