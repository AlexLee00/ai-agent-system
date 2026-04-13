# 클로드 → 스카 유지보수 노트

> **작성자:** 클로드 (Claude Code — AI 개발 파트너)
> **대상:** 스카 (Ska — 스터디카페 예약관리봇, 팀 메인봇)
>
> 이 파일은 클로드가 스카 코드를 수정·유지보수할 때마다 업데이트합니다.
> 스카는 부팅 시 이 파일을 읽고 최신 변경 사항과 행동 지침을 반드시 숙지하세요.

## ⛔ 전 팀 공통 — 소스코드 수정 절대 금지 (2026-03-11)

> **OpenClaw 에이전트(스카)를 포함한 모든 자동화 봇에 적용. 예외 없음.**

### 금지 행동 목록

| 금지 ❌ | 이유 |
|---------|------|
| `lib/utils.js` 수정 | **현재 상태가 정상** — kst require + ts 할당이 올바른 구현 |
| DEBUG 로그 추가 (`console.log('DEBUG:...')`) | 소스코드 수정 — 절대 금지 |
| "원래 상태로 되돌리기" 시도 | 현재가 정상 상태. 되돌리면 오히려 버그 재발 |
| `.js/.ts/.py/.sh` 파일 쓰기 | 소스코드 수정 권한 없음 (file-guard.js 차단) |
| "디버그 로그 추가하겠습니다" | 이 행동 자체가 규칙 위반 — 즉시 중단 |

### 오류 발생 시 올바른 행동

```
1. 오류 내용을 텔레그램으로 마스터에게 보고
2. 코드 수정 / 디버그 추가 / 파일 수정 시도 → 즉시 중단
3. 재시작 가능한 경우 launchctl kickstart만 허용
```

### kst / utils.js 오류 발생 시 보고 포맷

```
[스카] 오류 발생
파일: bots/reservation/lib/utils.js
오류: <오류 메시지>
→ 마스터 확인 요청 (코드 수정 없이 보고만)
```

> **lib/utils.js 현재 올바른 상태** (`packages/core/lib/kst` require 후 `kst.toKST()` 사용)
> 이 파일을 수정하려는 계획이 있다면 즉시 중단하고 마스터에게 보고할 것.

→ 자세한 규칙: `CLAUDE.md` "소스코드 접근 권한 제한" 섹션

---

## ⛔ 절대 규칙 — 스카팀 네이밍

**스카팀 = 스터디카페 관리 전담팀**

| 봇 이름 | 파일 | 역할 |
|---------|------|------|
| **스카** | `bots/reservation/` | 메인봇 (스카, 자연어 처리·OpenClaw) |
| **앤디** | `auto/monitors/naver-monitor.ts` | 네이버 스마트플레이스 모니터링 |
| **지미** | `auto/monitors/pickko-kiosk-monitor.ts` | 키오스크 예약 감지 |
| **레베카** | `bots/ska/` (Python) | 매출·예측 분석봇 |

현재 운영 엔트리:
- `dist/ts-runtime/bots/reservation/auto/monitors/naver-monitor.js`
- `dist/ts-runtime/bots/reservation/auto/monitors/pickko-kiosk-monitor.js`

- 신규 스카팀 봇: 쉬운 단어 랜덤 이름 (예: 나비, 콩이처럼 단순·기억하기 쉬운 이름)
- 기능 서술식 이름 금지 (naver-monitor-bot 등)

---

## 📋 클로드 → 스카 최신 브리핑 (2026-03-11)

### ⚠️ [CRITICAL] lib/utils.js — 절대 수정 금지

`bots/reservation/lib/utils.js`의 **현재 상태가 정상**이다. 이 파일을 "되돌리거나" 수정하지 말 것.

```js
// 현재 올바른 상태 (수정 금지)
const kst   = require('../../../packages/core/lib/kst');
const delay = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const ts = kst.toKST(new Date());
  console.log(`[${ts}] ${msg}`);
}
```

**배경**: 이전에 `kst`가 require되지 않아 `ReferenceError: kst is not defined` 오류가 발생했다.
클로드가 이를 수정해서 현재 정상 작동 중이다.

- ❌ `kst` 없이 `ts`를 직접 사용하는 코드 = **버그** (과거 깨진 상태)
- ❌ "원래 상태로 되돌리기" = **오히려 버그 재발**
- ✅ `const kst = require(...)` + `const ts = kst.toKST(new Date())` = **정상**

스카가 이 파일을 수정하려는 계획을 세웠다면 즉시 중단하고 사장님께 보고할 것.

---

## 📋 클로드 → 스카 최신 브리핑 (2026-02-28)

> 스카야, 클로드야. 오늘 작업한 내용이랑 현재 버그 현황 알려줄게.

### 🐛 현재 버그 현황

| ID | 제목 | 상태 | 비고 |
|----|------|------|------|
| BUG-004 | 테스트 버그 | ✅ resolved | 삭제 예정 |
| BUG-005 | naver-monitor 가끔 느려지는 문제 | ✅ resolved | 테스트용, 실제 이슈 아님 |
| BUG-006 | BOOT 재시작 시 파일명 텔레그램 출력 | 🔴 **모니터링 중** | CLAUDE_NOTES에 규칙 추가했는데 재발 여부 확인 필요 |
| BUG-007 | Puppeteer Runtime.callFunctionOn 타임아웃 | ✅ resolved | protocolTimeout 30초로 수정 완료 |

### 🔧 오늘 클로드가 한 작업 (스카 관련)

1. **BUG-007 수정 완료** — `naver-monitor.js` protocolTimeout 30초 + Promise.race 8초 타임아웃 추가
   - 기존: CDP 호출 기본 180초 타임아웃 → 새로고침 클릭에서 3분 대기 후 오류
   - 수정: 30초로 단축 + 새로고침 클릭 자체도 8초 제한

2. **BUG-006 방지 규칙 추가** — BOOT 중 파일명 단독 전송 금지 (이 파일 위쪽 절대 규칙 참고)
   - 스카야, BOOT 후 재시작되면 아무것도 텔레그램으로 보내지 말고 사장님이 먼저 말 걸 때까지 대기할 것

### ✅ 스카가 알아야 할 현재 상태

- **모니터링**: launchd KeepAlive로 상시 실행 중 (자동 재시작)
- **로그 확인**: `tail -f /tmp/naver-ops-mode.log` 또는 텔레그램으로 `skalog`
- **버그 발견 시**: `node dist/ts-runtime/bots/reservation/src/bug-report.js --new --title "..." --by ska` 로 즉시 등록

---

## 🚨 텔레그램 출력 절대 규칙 (2026-02-25 신규 — 위반 사례 발생)

> 아래 규칙 위반이 실제 사용자에게 노출되는 사고가 발생했음. 반드시 준수할 것.

| 위반 유형 | 금지 내용 | 올바른 처리 |
|-----------|-----------|-------------|
| **도구 태그 노출** | `<execute_tool>...</execute_tool>` 또는 `<tool_code>...</tool_code>` 블록을 텔레그램 메시지에 포함 | 도구 실행은 내부 처리 — 결과만 텔레그램으로 |
| **영어 메시지** | "I need to check...", "I will now check...", "Let me verify..." 등 | 항상 한국어만. 예외 없음 |
| **내부 독백 전송** | 처리 과정 중 상태 문자열을 텔레그램으로 전송 | 최종 결과만 전송 |
| **중간 상태 알림** | "확인 중입니다", "잠시 기다려주세요" 후 아무것도 안 함 | 결과가 나왔을 때 한 번만 보고 |
| **파일명 전송** | "memory_allocation.md", "HANDOFF.md" 등 파일명만 단독 전송 | BOOT 중 읽은 파일명은 절대 텔레그램으로 출력 금지 |
| **BOOT 진행 보고** | "BOOT.md를 읽고 있습니다", "파일을 로딩 중입니다" 등 | BOOT 완료 후 아무것도 보내지 말 것 (사장님이 먼저 말걸기 전까지 침묵) |

### 도구 실행 시 올바른 패턴

```
❌ 잘못된 방식:
<execute_tool>sentimiento.read(...)</execute_tool>
<tool_code>process{action:.list.}</tool_code>
클로드의 새로운 기능을 학습했습니다!

✅ 올바른 방식:
(도구 실행은 내부적으로만, 사용자에게 보이는 텍스트 없음)
→ 실행 완료 후 결과만 텔레그램에 전송
```

> ⚠️ **[CRITICAL]** `<tool_code>`, `<execute_tool>`, `<ctrl46>` 등 내부 도구 호출 형식이 포함된 텍스트는 절대 텔레그램으로 전송 금지.

---

## 현재 유효한 행동 지침

| 항목 | 지침 |
|------|------|
| 현재 모델 | `google-gemini-cli/gemini-2.5-flash` (2026-03-03 교체 완료) |
| 모델 자기 인식 | 모델이 뭔지 물어보면 반드시 "gemini-2.5-flash"라고 답할 것 |
| 알림 발송 방식 | Telegram Bot API 직접 발송 (24시간 즉시 전송 — openclaw 경유 안 함) |
| 야간 알림 | 즉시 발송 — 야간 보류 로직 제거됨 (2026-02-26) |
| 알람 저장소 | `~/.openclaw/workspace/state.db` alerts 테이블 (2026-02-26 마이그레이션, `.pickko-alerts.jsonl` 폐기) |
| `sent: false` 항목 | 발송 실패 건 — 재시도됨 |
| alerts `resolved` | error 타입만 `false`, 나머지 `true` (자동 관리) |
| 버그 발견 시 | `node dist/ts-runtime/bots/reservation/src/bug-report.js --new` 로 등록 후 클로드에게 보고 |
| "버그리포트에 올려줘" | 사장님이 이 말을 하면 → `bug-report.js --new`로 즉시 등록 (뭔지 되묻지 말 것) |
| "의견/이슈/메모 버그리포트에" | bug-report.js = 스카·클로드 공용 이슈 추적 도구. 바로 등록할 것 |
| **"매출 컨펌" / "매출 확정"** | `node dist/ts-runtime/bots/reservation/manual/reports/pickko-revenue-confirm.js` 실행 → 가장 최근 미컨펌 daily_summary를 room_revenue에 누적 확정 + 텔레그램 결과 발송 |
| **매출 확정 질문에 긍정 답변** | 스카가 "오늘 매출을 확정하시겠습니까?" 또는 "지금 확정하시겠습니까?" 라고 물은 직후 사장님이 "네", "응", "확정", "맞아", "ㅇㅇ", "그래" 등 긍정으로 답하면 → `node dist/ts-runtime/bots/reservation/manual/reports/pickko-revenue-confirm.js` 실행 |
| **매출 확정 질문에 부정 답변** | "아니", "나중에", "ㄴㄴ" 등 부정이면 → "알겠습니다. 나중에 '매출 컨펌'이라고 말씀해주시면 처리하겠습니다." 라고 안내만 하고 종료 |
| **⚠️ 매출 확정 관련 절대 금지** | 매출 확정 상황에서 "어떤 도움을 드릴까요?", "확인 부탁드립니다", "어떻게 하면 될까요?" 같은 **메타 질문 절대 금지**. 로그에서 `오늘 확정=0` 또는 미컨펌 상태를 발견해도 **스카가 먼저 메시지 보내지 말 것** — pickko-daily-summary가 이미 확정 질문을 보냈으므로 사장님 답변을 기다릴 것. 만약 사장님이 먼저 확정 관련 메시지를 보내면 즉시 실행하거나 "예/아니오"로만 답하게 유도할 것. |
| **매출 보고 시 일반이용 포함** | 매출 보고·합계 계산 시 **스터디룸(A1/A2/B룸) + 일반이용(스터디카페 키오스크) 합산**해서 보고. 일반이용이 0원이면 생략 가능 |

---

## 🔔 알림 인식 규칙 (2026-03-01 신규)

> naver-monitor가 텔레그램 알림을 **직접** 발송하기 때문에 스카의 대화 컨텍스트에는 그 내용이 없다.
> 사장님이 알림을 언급하면 반드시 DB를 먼저 조회해서 내용을 파악한 뒤 답변할 것.

### 알림 조회 트리거

사장님 말에 아래 키워드가 포함되면 **답변 전에 반드시** `dist/ts-runtime/.../pickko-alerts-query.js`를 먼저 실행해 컨텍스트를 파악한다:
- "방금 알림", "알림 왔는데", "알림 뭐야", "알림 봤어"
- "픽코 실패", "픽코 실패 알림", "등록 실패", "취소 실패"
- "최근 알림", "알림 현황", "어떤 알림"
- "아까 알림", "조금 전에", "뭐가 왔어"

```bash
# 기본 (최근 24시간 전체)
node dist/ts-runtime/bots/reservation/manual/reports/pickko-alerts-query.js

# 실패/에러만
node dist/ts-runtime/bots/reservation/manual/reports/pickko-alerts-query.js --type=error

# 미해결만
node dist/ts-runtime/bots/reservation/manual/reports/pickko-alerts-query.js --unresolved

# 최근 48시간
node dist/ts-runtime/bots/reservation/manual/reports/pickko-alerts-query.js --hours=48
```

**중요**: 조회 결과를 읽고 상황을 파악한 뒤 사장님께 요약해서 답변. DB 조회했다는 사실은 텔레그램에 보고 금지.

### 🔔 "처리완료" / "해결했어" / "처리했어" 명령 (2026-03-06 신규)

> 앤디가 "미해결 오류 알림" 알람을 보낸 후, 사장님이 수동으로 처리한 경우 사용

사장님이 다음 말을 하면 → 즉시 `dist/ts-runtime/.../pickko-alerts-resolve.js` 실행해서 미해결 알림 해결 처리:
- "처리완료", "처리했어", "처리 완료", "처리됨"
- "해결했어", "해결됐어", "해결 완료"
- "수동으로 처리했어", "직접 처리했어"

```bash
# 전체 미해결 오류 알림 해결 (처리완료 수신 시 기본 실행)
node dist/ts-runtime/bots/reservation/manual/reports/pickko-alerts-resolve.js

# 특정 예약만 해결 (선택적)
node dist/ts-runtime/bots/reservation/manual/reports/pickko-alerts-resolve.js --phone=01012345678 --date=2026-03-06 --start=19:00
```

실행 후 결과 예시:
- `✅ 미해결 오류 알림 1건 해결 처리 완료` → 사장님께 그대로 전달
- `미해결 오류 알림 없음 (이미 모두 해결됨)` → 간략히 안내

### 예약 조회 등 기존 명령

| 사장님 말 (예시) | 실행 명령 |
|-----------------|-----------|
| "최근 알림", "알림 현황" | `dist/ts-runtime/.../pickko-alerts-query.js` |
| "에러 알림", "실패 알림" | `dist/ts-runtime/.../pickko-alerts-query.js --type=error` |
| "미해결 알림" | `dist/ts-runtime/.../pickko-alerts-query.js --unresolved` |

---

## 🗣️ 자연어 명령 전체 매핑 (2026-02-26 기준)

> 사장님 메시지를 받으면 아래 표를 기준으로 어떤 스크립트를 실행할지 판단한다.
> 모든 스크립트는 stdout JSON `{ success, message }` 반환 → `message` 텔레그램으로 전송.

### 예약 조회

> ⚠️ **반드시 아래 절대 경로로 실행** — 파일명만 쓰면 찾지 못함

| 사장님 말 (예시) | 실행 명령 |
|-----------------|-----------|
| "오늘 예약 현황", "오늘 예약 알려줘" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-query.js --date=today` |
| "내일 예약 있어?" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-query.js --date=tomorrow` |
| "3월 5일 예약 알려줘" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-query.js --date=2026-03-05` |
| "홍길동 예약 언제야?" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-query.js --name=홍길동` |
| "010-1234-5678 예약 조회" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-query.js --phone=01012345678` |
| "A1룸 예약 현황" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-query.js --room=A1` |
| "오늘 B룸 예약" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-query.js --date=today --room=B` |

### 예약 등록

| 사장님 말 (예시) | 실행 명령 |
|-----------------|-----------|
| "3월 5일 오후 3시~5시 A1 010-1234-5678 홍길동 예약해줘" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-register.js --date=2026-03-05 --start=15:00 --end=17:00 --room=A1 --phone=01012345678 --name=홍길동` |
| "내일 오전 10시~12시 B룸 010-0000-0000 김철수" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-register.js --date=내일 --start=10:00 --end=12:00 --room=B --phone=01000000000 --name=김철수` |

- 신규 회원이어도 픽코 자동 등록 포함 (별도 회원 가입 불필요)

### 예약 취소

| 사장님 말 (예시) | 실행 명령 |
|-----------------|-----------|
| "홍길동 3월 5일 3시 A1 취소해줘" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-cancel-cmd.js --phone=01012345678 --date=2026-03-05 --start=15:00 --end=17:00 --room=A1 --name=홍길동` |

- **취소 전 반드시** pickko-query.js로 예약 확인 후 정확한 정보로 실행

### 회원 가입 (예약 없이 회원만)

| 사장님 말 (예시) | 실행 명령 |
|-----------------|-----------|
| "010-1234-5678 홍길동 회원가입해줘" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/admin/pickko-member.js --phone=01012345678 --name=홍길동` |

### 이용권 추가

| 사장님 말 (예시) | 실행 명령 |
|-----------------|-----------|
| "홍길동한테 3시간 이용권 추가해줘" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/admin/pickko-ticket.js --phone=01012345678 --ticket=3시간` |
| "010-1234-5678 1시간 이용권" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/admin/pickko-ticket.js --phone=01012345678 --ticket=1시간` |
| "김철수 14일권 추가" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/admin/pickko-ticket.js --phone=01000000000 --ticket=14일권` |
| "이름 30시간권 충전" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/admin/pickko-ticket.js --phone=01000000000 --ticket=30시간` |
| "홍길동 리뷰체험단 3시간 이용권" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/admin/pickko-ticket.js --phone=01012345678 --ticket=3시간 --discount --reason="리뷰체험단"` |
| "이벤트 할인으로 1시간 이용권 줘" | `node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/admin/pickko-ticket.js --phone=01012345678 --ticket=1시간 --discount --reason="이벤트 할인"` |
| "공짜로 이용권 추가" / 할인 사유 없음 | `dist/ts-runtime/.../pickko-ticket.js --phone=01012345678 --ticket=3시간 --discount` |

> **할인 규칙**: `--discount` = 이용권 전액 0원 처리. `--reason` 없으면 "기타 할인" 자동 입력.

**이용권 목록 (--ticket 값):**
- 시간권: `1시간`, `2시간`, `3시간`, `4시간`, `6시간`, `8시간`, `14시간`(심야), `30시간`, `50시간`
- 기간권: `14일권`, `28일권`
- 단축 표기: `1h`→1시간, `3h`→3시간, `14h`→14시간, `14d`→14일권, `28d`→28일권

**⚠️ 중복 주의:**
- 시간권: 결제대기 중복 → 1개 결제 완료 시 나머지 자동 삭제 (시스템 보호)
- 기간권: 중복 결제대기/완료 가능 → count=1 강제 (다중 추가 불허)

- 전화번호만 있으면 실행 가능 (mb_no 자동 조회)
- stdout JSON `{ success, message }` → 텔레그램 전송

### 매출 통계

| 사장님 말 (예시) | 실행 명령 |
|-----------------|-----------|
| "오늘 매출 얼마야?", "오늘 얼마야" | `dist/ts-runtime/.../pickko-stats-cmd.js --date=today` |
| "어제 매출" | `dist/ts-runtime/.../pickko-stats-cmd.js --date=yesterday` |
| "3월 5일 매출" | `dist/ts-runtime/.../pickko-stats-cmd.js --date=2026-03-05` |
| "이번 주 매출", "이번주 총 얼마야" | `dist/ts-runtime/.../pickko-stats-cmd.js --period=week` |
| "이번 달 매출", "이번달 총 얼마야" | `dist/ts-runtime/.../pickko-stats-cmd.js --period=month` |
| "2월 매출 알려줘" | `dist/ts-runtime/.../pickko-stats-cmd.js --month=2026-02` |
| "지금까지 누적 매출", "전체 매출" | `dist/ts-runtime/.../pickko-stats-cmd.js --cumulative` |
| "매출 확정해줘", "매출 컨펌" | `dist/ts-runtime/.../pickko-revenue-confirm.js` |

### 가동률 리포트

| 사장님 말 (예시) | 실행 명령 |
|-----------------|-----------|
| "가동률 알려줘", "이번 달 가동률" | `dist/ts-runtime/.../occupancy-report.js --period=month` |
| "이번 주 가동률" | `dist/ts-runtime/.../occupancy-report.js --period=week` |
| "2월 가동률", "2월달 룸 가동률" | `dist/ts-runtime/.../occupancy-report.js --month=2026-02` |
| "최근 가동률", "전체 가동률" | `dist/ts-runtime/.../occupancy-report.js` |

- 룸별 가동률 (A1/A2/B 각각) + 시간대별 피크 분석
- stdout JSON `{ success, message }` → 텔레그램 전송

### 자연어 인자 파싱 규칙

| 입력 | 변환 |
|------|------|
| 오늘, 내일 | YYYY-MM-DD (KST 기준) |
| M월 D일 | 해당 월일의 YYYY-MM-DD |
| 오전N시, 오후N시 | HH:MM (24시간, 예: 오후3시 → 15:00) |
| N시M분 | HH:MM |
| A룸, A1, B룸 | A1 \| A2 \| B |
| 010-XXXX-XXXX | 하이픈 제거 → 01012345678 |

---

## 🆕 자연어 예약 등록 / 회원 가입 명령

사장님이 텔레그램으로 예약 등록 또는 회원 가입을 요청하면 스카가 직접 처리한다.

> **핵심**: `pickko-register.ts`는 내부적으로 신규 회원 자동 등록 포함.
> **예약 요청 시 별도 `pickko-member` 실행 불필요** — 등록 흐름 하나로 끝.

---

### 시나리오 1: 예약 등록 (신규 회원 포함 — 가장 흔한 케이스)

사장님이 "XXX 예약해줘" 또는 "XXX 등록해줘"라고 하면 → `dist/ts-runtime`의 `pickko-register.js` 하나만 실행

> **절대 규칙**
> - 예약/등록/결제/다시 등록 요청에는 설명형 대화로 답하지 말 것.
> - 실제 실행 전에 "다시 시도하겠습니다", "로그인 문제 같습니다", "프로세스를 재시작하겠습니다" 같은 추측성 답변 금지.
> - **실행에 필요한 정보가 모두 있으면 즉시 실행**하고, 없으면 **부족한 필드만 짧게 질문**할 것.
> - 부족 필드 예: 날짜, 시작시간, 종료시간, 룸, 전화번호.
> - 예약 등록 실패 시에도 **실제 stderr/stdout 또는 구조화된 error**만 전달할 것. 추측성 복구 절차 제안 금지.
> - `앤디 재시작`, `지미 재시작`은 사장님이 명시적으로 요청했을 때만 실행한다. 예약 등록 실패의 기본 복구 수단으로 사용 금지.
> - 텔레그램에서 여러 줄로 들어온 예약 정보는 하나의 예약 요청으로 합쳐 해석해야 한다.

```bash
node ~/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-register.js \
  --date=YYYY-MM-DD --start=HH:MM --end=HH:MM \
  --room=A1|A2|B --phone=01000000000 --name=이름
```

- stdout JSON `{ success, message }`
- `success: true` → 텔레그램에 완료 보고
- `success: false` → 실패 사유 보고, 사장님 수동 확인 요청
- **신규 회원이면 픽코 회원 등록 후 예약 등록까지 자동 처리됨** (별도 조치 불필요)
- 등록 성공 시 **픽코 등록/결제 후 네이버 예약 차단**까지 이어진다.

#### 부족 정보 응답 예시
- 룸 없음 → `⚠️ 예약 등록에 필요한 정보가 부족합니다: room. 예: "3월 18일 15:00-16:30 A1 010-2792-2221 민경수 예약해줘"`
- 전화번호 없음 → `⚠️ 예약 등록에 필요한 정보가 부족합니다: phone.`
- 여러 줄 입력 예시:
  - `민경수 010-2792-2221`
  - `3월 18일 15:00-16:30 A1`
  - `예약해줘`
  → 위 3개를 하나로 합쳐 실행

---

### 시나리오 2: 회원 가입만 (예약 없이 회원만 등록)

사장님이 "XXX 회원가입해줘" 또는 "XXX 회원으로 등록해줘"라고 하면 → `dist/ts-runtime`의 `pickko-member.js` 실행

```bash
node ~/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/admin/pickko-member.js \
  --phone=01000000000 --name=이름
```

- stdout JSON `{ success, isNew, message }`
- `isNew: false` → "이미 등록된 회원입니다: 이름 (번호)" 보고
- `isNew: true` → "신규 회원 등록 완료: 이름 (번호)" 보고

---

### 자연어 → 인자 파싱 규칙

| 입력 | 변환 |
|------|------|
| 오늘, 내일 | YYYY-MM-DD (KST 기준) |
| M월D일 | 해당 월일의 YYYY-MM-DD |
| 오전N시, 오후N시 | HH:MM (24시간, 예: 오후3시 → 15:00) |
| 오전N시M분, 오후N시M분 | HH:MM |
| A룸, A1, B룸 | A1 \| A2 \| B |
| 전화번호 010-XXXX-XXXX | 하이픈 제거 후 그대로 |

---

### 실행 예시

```
사장님: "3월 5일 오후 3시~5시 A1 010-1234-5678 홍길동 예약해줘"
→ node .../dist/ts-runtime/bots/reservation/manual/reservation/pickko-register.js --date=2026-03-05 --start=15:00 --end=17:00 --room=A1 --phone=01012345678 --name=홍길동
  (홍길동이 신규 회원이어도 자동 등록 후 예약까지 처리됨)

사장님: "010-1234-5678 홍길동 회원가입해줘"  ← 예약 없이 회원만
→ node .../dist/ts-runtime/bots/reservation/manual/admin/pickko-member.js --phone=01012345678 --name=홍길동
```

> **스크립트 경로**: `~/projects/ai-agent-system/bots/reservation/`
> stdout에서 JSON 파싱 후 성공/실패 여부를 사장님께 텔레그램으로 보고할 것

---

---

## 🔍 자연어 예약 조회 명령

사장님이 예약 현황을 물어보면 아래 절대 경로로 실행하고 `message` 필드를 텔레그램으로 전송한다.

```bash
node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-query.js [옵션]
```

| 옵션 | 설명 | 예시 |
|------|------|------|
| `--date=today` | 오늘 예약 조회 | "오늘 예약 알려줘" |
| `--date=tomorrow` | 내일 예약 조회 | "내일 예약 있어?" |
| `--date=YYYY-MM-DD` | 특정 날짜 조회 | "3월 5일 예약 알려줘" |
| `--phone=010XXXXXXXX` | 번호로 검색 | "010-1234-5678 예약 조회" |
| `--name=이름` | 이름으로 검색 | "홍길동 예약 확인해줘" |
| `--room=A1` | 룸별 조회 | "A1룸 예약 현황" |

- stdout JSON `{ success, count, message, bookings }`
- `success: true` → `message` 그대로 텔레그램 전송
- `success: false` → `message` 오류 안내 전송
- **데이터 소스**: `naver-bookings-full.json` (5분 주기 갱신, 네이버 확정 예약만)

### 조회 예시

```
SCRIPT=/Users/alexlee/projects/ai-agent-system/bots/reservation/manual/reservation

사장님: "오늘 예약 현황 알려줘"
→ node $SCRIPT/pickko-query.js --date=today

사장님: "3월 5일 예약 있어?"
→ node $SCRIPT/pickko-query.js --date=2026-03-05

사장님: "정진영 예약 언제야?"
→ node $SCRIPT/pickko-query.js --name=정진영

사장님: "010-1234-5678 예약 조회"
→ node $SCRIPT/pickko-query.js --phone=01012345678
```

---

## ❌ 자연어 예약 취소 명령

사장님이 예약 취소를 요청하면 `pickko-cancel-cmd.js`를 실행한다.

**2단계 자동 처리:**
1. **픽코 취소** (`pickko-cancel.js`) — 픽코 어드민에서 예약 환불 처리
2. **네이버 해제** (`pickko-kiosk-monitor.js --unblock-slot`) — 네이버 예약불가 → 예약가능 복구

```bash
node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-cancel-cmd.js \
  --phone=01012345678 --date=2026-03-05 \
  --start=15:00 --end=17:00 --room=A1 [--name=홍길동]
```

- stdout JSON `{ success, message [, naverUnblockFailed, partialSuccess, pickkoCancelled] }`
- `success: true` → 픽코 취소 + 네이버 해제까지 완료된 완전 성공
- `success: false` + `partialSuccess: true` + `pickkoCancelled: true` + `naverUnblockFailed: true`
  → 픽코 취소는 성공, 네이버 해제는 실패
  → 상위 응답 레이어는 "픽코 취소 완료, 네이버 수동 확인 필요"로 안내
- `success: false` → 픽코 취소 자체 실패, 수동 취소 요청

### 취소 예시

```
SCRIPT=/Users/alexlee/projects/ai-agent-system/bots/reservation/manual/reservation

사장님: "홍길동 3월 5일 3시 예약 취소해줘"
→ node $SCRIPT/pickko-query.js --phone=01012345678 --date=2026-03-05  (예약 확인 먼저)
→ node $SCRIPT/pickko-cancel-cmd.js --phone=01012345678 --date=2026-03-05 --start=15:00 --end=17:00 --room=A1 --name=홍길동
```

> **중요**: 취소 전에 반드시 `pickko-query.js`로 예약 정보를 확인한 후 처리할 것
> (전화번호·날짜·시간·룸이 모두 정확해야 함)

---

## 📊 자연어 매출 통계 명령

사장님이 매출을 물어보면 `dist/ts-runtime/.../pickko-stats-cmd.js`를 실행하고 `message` 필드를 텔레그램으로 전송한다.

```bash
node ~/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reports/pickko-stats-cmd.js [옵션]
```

| 사장님 말 | 실행 옵션 |
|-----------|-----------|
| "오늘 매출", "오늘 얼마야" | `--date=today` |
| "어제 매출", "어제 얼마였어" | `--date=yesterday` |
| "N월 M일 매출" | `--date=2026-MM-DD` |
| "이번 주 매출", "이번주 얼마야" | `--period=week` |
| "이번 달 매출", "이번달 총 얼마야" | `--period=month` |
| "N월 매출", "2월 매출 알려줘" | `--month=2026-0N` |
| "누적 매출", "지금까지 총 얼마야", "전체 매출" | `--cumulative` |

- stdout JSON `{ success, message }`
- `success: true` → `message` 그대로 텔레그램 전송
- `success: false` → `message` 오류 안내 전송
- **데이터 소스**: `state.db daily_summary` (00:00/09:00 갱신) — 당일 집계 전이면 "데이터 없음" 안내

### 매출 통계 예시

```
사장님: "오늘 매출 얼마야?"
→ node .../dist/ts-runtime/.../pickko-stats-cmd.js --date=today

사장님: "이번달 총 얼마야?"
→ node .../dist/ts-runtime/.../pickko-stats-cmd.js --period=month

사장님: "2월 매출 알려줘"
→ node .../dist/ts-runtime/.../pickko-stats-cmd.js --month=2026-02

사장님: "지금까지 누적 매출 알려줘"
→ node .../dist/ts-runtime/.../pickko-stats-cmd.js --cumulative
```

> **주의**: 매출 데이터는 `pickko-daily-summary.js`가 00:00/09:00에 집계. 당일 실시간 매출이 필요하면 "데이터 집계 전"임을 안내 후 `pickko-daily-summary.js --midnight` 실행 제안

---

## 🐛 버그 리포트 & 유지보수 기록 시스템

### 이 시스템이 무엇인가?

스카와 클로드가 공동으로 사용하는 **버그·개발 이력 추적 도구**다.

- 스카가 운영 중 이상을 발견하면 → `bug-report.js --new`로 등록 → 클로드에게 보고
- 클로드가 코드를 수정하면 → `bug-report.js --maintenance`로 기록
- 등록 즉시 `context/HANDOFF.md`의 이슈·유지보수 섹션이 **자동으로 갱신**됨
- 이 기록이 쌓이면 다음 클로드 세션이 어떤 작업이 있었는지 빠르게 파악할 수 있음

```
스카 발견 → bug-report.js --new → HANDOFF.md 자동 갱신 → 클로드 보고
클로드 수정 → bug-report.js --maintenance → HANDOFF.md 자동 갱신
```

### 저장 위치
- 버그 데이터: `~/.openclaw/workspace/bug-tracker.json`
- HANDOFF.md 갱신: `context/HANDOFF.md` 직접 수정 (deploy 없이 자동 반영)

### 스카가 버그를 발견했을 때 (즉시 실행)

```bash
cd ~/projects/ai-agent-system/bots/reservation

# 버그 등록 (반드시 --by ska 명시)
node dist/ts-runtime/bots/reservation/src/bug-report.js --new \
  --title "문제 요약 (한 줄)" \
  --desc "구체적인 현상: 언제, 어떤 상황에서, 어떤 오류가 발생했는지" \
  --severity high \
  --category stability \
  --by ska \
  --files "auto/monitors/naver-monitor.js"

# 등록 후 텔레그램으로 클로드에게 보고
# 예: "BUG-005 등록했어. naver-monitor.js에서 XX 오류 발생 중"
```

### 버그 상태 확인

```bash
node dist/ts-runtime/bots/reservation/src/bug-report.js --list              # 미해결 버그
node dist/ts-runtime/bots/reservation/src/bug-report.js --list --status all # 전체 목록
node dist/ts-runtime/bots/reservation/src/bug-report.js --show --id BUG-001 # 특정 버그 상세
node dist/ts-runtime/bots/reservation/src/bug-report.js --maint-list        # 유지보수 이력 (클로드 작업 내역)
```

### 버그 상태 흐름
```
open (스카 등록) → in_progress (클로드 조치 중) → resolved (수정 완료)
```

### severity / category 기준

| severity | 기준 | 예시 |
|----------|------|------|
| `critical` | 모니터링 전면 중단, 데이터 손실 위험 | 프로세스 사망, DB 오류 |
| `high` | 자동화 오작동, 수동 개입 필요 | 픽코 등록 반복 실패 |
| `medium` | 기능 저하, 운영은 가능 | 알림 지연, 로그 이상 |
| `low` | 사소한 불편 | 로그 문구 오타 |

| category | 예시 |
|----------|------|
| `stability` | 재시작, 크래시, 프로세스 종료 |
| `logic` | 중복 처리, 상태 오류, 오감지 |
| `reliability` | 픽코 등록 실패, 네트워크 타임아웃 |
| `ux` | 알림 내용 이상, 텔레그램 메시지 오류 |
| `data` | DB/JSON 파일 오염, 파싱 오류 |

---

## 변경 이력

### 2026-02-26 (야간3) — 버그리포트 시스템 설명 보강

**변경 이유:** 스카가 "버그리포트에 올려줘" 요청을 받고 뭔지 몰라 역질문하는 문제 발생.

**변경 내용:**
- 버그리포트 섹션 전면 보강: 시스템 목적·동작 원리·스카 역할 명확히 기술
- 행동 지침 테이블: "버그리포트에 올려줘" → 되묻지 말고 즉시 등록 지침 추가
- bug-report.js HANDOFF_FILE 경로 수정 내용 반영 (context/HANDOFF.md 직접 갱신)

### 2026-03-16 — 예약 경로 회원정보 수정 금지 규칙 고정

**고정 규칙:**
- 예약/재등록 경로는 **회원 판별만 수행**하고, 기존 회원정보를 자동 수정하지 않는다.
- 기존회원 이름이 네이버 예약 이름과 다르면 **알림만 발송**하고 예약은 계속 진행한다.
- 회원 정보 수정은 **마스터 수동 작업**으로만 처리한다.

**현재 동작:**
- `pickko-accurate.js` 1.5단계는 이름 비교만 수행
- 이름 일치 → 그대로 진행
- 이름 불일치 → `andy` 알림 발송
- 신규회원만 회원등록 로직으로 이동

**금지 사항:**
- 예약 경로에서 `회원 정보 수정` 버튼 클릭 금지
- 네이버 이름으로 기존회원 이름 자동 저장 금지
- 재등록 경로에서 네이버 차단 자동 실행 금지

---

### 2026-02-26 — JSON → SQLite 마이그레이션 + 개인정보 암호화

**변경 이유:** 상태 파일 6개 분산 관리 → 단일 state.db 통합, 전화번호/이름 평문 노출 제거

**변경 내용:**
- `lib/crypto.js` 신규 — AES-256-GCM encrypt/decrypt + SHA256 kiosk 해시 키 (Node.js crypto 내장)
- `lib/db.js` 신규 — SQLite 싱글턴 + reservations/cancelled_keys/kiosk_blocks/alerts 4개 테이블
- `scripts/migrate-to-sqlite.js` 신규 — 1회 마이그레이션 (42건 reservations, 1 cancelled_key, 5 kiosk_blocks, 34 alerts 이전 완료)
- `naver-monitor.js` 전환 — isSeenId/markSeen/addReservation 등 모두 DB 함수 사용
- `pickko-kiosk-monitor.js` 전환 — getKioskBlock/upsertKioskBlock/pruneOldKioskBlocks 사용
- `pickko-daily-audit.js` 전환 — collectNaverKeys() → db.getAllNaverKeys()
- `pickko-verify.js` 전환 — 이중 파일 → getPendingReservations() 단일 DB 쿼리
- `pickko-register.js` 전환 — naver-seen.json 직접 조작 → addReservation/markSeen
- `naver-monitor.js` 버그 수정 — pruneOldCancelledKeys() 미호출 버그 수정 (import + cleanupExpiredSeen에 추가)

**스카 행동 변경:**
- 없음 — 내부 저장소 변경, 외부 인터페이스 동일
- `.pickko-alerts.jsonl` 파일은 더 이상 사용하지 않음 (state.db alerts 테이블 사용)
- 상태 파일 참조 시 `~/.openclaw/workspace/state.db` 사용 (JSON 파일 참조 금지)

---

### 2026-02-26 — 자연어 명령 확장 (조회·취소)

**추가 내용:**
- `pickko-query.js` 신규 — 예약 조회 CLI (날짜/이름/번호/룸 필터, stdout JSON)
- `pickko-cancel-cmd.js` 신규 — 스카 수동 취소 래퍼 (stdout JSON)
- `CLAUDE_NOTES.md` — 조회·취소 행동 지침 추가

**스카 행동 변경:**
- "오늘 예약 현황" 류 조회 요청 → `pickko-query.js` 실행 후 결과 전송
- "XXX 예약 취소해줘" 류 취소 요청 → `pickko-cancel-cmd.js` 실행 후 결과 전송

---

### 2026-02-26 — 이용권 추가 자연어 명령 추가

**추가 내용:**
- `pickko-ticket.js` 신규 — 픽코 키오스크 이용권 추가 CLI (전화번호 기반)
- `CLAUDE_NOTES.md` — 이용권 추가 NLP 매핑 테이블 추가

**스카 행동 변경:**
- "XXX한테 N시간 이용권 추가해줘" 류 → `pickko-ticket.js --phone=... --ticket=...` 실행 후 결과 전송
- 기간권(14일권/28일권)은 중복 방지 count=1 강제

---

### 2026-02-26 — 텔레그램 알람 안정성 개선

**변경 내용:**
- `sendTelegramDirect` async 변환 + 3회 재시도 (3s/6s 백오프)
- `pending-telegrams.jsonl` 대기큐 — 최종 실패 시 저장, 재시작 시 자동 재발송
- `sendAlert` 버그 수정: `sent: inAlertWindow` → `sent: false` 저장 후 성공 확인 시 `true` 갱신
- start-ops.sh self-lock: 중복 실행 차단

---

### 2026-02-25 — 스카봇 안정화 업데이트 8건

**변경 이유:** 운영 중 발견된 데이터 손실·중복등록·주기 밀림 위험 방어

**변경 내용:**

| # | 파일 | 내용 |
|---|------|------|
| C-1 | `lib/files.js`, `naver-monitor.js saveSeen()` | atomic write (tmp→rename) — 쓰기 도중 프로세스 종료 시 파일 손상 방지 |
| C-2 | `pickko-verify.js markCompleted()` | `name` 필드 누락 수정 — verified 처리 후 이름이 사라지는 버그 수정 |
| C-3 | `pickko-accurate.js` | 시간 슬롯 선택 1회→3회 재시도 — AJAX 갱신 타이밍 미스 대응 |
| H-1 | `naver-monitor.js` | `rollbackProcessingEntries()` 추가 — `process.exit(1)` 4곳 전에 `processing` 항목을 `failed`로 롤백 |
| H-2 | `start-ops.sh` | 로그 파일 관리 추가 — `/tmp/naver-ops-mode.log` 리다이렉션 + 1000줄 로테이션 |
| H-3 | `naver-monitor.js` | `pruneSeenIds()` 추가 — `slice(-500)` 대신 90일 지난 예약 ID 날짜 기준 정리 |
| H-4 | `pickko-register.js` | 등록 성공 후 `naver-seen.json`에 `manual` 항목 기록 — `pickko-daily-audit` 오탐 방지 |
| M-1 | `naver-monitor.js` | `cycleStart` 기반 사이클 타임 관리 — 사이클 소요시간 차감 후 sleep (주기 밀림 방지) |
| M-2 | `ai.ska.pickko-daily-audit.plist` | 22:00 단독 → 22:00 + 23:50 이중 실행 (22~23시 접수 예약 누락 방지) |

**스카 행동 변경 없음** — 내부 안정성 강화, 외부 인터페이스 동일

---

### 2026-02-25 — pickko-verify.js needsVerify() 개선

**변경 이유:** `completed`이지만 `pickkoStatus`가 `paid`/`auto`인 항목을 verified로 올리려면 임시로 `status: 'pending'`으로 바꿔야 했음 → 위험한 우회 방식 제거

**변경 내용:**
- `needsVerify(entry)` 함수 추가
  - `pending` / `failed` → 항상 검증 대상 (기존 동일)
  - `completed` + `pickkoStatus`가 `verified`·`manual`이 **아닌** 것(paid, auto 등) → 검증 대상 (신규)
- 이제 `pickko-register.js`로 등록한 예약(status=completed, pickkoStatus=manual)은 pickko-verify 재검증 대상에서 제외됨

---

### 2026-02-25 — naver-seen.json entry object loss 버그 방어

**변경 이유:** `updateBookingState('completed')` 저장(N건) 직후 `loadSeen()`이 N-1건을 읽는 타이밍 버그 발생 → 방금 등록한 entry 객체가 사라지는 현상

**변경 내용:**
- `_lastSeenDataSnapshot` 모듈 변수 추가
- `updateBookingState()` — `saveSeen()` 직후 스냅샷 저장
- OPS/DEV 코드=0 완료 블록 — `loadSeen()` 대신 스냅샷 우선 사용 후 null 초기화

**한송이 3건 백필** (2026-03-09, 03-23, 03-30 A1룸) — 버그로 유실된 entry 수동 복원 + pickko-verify로 verified 확인 완료

---

### 2026-02-24 — 픽코 3가지 기능 신규 추가

**변경 이유:** 수동 관리가 필요했던 감사/예약등록/회원가입 자동화

**변경 내용:**
- `pickko-daily-audit.js` 신규 — 당일 픽코 등록 예약 사후 감사 (매일 22:00, launchd)
  - 픽코 study/index.html 접수일시 최신순 조회 → 오늘 등록 항목 수집
  - naver-seen.json auto 항목과 비교 → 전화/수동 예약 탐지 → 텔레그램 리포트
  - `run-audit.sh`, `ai.ska.pickko-daily-audit.plist` 함께 생성
- `pickko-register.js` 신규 — 자연어 예약 등록 CLI 래퍼
  - pickko-accurate.js 위임 실행, stdout JSON `{ success, message }` 출력
  - 스카가 자연어 파싱 후 shell 명령으로 호출
- `pickko-member.js` 신규 — 신규 회원 가입 CLI 래퍼
  - 회원 존재 여부 확인 → 기존 회원 안내 OR 신규 등록
  - stdout JSON `{ success, isNew, message }` 출력
- `CLAUDE_NOTES.md` — 자연어 예약/회원가입 행동 지침 추가

---

### 2026-02-24 — 버그 추적 & 유지보수 기록 시스템 도입

**변경 이유:** 스카가 발견한 버그를 구조화·추적하고, 유지보수 이력을 HANDOFF.md에 자동 반영

**변경 내용:**
- `bug-tracker.json` 신규 생성 (`~/.openclaw/workspace/`) — 버그+유지보수 통합 저장
- `bug-report.js` 신규 생성 (`src/`) — 스카·클로드 공용 CLI
- `HANDOFF.md` — 🐛 이슈 / 🔧 유지보수 마커 섹션 추가 (자동 갱신)
- 오늘 처리한 BUG-001(불안정성), BUG-002(재감지 루프), BUG-003(알림 관리) + MAINT-001~004 초기 등록

### 2026-02-24 — naver-monitor.js 알림 resolved 상태 관리 (BUG-003)

**변경 내용:**
- `sendAlert()` — `resolved`/`resolvedAt` 필드 추가 (`type:error` → `false`, 나머지 → `true`)
- `sendAlert()` — `start` 파라미터 추가 (오류 알림 매칭용)
- `resolveAlertsByBooking(phone, date, start)` 신규 함수 — 픽코 성공/수동처리 시 자동 해결 마킹
- `cleanupOldAlerts()` 개선 — `resolved:false` 7일, `resolved:true` 48h 차등 보존
- `reportUnresolvedAlerts()` 신규 함수 — 시작 시 미해결 알림 텔레그램 발송

### 2026-02-24 — naver-monitor.js 상태 관리 로직 개선 (BUG-002)

**변경 내용:**
- **Fix A**: 루프 시작 시 `completed`/`manual` 건 `seenIds` 사전 마킹 (재감지 루프 방지)
- **Fix B**: `runPickko()` `code 99` (MAX_RETRIES 초과) 시 `seenIds` 마킹 (재감지 차단)
- **Fix**: `confirmedCount` 블록 스코프 오류 수정 → 루프 스코프로 격상 (`let confirmedCount = 0`)

### 2026-02-24 — naver-monitor.js 불안정성 수정 (BUG-001)

**변경 내용:**
- `lastHeartbeatTime = Date.now()` 초기화 (시작 직후 0분 Heartbeat 방지)
- `detachRetryCount` 추가 — detached Frame 3회 재시도 + 페이지 재생성 (즉시 exit 방지)
- `start-ops.sh` Chrome cleanup `sleep 3→5`초 증가

### 2026-02-24 — 취소 감지 1 글리치 방어

**변경 내용:**
- `confirmedCount === 0` 이면 취소 감지 1 스킵 (페이지 로딩 글리치 오취소 방지)

---

### 2026-02-24 — 클로드↔봇 전달 채널 시스템 구축

**변경 이유:** 클로드가 코드를 수정했을 때 봇이 변경 내용을 인지할 수 있는 전용 채널 필요

**변경 내용:**
- `CLAUDE_NOTES.md` 신규 생성 — 클로드가 스카에게 전달하는 전용 파일
- `registry.json` openclaw 파일 목록에 추가 → 배포 시 자동 포함
- BOOT.md 읽기 순서 5번에 `CLAUDE_NOTES.md` 추가
- `deploy-context.js` — `updateSystemStatus()` 추가 (배포 시 클로드 메모리에 시스템 현황 자동 갱신)

---

### 2026-02-24 — sendAlert() 야간 알림 차단

**변경 이유:** 22:00~09:00 사이 텔레그램 알림을 받지 않겠다는 운영 정책 반영

**변경 내용:**
- `sendAlert()` — 09:00~22:00 외에는 텔레그램 발송 차단
  - 야간: `sent: false`로 파일에만 기록
  - 주간: `sent: true`로 즉시 발송 (기존 동일)
- `flushPendingAlerts()` 함수 신규 추가
  - `sent: false` 항목 모아서 요약 메시지 한 번에 발송
  - 발송 후 `sent: true`로 업데이트
- Heartbeat 블록에 오전 flush 트리거 추가
  - 09:00 이후 첫 Heartbeat 시 자동 실행 (당일 1회)

---

## 클로드 작성 규칙 (참고)

- 행동 지침 테이블은 "현재 유효한 것"만 유지 (오래된 것은 삭제)
- 변경 이력은 최신 순 (날짜 역순) 으로 기록
- 스카가 오해하기 쉬운 파일/변수/동작은 반드시 여기에 명시
