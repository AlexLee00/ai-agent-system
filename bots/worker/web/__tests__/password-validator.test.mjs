/**
 * PART 1 — password-validator.js 단위 테스트
 * 실행: node bots/worker/web/__tests__/password-validator.test.mjs
 */
import { validatePassword, getStrengthColor, getStrengthLabel }
  from '../lib/password-validator.js';

let pass = 0, fail = 0;

function assert(desc, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✅ ${desc}`); }
  else     { fail++; console.error(`  ❌ ${desc}\n     got:      ${JSON.stringify(got)}\n     expected: ${JSON.stringify(expected)}`); }
}

// ── 1-A. validatePassword ─────────────────────────────────────────────

console.log('\n[ 1-A. validatePassword — 정상 케이스 ]');

let r = validatePassword('Abcd1234');
assert('TC-101 isValid',       r.isValid,                    true);
assert('TC-101 categoryCount', r.categoryCount,              3);
assert('TC-101 strength',      r.strength,                   'strong');
assert('TC-101 minLength',     r.rules.minLength.passed,     true);
assert('TC-101 hasUppercase',  r.rules.hasUppercase.passed,  true);
assert('TC-101 hasLowercase',  r.rules.hasLowercase.passed,  true);
assert('TC-101 hasNumber',     r.rules.hasNumber.passed,     true);
assert('TC-101 hasSpecialChar',r.rules.hasSpecialChar.passed,false);

r = validatePassword('abc123!@');
assert('TC-102 isValid',       r.isValid,       true);
assert('TC-102 categoryCount', r.categoryCount, 3);
assert('TC-102 strength',      r.strength,      'strong');

r = validatePassword('ABC123!@');
assert('TC-103 isValid',       r.isValid,       true);
assert('TC-103 categoryCount', r.categoryCount, 3);

r = validatePassword('Abcdefg12345!');
assert('TC-104 isValid',       r.isValid,       true);
assert('TC-104 categoryCount', r.categoryCount, 4);
assert('TC-104 strength',      r.strength,      'very_strong');

r = validatePassword('Ab1!Ab1!Ab1!');
assert('TC-105 isValid',  r.isValid,  true);
assert('TC-105 strength', r.strength, 'very_strong');

r = validatePassword('Ab1!Ab1!Ab1');
assert('TC-106 isValid',  r.isValid,  true);
assert('TC-106 strength', r.strength, 'strong');

console.log('\n[ 1-A. validatePassword — 실패 케이스 ]');

r = validatePassword('');
assert('TC-111 isValid',   r.isValid,               false);
assert('TC-111 minLength', r.rules.minLength.passed, false);
assert('TC-111 strength',  r.strength,               'weak');

r = validatePassword(null);
assert('TC-112 null isValid', r.isValid, false);
r = validatePassword(undefined);
assert('TC-112 undefined isValid', r.isValid, false);

r = validatePassword('1234567');
assert('TC-113 isValid',   r.isValid,               false);
assert('TC-113 minLength', r.rules.minLength.passed, false);

r = validatePassword('12345678');
assert('TC-114 isValid',       r.isValid,       false);
assert('TC-114 categoryCount', r.categoryCount, 1);

r = validatePassword('abcd1234');
assert('TC-115 isValid',       r.isValid,       false);
assert('TC-115 categoryCount', r.categoryCount, 2);
assert('TC-115 strength',      r.strength,      'fair');

r = validatePassword('abcdefgh');
assert('TC-116 isValid',       r.isValid,       false);
assert('TC-116 categoryCount', r.categoryCount, 1);
assert('TC-116 strength',      r.strength,      'weak');

r = validatePassword('AB12');
assert('TC-117 isValid',  r.isValid,  false);
assert('TC-117 strength', r.strength, 'weak');

r = validatePassword('!@#$%^&*');
assert('TC-118 isValid',       r.isValid,       false);
assert('TC-118 categoryCount', r.categoryCount, 1);

// ── 1-A 추가: 공백/72자 (백엔드 일치 케이스)

console.log('\n[ 1-A. validatePassword — 공백/72자 (추가됨) ]');

r = validatePassword('Abc 1234!');
assert('TC-119 공백 isValid',      r.isValid,                    false);
assert('TC-119 noWhitespace',      r.rules.noWhitespace.passed,  false);

r = validatePassword('A'.repeat(71) + 'a1!'); // 74자
assert('TC-120 72자초과 isValid',  r.isValid,                    false);
assert('TC-120 minLength(72cap)',   r.rules.minLength.passed,     false);

r = validatePassword('A'.repeat(70) + 'a1'); // 72자, 3종
assert('TC-120b 72자 isValid',     r.isValid,                    true);

// ── 1-B. getStrengthColor / getStrengthLabel ─────────────────────────

console.log('\n[ 1-B. getStrengthColor ]');
assert('TC-121 weak',        getStrengthColor('weak'),        'bg-red-500');
assert('TC-122 fair',        getStrengthColor('fair'),        'bg-yellow-500');
assert('TC-123 strong',      getStrengthColor('strong'),      'bg-blue-500');
assert('TC-124 very_strong', getStrengthColor('very_strong'), 'bg-green-500');
assert('TC-125 fallback',    getStrengthColor('invalid'),     'bg-gray-200');

console.log('\n[ 1-B. getStrengthLabel ]');
assert('TC-131 weak',        getStrengthLabel('weak'),        '약함');
assert('TC-132 fair',        getStrengthLabel('fair'),        '보통');
assert('TC-133 strong',      getStrengthLabel('strong'),      '강함');
assert('TC-134 very_strong', getStrengthLabel('very_strong'), '매우 강함');
assert('TC-135 fallback',    getStrengthLabel('invalid'),     '');

// ── 1-C. 프론트/백 일치성 (프론트 기준만 검증, 불일치 문서화) ────────

console.log('\n[ 1-C. 프론트 규칙 (공백/72자 추가 후 백엔드 동일) ]');

const cases = [
  { pw: 'Abcd1234',  expected: true,  label: 'TC-141' },
  { pw: 'abcd1234',  expected: false, label: 'TC-142' },
  { pw: '12345678',  expected: false, label: 'TC-143' },
  { pw: 'Abc123!@',  expected: true,  label: 'TC-144' },
];
for (const c of cases) {
  const res = validatePassword(c.pw);
  assert(`${c.label} "${c.pw}" isValid`, res.isValid, c.expected);
}

// TC-145 공백 — 이제 프론트도 false (개선 완료)
r = validatePassword('Abc 1234!');
assert('TC-145 공백 이제 프론트도 false', r.isValid, false);

// ── 결과 ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`PART 1 결과: ✅ ${pass}건 통과 / ❌ ${fail}건 실패 / 총 ${pass+fail}건`);
if (fail > 0) process.exit(1);
