# 스카 예약 등록 전체 로직 절차서

기준일: 2026-03-16

목적:
- 스카의 예약 등록 로직 전체를 처음부터 끝까지 추적할 수 있도록 절차를 남긴다.
- 이후 이 문서에 직접 코멘트를 달면서 잘못된 절차, 과한 자동화, 누락된 검증을 점검한다.

## 오늘 수정 대상

상태 기준:
- `[ ]` 미수정
- `[x]` 수정 완료

### A. 오늘 우선 수정할 로직

- [x] `재등록` 용어를 내부적으로 `재시도` 의미로 정리
- [x] 기존회원 이름 비교 단계 번호를 `1.5단계`가 아니라 `4.5단계`로 절차 재배치
- [x] 이름 불일치 시 자동 수정 금지 규칙을 문서 절차에 명시
- [x] 이름 불일치 알림에는 `전화번호 + 픽코 이름 + 네이버 이름`을 함께 보내는 규칙 명시
- [x] 픽코 완료 후 검증 절차 추가
- [x] 앤디 완료 후 검증 절차 추가
- [x] 지미 완료 후 검증 절차는 기존 내용을 유지하되 검증 존재 여부를 명시
- [x] 네이버 시간 규칙 추가
  - [x] `오전 12:00 = 00:00`
  - [x] `오후 12:00 = 12:00`
  - [x] `자정 12:00 = 24:00`
  - [x] `00:00`와 `24:00`는 네이버 UI에서 같은 의미로 합치지 않는 규칙 명시
- [x] 픽코 시간 규칙 추가
  - [x] 슬롯은 25분 단위, 5분 공백
  - [x] 표기는 20분 단위, 10분 생략
- [x] 수동등록 키와 앤디 예약 키 불일치 문제를 오늘 수정 항목으로 명시
- [x] `pickko-register.js`의 async DB 반영 누락을 오늘 수정 항목으로 명시
- [x] 재시도 판정이 문구 의존이라는 점을 오늘 수정 항목으로 명시
- [x] 회원 조회 단계 중복을 구조 개선 후보로 명시

### B. 오늘 수정 완료 후 체크할 항목

- [x] 문서 절차와 실제 코드 단계 번호가 맞는지 재확인
- [x] `pickko-register.js` 수동등록 키를 `${phone}-${date}-${start}`로 통일
- [x] `pickko-register.js` DB 반영(`getReservation/addReservation/updateReservation/markSeen`)에 `await` 적용
- [x] `manual_retry`도 수동 완료 상태와 같은 규칙으로 검증/자동마킹 제외 대상에 포함
- [x] 재시도 판정 결과(`manual_retry`)를 큐 args에도 명시적으로 전달
- [x] 이름 비교를 별도 선조회가 아니라 실제 선택된 기존회원 기준 `4.5단계`로 이동
- [x] 예약 ID / composite key 생성 규칙을 공용 함수 기준으로 핵심 경로에 연결
- [ ] 픽코 성공 / 앤디 판단 / 지미 판단이 같은 예약을 같은 키로 보는지 실동작 재확인
- [ ] 텔레그램에서 `재등록`이라고 말해도 내부적으로 `재시도`로 해석되는지 재확인
- [ ] 이름 불일치 시 고객 정보는 수정되지 않고 알림만 가는지 재확인
- [x] 문서에 오늘 완료 표시 반영

---

## 0. 큰 구조

스카 등록은 크게 4층으로 나뉜다.

1. 제이/OpenClaw가 예약 의도를 인식하는 층
2. 스카 커맨더가 예약 명령을 실행으로 바꾸는 층
3. 픽코 예약 자동화가 실제 등록/결제를 수행하는 층
4. 앤디/지미가 후속 감시와 알림을 처리하는 층

즉 실제 흐름은 아래와 같다.

`텔레그램 메시지`
-> `제이 인텐트 파싱`
-> `register_reservation 명령 생성`
-> `스카 커맨더`
-> `자연어 예약 파싱`
-> `pickko-register.js`
-> `pickko-accurate.js`
-> `픽코 등록/결제`
-> `필요 시 네이버 차단`
-> `앤디/지미 알림`

---

## 1. 사용자 메시지 수신

### 1-1. 텔레그램 메시지 수신

파일:
- `/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.js`

역할:
- 제이가 텔레그램 메시지를 받는다.
- `msg.text`가 있으면 권한 체크 후 인텐트 파싱으로 보낸다.

중요 포인트:
- 단순 현재 메시지만 보지 않고, `buildReservationIntentText()`로 최근 대화를 합쳐 예약 초안을 만든다.
- 룸을 나중에 답해도 이전 이름/전화/날짜/시간과 합쳐질 수 있는 이유가 여기 있다.

관련 코드 흐름:
- `route(msg, sendReply)`
- `const preparedText = buildReservationIntentText(msg.chat?.id, msg.text);`
- `const parsed = await parseIntent(preparedText);`

---

## 2. 인텐트 파싱

### 2-1. 예약/등록 문장 감지

파일:
- `/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/intent-parser.js`

역할:
- 예약 관련 키워드를 보고 `register_reservation` 명령으로 라우팅한다.

현재 패턴:
- `예약해줘`
- `예약 등록`
- `등록해줘`
- `대리예약`
- `결제해줘`
- `N건 예약`

현재 특징:
- 예약 관련 의도는 `ska_action`
- 내부 command는 `register_reservation`
- 원문은 `raw_text`로 넘김

중요:
- 여기서는 아직 단건/다건/재시도 판정을 하지 않는다.
- 그 판단은 뒤쪽 `manual-reservation.js`에서 한다.

---

## 3. 제이 라우터에서 예약 원문 보존

### 3-1. register_reservation 원문 고정

파일:
- `/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.js`

역할:
- `register_reservation`으로 판정되면 `parsed.args.raw_text = preparedText`로 넣는다.

의미:
- 스카 실행층은 사용자가 실제로 말한 예약 문장을 최대한 그대로 받게 된다.
- 룸 보완, 다건, `재등록(=재시도)` 같은 문구 판정이 이 원문에 의존한다.

---

## 4. bot_commands 큐 삽입

### 4-1. 큐 생성

파일:
- `/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/enqueue-ska-reservation.js`

역할:
- 예약 원문을 검사한 뒤 `claude.bot_commands`에 `register_reservation`을 insert 한다.

저장되는 주요 값:
- `command: register_reservation`
- `raw_text`
- `reservation` 또는 `reservations`
- `batch`

주의:
- 여기서 `parseReservationCommand()`를 한 번 돌린다.
- 따라서 이 단계에서 이미 단건/다건이 어느 정도 정해진다.

---

## 5. 스카 커맨더 실행

### 5-1. 스카 명령 분배

파일:
- `/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/ska-command-handlers.js`

역할:
- 읽기 명령은 n8n fallback을 탈 수 있지만,
- `register_reservation`은 직접 `runManualReservationRegistration(args)`를 호출한다.

의미:
- 예약 등록은 단순 webhook acceptance가 아니라,
- 실제 픽코 실행 결과를 받도록 설계되어 있다.

---

## 6. 자연어 예약 파싱

### 6-1. 전체 진입점

파일:
- `/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/manual-reservation.js`

중심 함수:
- `runManualReservationRegistration(args)`

역할:
- 예약 원문을 분석해서
  - 단건인지
  - 다건인지
  - 재시도인지
를 판단한다.

### 6-2. 날짜 파싱

사용 함수:
- `parseDateFromText(text)`

지원:
- `오늘`
- `내일`
- `모레`
- `2026-03-28`
- `3월 28일`

### 6-3. 시간 파싱

사용 함수:
- `parseTimeRangeFromText(text)`
- `parseTimeToken(token)`

지원:
- `09:00-10:30`
- `09:00~10:30`
- `오전 9시~오전 10시 30분`
- `오후 3시~5시`

### 6-4. 룸 파싱

사용 함수:
- `parseRoomFromText(text)`

지원:
- `A1`
- `A2`
- `B`
- `A1룸`

### 6-5. 이름/전화 파싱

사용 함수:
- `parseSharedName(text)`
- `parseNameFromText(text)`
- `transformPhoneNumber(...)`

역할:
- 전화번호는 정규화
- 이름은 전화번호 앞 구간을 우선 사용

### 6-6. 단건/다건 판정

사용 함수:
- `extractBatchReservations(args)`
- `parseBatchCount(text, explicitCount)`
- `parseReservationCommand(args)`

동작:
- 줄바꿈 기준으로 예약 2건 이상 추출되면 다건
- 또는 한 문장 안에 `날짜 + 시간 + 룸` 패턴이 여러 번 나오면 다건
- 아니면 단건

### 6-7. 재시도 판정

사용 함수:
- `isRetryRegistrationRequest(args)`

현재 키워드 예시:
- `다시 등록`
- `재등록`
- `다시 해봐`
- `반영이 안`
- `실패했어`

현재 의미:
- 사용자가 `재등록`이라고 말해도 내부 의미는 `재시도`로 해석한다.
- 재시도로 판단되면 뒤에서 `manualRetry` 옵션을 킨다.

### 6-8. 실행 분기

단건:
- `runSingleReservationRegistration(reservation, options)`

다건:
- 예약별로 `runSingleReservationRegistration()` 순차 실행
- 결과를 모아서 `successCount`, `failureCount`, `summary` 반환

---

## 7. pickko-register.js 래퍼

파일:
- `/Users/alexlee/projects/ai-agent-system/bots/reservation/manual/reservation/pickko-register.js`

역할:
- 실제 픽코 자동화 스크립트 `pickko-accurate.js`를 감싸는 래퍼
- 입력 검증
- 실행 후 DB 반영
- 필요 시 네이버 차단 spawn

### 7-1. 입력 검증

검증:
- `date`
- `start`
- `end`
- `room`
- `phone`

정규화:
- `transformAndNormalizeData()`

### 7-2. 재시도 옵션 처리

현재 옵션:
- `--manual-retry`
- `--skip-name-sync`
- `--skip-naver-block`

현재 규칙:
- 재시도면 자동으로 세 옵션을 같이 켠다.

### 7-3. pickko-accurate.js 실행

실행 값:
- `--phone`
- `--date`
- `--start`
- `--end`
- `--room`
- `--name`

환경변수:
- `MODE`
- `SKIP_NAME_SYNC`
- `MANUAL_RETRY`

### 7-4. 성공 후 처리

성공 코드:
- `0`: 정상 등록
- `2`: 시간 경과로 등록 생략

DB 기록:
- `status: completed`
- `pickkoStatus: manual` 또는 `time_elapsed`
- `markSeen()`

### 7-5. 네이버 차단 실행

현재 규칙:
- `code === 0` 이고
- `SKIP_NAVER_BLOCK === false`
일 때만 `pickko-kiosk-monitor.js --block-slot` spawn

즉:
- 일반 신규 등록은 네이버 차단 시도
- 재시도는 네이버 차단 생략

---

## 8. pickko-accurate.js 실제 자동화

파일:
- `/Users/alexlee/projects/ai-agent-system/bots/reservation/manual/reservation/pickko-accurate.js`

역할:
- 픽코 관리자 페이지를 직접 조작해 예약 등록/결제를 수행

### 8-1. 1단계 로그인

동작:
- 픽코 로그인
- 락 획득

### 8-2. 2단계 예약 페이지 이동

URL:
- `https://pickkoadmin.com/study/write.html`

### 8-3. 3단계 회원 검색

동작:
- 전화번호로 검색

### 8-4. 4단계 회원 선택 / 신규회원 등록 분기

핵심:
- 검색 결과에 회원이 없으면 신규회원 등록
- 있으면 회원 선택
- 전화번호 검증까지 수행

현재 로직:
1. 모달 열기
2. `a.mb_select` 존재 여부 확인
3. 없으면 `registerNewMember()`
4. 등록 후 다시 검색
5. 있으면 선택
6. 선택된 회원의 전화번호가 입력 전화번호와 같은지 검증

### 8-5. 4.5단계 기존회원 이름 비교

현재 규칙:
- 자동 수정하지 않음
- `ENABLE_NAME_SYNC=1`이 아닌 한 기본 생략
- 이름이 다르면 `andy`에 알림만 보냄
- 알림에는 `전화번호 + 픽코 이름 + 네이버 이름`을 함께 넣음

현재 실제 목적:
- 기존회원 판별 이후에만 수행
- 이름 불일치는 운영 이슈로만 남김
- 예약 로직이 고객 회원정보를 자동 변경하지 않음

### 8-6. 5단계 날짜 설정

동작:
- 예약일자 필드 직접 세팅
- datepicker show
- 목표 날짜 클릭
- 최종 검증

### 8-7. 6단계 룸/시간 슬롯 선택

동작:
- 30분 단위 슬롯 변환
- 해당 룸의 시간대 슬롯 선택

### 8-8. 7단계 저장

동작:
- 예약 저장

### 8-9. 8단계 결제

동작:
- 현금 0원 처리 또는 운영 규칙에 맞는 결제

### 8-10. 9단계 완료

동작:
- URL/화면 기준으로 성공 판정

### 8-11. 9단계 완료 후 검증

검증 목적:
- 픽코에 실제 예약이 원하는 값으로 생성됐는지 확인

검증 포인트:
- 고객 전화번호가 맞는지
- 날짜가 맞는지
- 룸이 맞는지
- 요청 시간대가 픽코 규칙상 허용 범위로 반영됐는지
- 결제 상태가 기대와 맞는지

주의:
- 픽코는 실제 점유 시간과 화면 표기 시간이 다를 수 있다.
- 따라서 요청 시간과 픽코 표기를 단순 문자열로 1:1 비교하면 안 된다.

---

## 9. 앤디(naver-monitor) 쪽 절차

파일:
- `/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/naver-monitor.js`

역할:
- 네이버 예약 현황을 보며
  - 신규 예약 감지
  - 픽코 등록 시도
  - 실패 알림
  - 재시도 횟수 관리
를 수행

### 9-1. 네이버 예약 감지

감지 후:
- 예약 정보를 `reservations` DB에 저장
- 상태를 `pending` 또는 `processing`으로 둠

### 9-2. runPickko()

핵심 함수:
- `runPickko(booking, bookingId, naverPage)`

동작:
1. 입력 정규화
2. 최대 재시도 초과 확인
3. `pickko-accurate.js` 실행
4. 종료코드에 따라 성공/실패 처리
5. 알림 발송

### 9-3. 최대 재시도 초과

현재 로직:
- `retries >= MAX_RETRIES`면
- `⛔ 픽코 등록 포기 — 최대 재시도 초과!` 알림

최근 보정:
- 이미 `completed` 또는 `pickkoStatus`가 `manual/verified/time_elapsed`면
- 이 실패 알림을 보내지 않고 `seen 처리` 후 종료

### 9-4. 앤디 완료 후 검증

검증 목적:
- 앤디가 실제 완료된 예약을 실패/재시도 대상으로 잘못 보지 않는지 확인

검증 포인트:
- 픽코 완료 상태와 앤디가 보는 예약 키가 같은지
- retries 값이 실제 상태와 맞는지
- `최대 재시도 초과`가 실제 미완료 예약에만 가는지
- 수동 완료 또는 수동 재시도 완료 예약을 다시 실패로 보지 않는지

---

## 10. 지미(pickko-kiosk-monitor) 쪽 절차

파일:
- `/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/pickko-kiosk-monitor.js`

역할:
- 네이버 예약불가 차단/해제
- 차단 결과 검증
- 지미 알림 발송

### 10-1. block-slot 단독 모드

호출 주체:
- `pickko-register.js`

조건:
- 일반 신규 등록 성공 시
- 재등록은 제외

### 10-2. 동작

1. 네이버 로그인
2. 예약 페이지 진입
3. 날짜 선택
4. 룸/시간 슬롯 찾기
5. `예약불가` 설정
6. 검증

### 10-3. 결과 알림

성공:
- `✅ [대리등록] 네이버 예약불가 처리 완료`

불확실:
- `⚠️ [대리등록] 네이버 차단 검증 불확실 — 화면 확인 권장`

실패:
- `⚠️ [대리등록] 네이버 예약불가 처리 실패 — 수동 확인 필요`

### 10-4. 지미 완료 후 검증

현재 존재:
- 지미는 이미 별도 검증 절차를 가진다.

검증 포인트:
- 요청 시간대 전 구간이 `예약불가`인지
- 연속 블록도 정상 인식하는지
- 검증 불확실과 실제 실패를 구분하는지

---

## 11. 현재 고정 규칙

1. 예약 경로는 기존회원 정보를 자동 수정하지 않는다.
2. 이름 불일치 시 알림만 남긴다.
3. 이름 불일치 알림에는 전화번호, 픽코 이름, 네이버 이름을 함께 보낸다.
4. 회원정보 수정은 마스터가 수동으로 한다.
5. 사용자가 `재등록`이라고 말해도 내부 의미는 `재시도`로 해석한다.
6. 재시도 경로에서는 네이버 차단을 자동으로 하지 않는다.
7. 재시도 경로에서는 이름 동기화를 하지 않는다.

---

## 12. 시간 규칙

### 12-1. 네이버 시간 규칙

네이버의 12시는 3가지로 구분한다.

1. `오전 12:00`
- 내부 의미: `00:00`
- 예: `00:00 - 02:00`
- 실제 네이버 선택: `오전 12:00 | 오전 02:00`

2. `오후 12:00`
- 내부 의미: `12:00`
- 예: `12:00 - 14:00`
- 실제 네이버 선택: `오후 12:00 | 오후 02:00`

3. `자정 12:00`
- 내부 의미: `24:00`
- 예: `22:00 - 24:00`
- 실제 네이버 선택: `오후 10:00 | 자정 12:00`

주의:
- 시간 계산상 `00:00`와 `24:00`가 비슷해 보여도 네이버 UI에서는 같은 의미로 합치면 안 된다.

### 12-2. 픽코 시간 규칙

픽코 관리자 시간은 `00:00 - 24:00` 기준으로 본다.

규칙:
1. 슬롯은 25분 단위이고, 사이 5분은 비어 있다.
- 예: `01:00-01:25`
- 다음 슬롯: `01:30-01:55`

2. 표기는 20분 단위이고, 10분은 생략된다.
- 예: `01:00-01:20`

주의:
- 픽코는 실제 점유 시간과 화면 표기 시간이 다를 수 있다.

---

## 13. 현재 의심 지점

### A. 예약 ID 체계 불일치

수동 등록 키와 앤디가 보는 예약 키가 다를 가능성이 있다.

영향:
- 실제 등록 성공과 앤디 재시도 로직이 서로 다른 예약으로 인식될 수 있음

### B. pickko-register.js 비동기 DB 반영

`getReservation`, `addReservation`, `updateReservation`, `markSeen`가 async인데 래퍼에서 보장되지 않는 구간이 있다.

영향:
- 실제 성공 후 DB 상태가 늦게 반영돼 앨림이 꼬일 수 있음

### C. 재시도 판정이 문구 의존

지금은 `다시 등록`, `재등록` 같은 말에 의존한다.

영향:
- 제이가 표현을 바꾸면 신규 등록으로 갈 수 있음

### D. 회원 조회 단계 중복

4.5단계 이름 확인용 조회와 4단계 실제 선택 조회가 나뉘어 있다.

영향:
- 구조 이해가 어렵고, 디버깅 포인트가 늘어남

---

## 14. 코멘트용 영역

이 문서에 직접 아래처럼 표시하면서 검토 가능

- `여기 로직 이상함`
- `이 단계는 필요 없음`
- `여기서 DB 상태 더 확인해야 함`
- `이 자동화는 수동으로 바꾸자`
- `이 알림은 다른 봇으로 보내자`
