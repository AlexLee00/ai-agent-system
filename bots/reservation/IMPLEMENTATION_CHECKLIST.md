# ✅ 정규식 검증 규칙 적용 체크리스트

**모든 스크립트가 VALIDATION_RULES.md를 따르도록 하기 위한 체크리스트**

---

## 📋 적용 현황

### ✅ naver-monitor.js
- [x] `lib/validation.js` import
- [x] `validateAndNormalizeData()` 사용
- [x] 저장 전 검증 추가
- [x] 픽코 호출 전 재검증 추가
- [x] 검증 오류 로깅
- [x] 기존 validateAndNormalizeData 함수 제거 (라이브러리로 통합)

### ✅ pickko-accurate.js
- [x] `lib/validation.js` import (`validateAndNormalizeData`, `validateTimeRange`)
- [x] 입력 데이터 검증 추가
- [x] 시간 범위 검증 추가
- [x] DEV 모드 화이트리스트 검증
- [x] 기존 validateTime 함수 제거 (라이브러리로 통합)
- [x] 로그 정보 개선
- [x] `lib/utils`, `lib/secrets`, `lib/args`, `lib/browser`, `lib/pickko` 공통 라이브러리 적용

### ✅ pickko-cancel.js
- [x] `lib/utils` → delay, log
- [x] `lib/secrets` → loadSecrets()
- [x] `lib/args` → parseArgs()
- [x] `lib/formatting` → formatPhone, toKoreanTime, pickkoEndTime
- [x] `lib/browser` → getPickkoLaunchOptions, setupDialogHandler
- [x] `lib/pickko` → loginToPickko()
- [x] DEV 모드 화이트리스트 검증

### ✅ pickko-verify.js
- [x] `lib/utils` → delay, log
- [x] `lib/secrets` → loadSecrets()
- [x] `lib/formatting` → toKoreanTime, pickkoEndTime, formatPhone
- [x] `lib/files` → loadJson, saveJson
- [x] `lib/browser` → getPickkoLaunchOptions, setupDialogHandler
- [x] `lib/pickko` → loginToPickko()
- [x] --dry-run 모드 지원

---

## 📝 새로운 스크립트 작성 가이드

**새 스크립트를 만들 때 반드시 따를 규칙:**

### 1. Import
```javascript
const { 
  validateAndNormalizeData, 
  formatDataForUsage,
  formatPhoneNumber,
  formatTime
} = require('../lib/validation');
```

### 2. 데이터 파싱
```javascript
const raw = parseDataFromSomewhere();
// raw = { phone: "010-5162-5243", date: "26. 2. 23", start: "오후 5:00", ... }
```

### 3. 검증 & 정규화
```javascript
const validated = validateAndNormalizeData(raw, { log });
if (!validated) {
  log('검증 실패: 데이터 버림');
  continue; // 또는 return
}
// validated = { phone: '01051625243', date: '2026-02-23', start: '17:00', ... }
```

### 4. 저장 (데이터베이스/파일) - 정규화 형식 그대로
```javascript
saveToDatabase({
  phone: validated.phone,        // 01051625243
  date: validated.date,          // 2026-02-23
  start: validated.start,        // 17:00
  end: validated.end,            // 19:00
  room: validated.room           // A2
});
```

### 5. 사용할 때 - 포맷 변환
```javascript
// 저장된 데이터 조회
const stored = loadFromDatabase();

// Option A: 통합 포맷 변환
const formatted = formatDataForUsage(stored, {
  phoneFormat: 'DISPLAY',        // 010-5162-5243
  dateFormat: 'YY.M.D',          // 26.2.23
  timeFormat: '오전/오후 H:MM',   // 오후 5:00
  roomFormat: 'DESCRIPTION'      // A2룸
});
log(`${formatted.phone}님이 ${formatted.start}~${formatted.end} ${formatted.room} 예약`);

// Option B: 개별 포맷 변환
const phoneDisplay = formatPhoneNumber(stored.phone);
const timeDisplay = formatTime(stored.start, '오전/오후 H:MM');
log(`${phoneDisplay}님이 ${timeDisplay} 예약`);

// Option C: 픽코 호출 (정규형식 그대로)
spawnPickko({
  phone: stored.phone,           // 01051625243 (정규형식)
  date: stored.date,             // 2026-02-23
  start: stored.start,           // 17:00
  end: stored.end,               // 19:00
  room: stored.room              // A2
});
```

---

## 🔍 검증 & 포맷 규칙 요약

| 단계 | 함수 | 입출력 | 목적 |
|------|------|--------|------|
| 1️⃣ 파싱 | - | `"010-5162-5243"` | 소스에서 데이터 추출 |
| 2️⃣ 검증 | `validateAndNormalizeData()` | `"01051625243"` | 형식/범위 검증 |
| 3️⃣ 필터링 | `.filter(Boolean)` | 유효 데이터만 | null 제거 |
| 4️⃣ 저장 | `saveToDatabase()` | `"01051625243"` | 정규화 형식 저장 |
| 5️⃣ 호출 전 재검증 | `validateAndNormalizeData()` | `"01051625243"` | 안전장치 |
| 6️⃣ 사용 시 변환 | `formatPhoneNumber()` | `"010-5162-5243"` | 사용처 맞춤 포맷 |

---

## 📚 관련 문서

- **VALIDATION_RULES.md** - 필드별 검증 규칙 상세
- **lib/validation.js** - 검증 함수 구현
- **TOOLS.md** - 검증 함수 사용 예제

---

## 🚀 기존 스크립트 마이그레이션

**lib/validation.js 도입 전후:**

### Before (검증 없음, 포맷 혼합)
```javascript
// 저장
const candidates = newest
  .filter(b => b.phone && b.date && b.start && b.end && b.room);
// ⚠️ 형식 검증 없음, 포맷 일관성 없음 (010-3500-0586 vs 01035000586 섞임)

// 사용
log(`예약: ${candidate.phone} ${candidate.date} ${candidate.start}`);
// ⚠️ 포맷이 불일치할 수 있음
```

### After (검증 + 정규화 + 포맷 변환)
```javascript
// 저장
const candidates = newest
  .map(b => validateAndNormalizeData(b))  // ✅ 검증 & 정규화
  .filter(Boolean)                         // null 제거
  .map(b => ({ ...b, _key: toKey(b) }))
  .filter(b => !seenSet.has(b._key));     // 중복 제거
// ✅ 형식/범위 검증됨, 일관된 정규형식 저장

// 사용
const formatted = formatDataForUsage(candidate, {
  phoneFormat: 'DISPLAY',
  dateFormat: 'YY.M.D',
  timeFormat: '오전/오후 H:MM'
});
log(`예약: ${formatted.phone} ${formatted.date} ${formatted.start}`);
// ✅ 일관된 포맷으로 디스플레이

// 픽코 호출
spawnPickko({
  phone: candidate.phone,  // 정규형식 그대로 (01035000586)
  ...
});
```

---

## ✅ 규칙 위반 체크

**다음 패턴을 발견하면 규칙 위반:**

❌ **검증 없이 저장**
```javascript
const candidates = newest.filter(b => b.phone);
```

❌ **중복된 정규식**
```javascript
// naver-monitor.js와 pickko-accurate.js에서 각각 정의
const phoneMatch = String(phone).replace(/\D/g, '');
```

❌ **부분 검증만**
```javascript
if (phone && date) saveToDb(data); // room, start, end 검증 안 함
```

✅ **올바른 패턴**
```javascript
const validated = validateAndNormalizeData(data);
if (!validated) continue; // 전체 검증 통과 필요
```

---

## 📊 이점

1. **일관성** - 모든 스크립트가 동일한 규칙 적용
2. **유지보수** - 규칙 변경 시 한 곳만 수정
3. **안정성** - 형식 오류로 인한 크래시 방지
4. **추적성** - 검증 오류 로그로 문제 파악 용이
5. **확장성** - 새 필드 추가 시 라이브러리만 수정

---

## 🎯 체크리스트

**코드 리뷰 시:**

**검증 부분:**
- [ ] `lib/validation.js` import 확인?
- [ ] `validateAndNormalizeData()` 호출 확인?
- [ ] null 필터링 확인?
- [ ] 저장 전 검증 확인?
- [ ] 픽코 호출 전 재검증 확인?
- [ ] 검증 오류 로깅 확인?

**포맷 변환 부분:**
- [ ] 저장 시 정규화 형식 사용?
- [ ] 사용 시 `formatDataForUsage()` 또는 개별 format 함수 사용?
- [ ] 정규형식과 포맷된 형식 구분?
- [ ] 픽코 호출: 정규형식 그대로 사용?
- [ ] 디스플레이: 포맷된 형식 사용?
- [ ] 로그: 일관된 포맷 사용?

**배포 전:**
- [ ] VALIDATION_RULES.md 문서화 완료?
- [ ] IMPLEMENTATION_CHECKLIST.md 검토 완료?
- [ ] 모든 스크립트 테스트 완료?
- [ ] 포맷 변환 테스트 완료?
- [ ] 로그 수집 및 분석 가능?
- [ ] 화이트리스트 환경변수 설정?
