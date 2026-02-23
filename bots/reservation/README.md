# 📅 예약관리봇 (스카)

네이버 스마트플레이스 신규/취소 예약 → 픽코 키오스크 자동 동기화 봇

**현재 상태: ✅ OPS 모드 실운영 중**

---

## 시스템 구조

```
[네이버 스마트플레이스]
        ↓ 신규 예약 감지 (3분 주기)     ↓ 취소 감지 (리스트 비교)
[naver-monitor.js]
        ↓ runPickko()                  ↓ runPickkoCancel()
[pickko-accurate.js]           [pickko-cancel.js]
   Stage [1-9] 자동 등록          취소 처리 [1-10]
        ↓
[픽코 키오스크] ← 예약 등록+결제 / 취소 상태 변경
        ↓
[Telegram] ← 사장님 알람 (new/completed/cancelled/error)
        ↓
[RAG API] ← 예약 이력 저장 (http://localhost:8100)
```

---

## 파일 구조

```
reservation/
├── src/
│   ├── naver-monitor.js      # 네이버 모니터링 + 픽코 트리거 (메인)
│   ├── pickko-accurate.js    # 픽코 자동 예약 등록 Stage [1-9]
│   ├── pickko-cancel.js      # 픽코 자동 취소 Stage [1-10]
│   ├── pickko-verify.js      # pending/failed 예약 재검증 + 자동 등록
│   └── start-ops.sh          # OPS 자동 재시작 루프
├── lib/
│   ├── validation.js         # 전화번호/날짜/시간 정규식 변환
│   ├── utils.js              # delay, log
│   ├── secrets.js            # loadSecrets()
│   ├── formatting.js         # toKoreanTime, pickkoEndTime, formatPhone
│   ├── files.js              # loadJson, saveJson
│   ├── args.js               # parseArgs()
│   ├── browser.js            # getPickkoLaunchOptions, setupDialogHandler
│   └── pickko.js             # loginToPickko()
├── secrets.json              # 네이버/픽코 로그인 정보 (git 제외)
├── naver-seen.json           # OPS 예약 상태 저장
├── naver-seen-dev.json       # DEV 예약 상태 저장
└── package.json
```

---

## 실행

```bash
# OPS 모드 시작 (자동 재시작 루프)
cd ~/projects/ai-agent-system/bots/reservation/src
bash start-ops.sh >> /tmp/naver-ops-mode.log 2>&1 &

# 로그 확인
tail -f /tmp/naver-ops-mode.log

# pending/failed 재검증 (수동)
node src/pickko-verify.js

# dry-run (로그인 없이 대상 목록만 확인)
node src/pickko-verify.js --dry-run
```

---

## 주요 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `MODE` | dev | `ops` = 전체 고객, `dev` = 화이트리스트만 |
| `NAVER_INTERVAL_MS` | 180000 | 모니터링 주기 (ms) |
| `PICKKO_ENABLE` | 0 | 픽코 자동 등록 활성화 |
| `PICKKO_CANCEL_ENABLE` | 0 | 픽코 자동 취소 활성화 |
| `PICKKO_PROTOCOL_TIMEOUT_MS` | 180000 | 픽코 브라우저 프로토콜 타임아웃 |
| `OBSERVE_ONLY` | 0 | 1 = 픽코 실행 없이 관찰만 |

---

## DEV / OPS 모드 (절대 규칙)

```
DEV 모드: 화이트리스트 2명만 테스트
  - 이재룡 (010-3500-0586) 사장님
  - 김정민 (010-5435-0586) 부사장님

OPS 모드: 사장님 협의 후 전환. 모든 고객 번호 처리.
OPS 오류 발생 시: 자동 알람 → 수동 처리 (자체 해결 금지)
```

---

## 관련 문서

- `context/DEV_SUMMARY.md` — 개발 현황 전체 요약
- `context/HANDOFF.md` — 최신 인수인계 (모델 교체 시 참조)
- `VALIDATION_RULES.md` — 데이터 검증 규칙
- `IMPLEMENTATION_CHECKLIST.md` — 코드 리뷰 체크리스트
