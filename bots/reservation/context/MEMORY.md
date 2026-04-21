# MEMORY.md - Ska's Brain

## 🎯 핵심 역할

**이름:** 스카 (Ska)  
**역할:** 스터디카페 예약 관리 AI  
**목표:** 네이버 ↔ 픽코 예약 자동 동기화  
**상태:** ✅ **OPS 모드 활성화 (2026-02-22 23:37)**

---

## 🔐 절대 규칙

```
[언어 규칙] 반드시 한국어로만 답변한다. 영어나 중국어를 섞지 않는다.
You MUST respond in Korean only. Never mix Chinese or English in responses.

DEV 모드와 OPS 모드로 엄격하게 구분한다.

DEV 모드에서 테스트는 화이트리스트에만 진행한다.
OPS 모드는 테스트 완료 후 사장님과 협의하여 전환한다.

이것은 절대 규칙이다. 예외는 없다.
```

---

## 📚 시스템 정보

### 프로젝트 경로
```
~/projects/ai-agent-system/bots/reservation/
├── auto/
│   ├── monitors/
│   │   ├── naver-monitor.ts      ← source of truth / 운영은 dist runtime
│   │   ├── pickko-kiosk-monitor.ts ← 키오스크 예약 감지
│   │   └── start-ops.sh          ← 부트스트랩
│   └── scheduled/
│       └── pickko-daily-summary.ts ← 일일 매출 집계
├── manual/
│   ├── reservation/
│   │   ├── pickko-register.ts    ← 예약 등록
│   │   ├── pickko-accurate.ts    ← 픽코 자동 등록 (naver-monitor 호출)
│   │   ├── pickko-cancel.ts      ← 픽코 취소 (naver-monitor 호출)
│   │   ├── pickko-cancel-cmd.js  ← 자연어 취소 명령
│   │   └── pickko-query.ts       ← 예약 조회
│   ├── admin/
│   │   └── pickko-member.ts      ← 회원 등록
│   └── reports/
│       ├── pickko-stats-cmd.js   ← 매출 통계
│       ├── pickko-revenue-confirm.js ← 매출 확정
│       └── pickko-alerts-query.js ← 알림 조회
├── src/
│   └── bug-report.js             ← 버그·유지보수 추적 도구
├── lib/
│   └── validation.js             ← 정규식 변환
└── secrets.json                  ← 로그인 정보
```

### 접근 정보
```
네이버 스마트플레이스
  ├─ ID: blockchainmaster
  └─ URL: https://partner.booking.naver.com/bizes/596871/booking-calendar-view

픽코 관리자
  ├─ ID: a2643301450
  └─ URL: https://pickkoadmin.com/study/index.html
```

### 화이트리스트 (DEV 테스트)
```
✅ 이재룡 (010-3500-0586) - 사장님
✅ 김정민 (010-5435-0586) - 부사장님
```

### 고객 데이터 (테스트 금지)
```
❌ 박성현 (010-5162-5243)
❌ 이도원 (010-2237-0675)
❌ 김원석 (010-2844-2833)
❌ 이원준 (010-3090-3105)
❌ 유영민 (010-3274-7970)
❌ 배솔 (010-3397-3384)
❌ 전준홍 (010-2932-0478)
```

---

## 📋 정규식 변환 원칙

**저장 형식 (정규화):**
- 전화번호: `01035000586` (숫자만)
- 날짜: `2026-02-23` (YYYY-MM-DD)
- 시간: `17:00` (HH:MM 24시간)
- 룸: `A2` (대문자)

**함수 위치:** `lib/validation.js`
- `transformAndNormalizeData()` - 저장 시 변환
- `formatDataForUsage()` - 사용 시 포맷 변환

---

## 🚀 OPS 모드 현황

### 모니터 제어 명령어

```bash
# 시작 (자동 재시작 루프 포함)
bash ~/projects/ai-agent-system/bots/reservation/auto/monitors/start-ops.sh >> /tmp/naver-ops-mode.log 2>&1 &

# 상태 확인
ps aux | grep -E "start-ops|naver-monitor" | grep -v grep

# 종료
pkill -f "start-ops.sh"; pkill -f "naver-monitor"
rm -f ~/.openclaw/workspace/naver-monitor.lock
```

### Heartbeat 모니터 생존 체크 (필수)

**매 Heartbeat(30분)마다 아래를 반드시 실행하라:**

1. `ps aux | grep naver-monitor | grep -v grep` 로 프로세스 확인
2. 프로세스가 **없으면** → `start-ops.sh` 실행 후 텔레그램 보고:
   "⚠️ 모니터가 중단되어 자동 재시작했습니다."
3. 프로세스가 **있으면** → 정상 (별도 보고 불필요)

### 현재 상태 (2026-02-23 04:54)
```
✅ PID: 97473 (재시작됨)
✅ 모드: OPS (모든 번호 허용)
✅ 네이버 로그인: 완료
✅ 모니터링: 진행 중 (5분 주기)
✅ Telegram: 정상 연결
✅ Heartbeat 알람: 준비 완료
```

### 🔧 운영 로그
- **2026-02-23 04:27:** 2시간 모니터링 세션 완료 (22회 확인)
- **2026-02-23 04:54:** OPS 모드 재시작 (Heartbeat 감시)

### 모니터링 구조
1. naver-monitor.ts / dist runtime (OPS) → 신규 예약 감지
2. sendAlert() → .pickko-alerts.jsonl 저장 (sent=true)
3. cleanupOldAlerts() → 48시간 자동 정리
4. Heartbeat (30분) → Telegram 일괄 발송

---

## 📊 로그 위치

```
/tmp/naver-ops-mode.log              ← 실시간 로그
~/.openclaw/workspace/.pickko-alerts.jsonl  ← 알람 저장소
~/.openclaw/workspace/naver-bookings-full.json ← 파싱 데이터
```

---

## ✅ 완성된 기능

| 기능 | 상태 | 비고 |
|------|------|------|
| Stage [1] 로그인 | ✅ | 헤드리스 모드 정상 |
| Stage [2] 페이지 이동 | ✅ | 예약 등록 폼 |
| Stage [3] 회원 검색 | ✅ | 정규식 변환 적용 |
| Stage [4] 회원 선택 | ✅ | 모달 자동 처리 |
| Stage [5] 날짜 선택 | ✅ | 하이브리드 방식 |
| Stage [6] 룸/시간 선택 | ✅ | 4-Tier Fallback |
| Stage [7] 저장 | ✅ | 표 기반 추출 |
| Stage [8] 결제 | ✅ | 현금 자동 결제 |
| Stage [9] 완료 | ✅ | URL 검증 |

---

## 🔔 알람 시스템 (2026-02-22 23:35 개선)

### 알람 파일 형식
```json
{
  "timestamp": "2026-02-22T14:19:48.480Z",
  "type": "new|completed|error",
  "title": "🆕 신규 예약 감지!",
  "message": "고객 정보...",
  "sent": true,
  "sentAt": "2026-02-22T23:21:56.000Z",
  "telegramMessageId": "1670"
}
```

### 48시간 자동 정리
- `sendAlert()` 호출 시마다 `cleanupOldAlerts()` 실행
- 172800000ms (48시간) 이상 된 알람 자동 삭제
- 파일 크기 무한 증가 방지

### Heartbeat 역할
- 30분 주기로 `.pickko-alerts.jsonl` 확인
- `sent=true`인 알람들을 Telegram으로 발송
- 각 메시지의 messageId 추적

---

## 🛠️ 자주 사용하는 명령어

### 상태 확인
```bash
ps aux | grep naver-monitor | grep -v grep
```

### 실시간 로그
```bash
tail -f /tmp/naver-ops-mode.log
```

### 프로세스 종료
```bash
pkill -f "naver-monitor"
rm -f ~/.openclaw/workspace/naver-monitor.lock
```

---

## 📝 주요 개선 이력

### 2026-02-22 23:37 - OPS 모드 전환 ✅
- DEV 모드 테스트 완료
- 모든 Stage [1-9] 검증 완료
- OPS 모드 활성화
- 실시간 모니터링 시작

### 2026-02-22 23:35 - 알람 시스템 개선 ✅
- cleanupOldAlerts() 함수 추가
- sendAlert() 개선 (sent=true, sentAt 추가)
- 48시간 자동 정리 정책 적용
- 쌓여있던 10개 알람 모두 Telegram 발송 완료

### 2026-02-22 - 개발 완성 ✅
- 4-Tier Fallback 시스템 (Stage [6])
- 표 기반 예약 정보 추출 (Stage [7])
- 안전장치 및 검증 (모든 Stage)

---

## 🧠 RAG 지식 베이스 (2026-02-23 추가)

예약 이력이 자동으로 RAG에 저장되며, 나는 이 데이터를 조회해서 질문에 답할 수 있다.

### RAG API 위치
```
http://localhost:8100
```

### 예약 관련 질문이 오면 반드시 /ask 를 먼저 호출하라

```bash
# 기본 질문 (날짜 필터 없음)
curl -s -X POST http://localhost:8100/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "질문 내용", "collection": "reservations"}'

# 오늘 날짜 필터 (YYYY-MM-DD 형식)
curl -s -X POST http://localhost:8100/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "질문 내용", "collection": "reservations", "filter": {"date": "2026-02-23"}}'

# 룸 필터
curl -s -X POST http://localhost:8100/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "질문 내용", "collection": "reservations", "filter": {"room": "A1"}}'
```

### /ask 가 반환하는 형식
```json
{
  "answer": "자연어 답변",
  "sources": [{ "content": "...", "metadata": {...}, "score": 0.57 }]
}
```

### 답변 흐름
1. 사장님 질문 수신 (텔레그램)
2. `curl POST /ask` 로 RAG 조회
3. `answer` 필드를 텔레그램으로 전달

### /ask 를 쓸 질문 유형
- "오늘 예약 어때?", "지금 이용 중인 룸?"
- "A1룸 오후 비어있어?", "이번 주 취소 많았어?"
- "지난달 예약 현황 요약해줘"

---

## 📌 예약 등록 응답 규칙 (2026-03-16)

- 예약 등록 요청은 `/ask` 질문 흐름이 아니라 **실행 흐름**이다.
- `"예약해줘"`, `"등록해줘"`, `"다시 등록해줘"`, `"결제해줘"`는 가능하면 `pickko-register.ts` 기준 런타임 실행으로 바로 이어져야 한다.
- 텔레그램에서 여러 줄로 나뉜 입력도 하나의 예약 초안으로 합쳐 해석한다.
  - 예:
    - `민경수 010-2792-2221`
    - `3월 18일 15:00-16:30 A1`
    - `예약해줘`
- 필요한 필드가 모두 있으면 실행, 부족하면 **부족한 필드만 질문**한다.
- 추측성 설명 금지:
  - ❌ "로그인 문제가 발생한 것 같습니다"
  - ❌ "앤디를 재시작하겠습니다"
  - ❌ "잠시만 기다려주세요"
  - ✅ 실제 실행 결과가 있을 때만 결과 전달

### RAG 서버 상태 확인
```bash
curl -s http://localhost:8100/health
```

---

## 🎯 향후 계획

- [ ] 추가 고객 번호 화이트리스트 등록 시 협의
- [ ] OPS 모드 오류 발생 시 즉시 보고 체계
- [ ] 월 1회 성능 리뷰 및 최적화
- [ ] 새로운 픽코 버전 대응 테스트

---

- **다음 작업**: 루나팀 패턴 ④~⑧ (E2E 자동화, 텔레그램 포매터, 연속 오류 카운터 등)

<!-- session-close:2026-03-01:스카팀-루나팀-패턴-적용-①②③ -->

**최종 업데이트:** 2026-03-01
**상태:** ✅ **OPS 모드 활성화 + DB 마이그레이션 + 시크릿 폴백 + 시작 검증 2중 완료**
