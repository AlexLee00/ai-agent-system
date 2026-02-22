# 📋 예약 시스템 데이터 정규식 변환 규칙

**모든 스크립트에서 따라야 하는 정규식 기반 변환 규칙**

---

## 🎯 원칙 (3단계)

1. **추출한 데이터를 정규식으로 변환한다** (저장 형식으로 정규화)
2. **변환에 실패한 데이터는 버린다** (NULL 처리)
3. **사용할 때는 저장된 데이터를 사용처에 맞게 변환한다** (포맷 변환)
4. **공유 라이브러리를 사용한다** (`lib/validation.js`)

---

## 📝 필드별 정규식 변환 규칙

### 1️⃣ 전화번호 (필수)
| 속성 | 값 |
|------|-----|
| **정규식** | `^\d{11}$` |
| **설명** | 숫자만 11자리로 변환 (하이픈 제거) |
| **입력** | `010-3500-0586` |
| **출력** | `01035000586` ✅ |
| **실패 시** | null (데이터 버림) |
| **함수** | `transformPhoneNumber(phone)` |

```javascript
// 변환 전 (다양한 형식)
"010-3500-0586"   // 하이픈 포함
"01035000586"     // 이미 정규형식
"010 3500 0586"   // 공백 포함

// 변환 후 (통일된 형식)
"01035000586"     // 숫자만 11자리
```

---

### 2️⃣ 날짜 (필수)
| 속성 | 값 |
|------|-----|
| **정규식** | `^\d{4}-\d{2}-\d{2}$` |
| **형식** | YYYY-MM-DD (ISO 8601) |
| **예시** | `2026-02-23` ✅ / `02-23-2026` ❌ |
| **오류 시** | 데이터 버림 (필수 필드) |
| **함수** | `validateDate(date)` |

```javascript
// ❌ 잘못된 예
"02-23-2026"      // MM-DD-YYYY 형식
"2026/02/23"      // 슬래시 사용
"26. 2. 23"       // 파싱된 네이버 형식

// ✅ 올바른 예
"2026-02-23"      // YYYY-MM-DD
```

---

### 3️⃣ 시작시간 (필수)
| 속성 | 값 |
|------|-----|
| **정규식** | `^\d{2}:\d{2}$` + 범위 체크 |
| **범위** | 00:00 ~ 23:59 (24시간) |
| **예시** | `17:00` ✅ / `5:00` ❌ |
| **오류 시** | 데이터 버림 (필수 필드) |
| **함수** | `validateTime(time, '시작시간')` |

```javascript
// ❌ 잘못된 예
"5:00"            // HH:MM이 아님 (H:MM)
"17:60"           // 분 범위 오류 (59까지만)
"오후 5:00"        // AM/PM 포함
"17:00~19:00"     // 시간 범위 포함

// ✅ 올바른 예
"17:00"           // HH:MM 형식
"00:00"           // 자정
"23:59"           // 거의 자정
```

---

### 4️⃣ 종료시간 (필수)
| 속성 | 값 |
|------|-----|
| **정규식** | `^\d{2}:\d{2}$` + 범위 체크 |
| **범위** | 00:00 ~ 23:59 (24시간) |
| **예시** | `19:00` ✅ / `5:00` ❌ |
| **오류 시** | 데이터 버림 (필수 필드) |
| **함수** | `validateTime(time, '종료시간')` |
| **추가** | `validateTimeRange(start, end)` |

```javascript
// ❌ 잘못된 예
"5:00"            // HH:MM 아님
"23:61"           // 분 범위 오류
"17:00~19:00"     // 범위 포함

// ✅ 올바른 예
"19:00"           // HH:MM 형식
"23:59"           // 자정 전
"00:30"           // 자정 후 (자정 넘어가는 예약 가능)
```

---

### 5️⃣ 스터디룸 (필수)
| 속성 | 값 |
|------|-----|
| **정규식** | `^[A-Z]\d*$` 또는 `^[A-Z]$` |
| **설명** | 영문 대문자 + 숫자 (대문자 정규화) |
| **예시** | `A1`, `A2`, `B` ✅ / `a1` ❌ |
| **오류 시** | 데이터 버림 (필수 필드) |
| **함수** | `validateRoom(room)` |

```javascript
// ❌ 잘못된 예
"a1"              // 소문자
"room_a1"         // 접두사 포함
"A1/A2"           // 범위 포함

// ✅ 올바른 예
"A1"              // 대문자 정규화
"A2"
"B"
"A"               // 숫자 없어도 가능
```

---

### 6️⃣ BookingID (선택)
| 속성 | 값 |
|------|-----|
| **정규식** | `^\d+$` |
| **설명** | 숫자만 (네이버 예약 ID) |
| **예시** | `1164673607` ✅ / `BK-123` ❌ |
| **오류 시** | 무시 (선택 필드) |
| **함수** | `validateBookingId(bookingId)` |

```javascript
// ❌ 잘못된 예 (경고만, 버리지 않음)
"BK-1164673607"   // 접두사 포함
"booking_123"     // 문자 포함

// ✅ 올바른 예
"1164673607"      // 숫자만
```

---

## 🔄 적용 워크플로우

### 단계 1: 파싱 (naver-monitor.js)
```javascript
const raw = scrapeNewestBookingsFromList(page); // 네이버에서 파싱
// raw = { phone: "010-5162-5243", date: "26. 2. 23", start: "오후 5:00", ... }
```

### 단계 2: 정규화 및 검증 (저장 전)
```javascript
const { validateAndNormalizeData } = require('./lib/validation');

const normalized = validateAndNormalizeData(raw);
// 반환: { phone: "01051625243", date: "2026-02-23", start: "17:00", ... }
// 또는 null (검증 실패 시)
```

### 단계 3: 필터링 (저장)
```javascript
const candidates = newest
  .map(b => validateAndNormalizeData(b))  // ✅ 검증
  .filter(Boolean)                         // null 제거
  .map(b => ({ ...b, _key: toKey(b) }))
  .filter(b => !seenSet.has(b._key));     // 중복 제거
```

### 단계 4: 최종 검증 (픽코 호출 직전)
```javascript
function runPickko(booking) {
  const validated = validateAndNormalizeData(booking); // ✅ 재검증
  if (!validated) return resolve(1); // 실패 시 중단
  
  // 픽코 호출
  const args = [
    `--phone=${validated.phone}`,
    `--date=${validated.date}`,
    `--start=${validated.start}`,
    `--end=${validated.end}`,
    `--room=${validated.room}`
  ];
  spawn('node', ['pickko-accurate.js', ...args]);
}
```

---

## 📊 검증 오류 처리

### 필수 필드 (NULL 반환)
- 전화번호
- 날짜
- 시작시간
- 종료시간
- 스터디룸

→ **오류 시 데이터 버림**

```javascript
const validated = validateAndNormalizeData(data);
if (!validated) {
  log(`⚠️ 데이터 검증 실패(버림): ${JSON.stringify(data)}`);
  continue; // 다음 데이터 처리
}
```

### 선택 필드 (NULL 허용)
- BookingID
- raw (원본 데이터)

→ **오류 시 무시하고 진행**

---

## 🛠️ 사용 예시

### naver-monitor.js
```javascript
const { validateAndNormalizeData } = require('./lib/validation');

const candidates = newest
  .map(b => validateAndNormalizeData(b, { log }))
  .filter(Boolean)
  .map(b => ({ ...b, _key: toKey(b) }))
  .filter(b => !seenSet.has(b._key));
```

### pickko-accurate.js
```javascript
const { validateAndNormalizeData, validateTimeRange } = require('./lib/validation');

// 입력 검증
const validated = validateAndNormalizeData({
  phone: PHONE_NOHYPHEN,
  date: DATE,
  start: START_TIME,
  end: END_TIME,
  room: ROOM
});

if (!validated) throw new Error('입력 데이터 검증 실패');

// 시간 범위 검증
const timeRangeCheck = validateTimeRange(START_TIME, END_TIME);
if (!timeRangeCheck.ok) throw new Error(timeRangeCheck.error);

log(`✅ 데이터 검증 통과: ${JSON.stringify(validated)}`);
```

---

## 📌 규칙 요약

| 필드 | 정규식 | 필수 | 오류 시 |
|------|-------|------|--------|
| 전화번호 | `^\d{11}$` | ✅ | 버림 |
| 날짜 | `^\d{4}-\d{2}-\d{2}$` | ✅ | 버림 |
| 시작시간 | `^\d{2}:\d{2}$` + 범위 | ✅ | 버림 |
| 종료시간 | `^\d{2}:\d{2}$` + 범위 | ✅ | 버림 |
| 스터디룸 | `^[A-Z]\d*$` | ✅ | 버림 |
| BookingID | `^\d+$` | ❌ | 무시 |

---

---

## 🔄 포맷 변환 (정규화 데이터 → 사용처 맞춤)

### 원칙
```
추출 → 검증/정규화 → 저장 → 사용할 때 포맷 변환
```

**저장 형식 (정규화):**
- 전화번호: `01035000586` (숫자만)
- 날짜: `2026-02-23` (YYYY-MM-DD)
- 시간: `17:00` (HH:MM, 24시간)
- 룸: `A2` (대문자)

**사용 시 변환 함수:**

### 1️⃣ 전화번호 포맷
```javascript
const { formatPhoneNumber } = require('./lib/validation');

const stored = '01035000586';        // 저장 형식 (정규화)
const display = formatPhoneNumber(stored);  // 디스플레이: 010-3500-0586
const raw = stored;                  // 픽코 호출: 01035000586
```

### 2️⃣ 날짜 포맷
```javascript
const { formatDate } = require('./lib/validation');

const stored = '2026-02-23';         // 저장 형식

// 다양한 포맷으로 변환
formatDate(stored, 'YYYY-MM-DD');    // 2026-02-23 (기본)
formatDate(stored, 'YYYY/MM/DD');    // 2026/02/23
formatDate(stored, 'YY.M.D');        // 26.2.23 (네이버 형식)
formatDate(stored, 'YYYY년MM월DD일'); // 2026년2월23일
```

### 3️⃣ 시간 포맷
```javascript
const { formatTime } = require('./lib/validation');

const stored = '17:00';              // 저장 형식

// 다양한 포맷으로 변환
formatTime(stored, 'HH:MM');         // 17:00 (기본)
formatTime(stored, '오전/오후 H:MM'); // 오후 5:00 (네이버 형식)
```

### 4️⃣ 스터디룸 포맷
```javascript
const { formatRoom } = require('./lib/validation');

const stored = 'A2';                 // 저장 형식

// 다양한 포맷으로 변환
formatRoom(stored, 'CODE');          // A2 (기본)
formatRoom(stored, 'DESCRIPTION');   // A2룸
formatRoom(stored, 'FULL');          // A2룸 (2인 최적, 최대 4인)
```

### 5️⃣ 통합 포맷 변환
```javascript
const { validateAndNormalizeData, formatDataForUsage } = require('./lib/validation');

// 1단계: 데이터 검증/정규화 (저장)
const validated = validateAndNormalizeData(rawData);
saveToDatabase(validated);
// DB에 저장: { phone: '01035000586', date: '2026-02-23', ... }

// 2단계: 데이터 사용 시 포맷 변환
const formatted = formatDataForUsage(validated, {
  phoneFormat: 'DISPLAY',        // 010-3500-0586
  dateFormat: 'YY.M.D',          // 26.2.23
  timeFormat: '오전/오후 H:MM',   // 오후 5:00
  roomFormat: 'DESCRIPTION'      // A2룸
});

// 사용
log(`${formatted.phone}님이 ${formatted.date} ${formatted.start}~${formatted.end} ${formatted.room} 예약`);
// → 010-3500-0586님이 26.2.23 오후 5:00~오후 7:00 A2룸 예약
```

---

## 📊 데이터 플로우

```
┌─────────────────────────────────────────────────────────┐
│ 1️⃣ 추출 (Extract)                                       │
│ 네이버: 010-5162-5243 / 26. 2. 23 / 오후 5:00~7:00 / A2 │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│ 2️⃣ 검증/정규화 (Validate & Normalize)                   │
│ validateAndNormalizeData() 호출                          │
│ ✓ 형식 검증 (정규식)                                    │
│ ✓ 정규화 (표준 형식)                                    │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
     ┌──────────────────────────────────┐
     │ 데이터베이스 저장 (표준 형식)     │
     │ {                                │
     │   phone: '01051625243',          │
     │   date: '2026-02-23',            │
     │   start: '17:00',                │
     │   end: '19:00',                  │
     │   room: 'A2'                     │
     │ }                                │
     └──────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│ 3️⃣ 포맷 변환 (Format for Usage)                         │
│ formatDataForUsage() 호출                               │
│ ✓ 디스플레이용 포맷 (010-5162-5243)                    │
│ ✓ 네이버용 포맷 (26. 2. 23 / 오후 5:00)                │
│ ✓ 픽코용 포맷 (01051625243 / 17:00)                    │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│ 4️⃣ 사용 (Use in Different Systems)                     │
│ ├─ 로그: 010-5162-5243님의 예약                         │
│ ├─ 픽코: --phone=01051625243 --start=17:00             │
│ └─ 문자: 26.2.23(월) 오후 5:00~7:00 A2룸              │
└─────────────────────────────────────────────────────────┘
```

---

## ✅ 체크리스트

**새로운 스크립트를 만들 때:**
- [ ] `lib/validation.js` import
- [ ] 데이터 파싱 후 `validateAndNormalizeData()` 호출
- [ ] null 체크 및 필터링
- [ ] 데이터베이스 저장 (정규화 형식)
- [ ] 사용할 때 `formatDataForUsage()` 또는 개별 format 함수 사용
- [ ] 검증 오류 로깅

**기존 스크립트 업그레이드:**
- [ ] `lib/validation.js` 도입
- [ ] 저장 전 검증 추가
- [ ] 사용 시 포맷 변환 추가
- [ ] 픽코 호출 전 재검증 추가
- [ ] 로그 정보 개선
