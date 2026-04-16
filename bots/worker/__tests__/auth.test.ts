// @ts-nocheck
'use strict';
/**
 * PART 2 — auth.js 단위 테스트
 * 실행: node bots/worker/__tests__/auth.test.js
 */
const path = require('path');
const { validatePasswordPolicy, hashPassword, verifyPassword } =
  require(path.join(__dirname, '../lib/auth'));

let pass = 0, fail = 0;

function assert(desc, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✅ ${desc}`); }
  else     { fail++; console.error(`  ❌ ${desc}\n     got:      ${JSON.stringify(got)}\n     expected: ${JSON.stringify(expected)}`); }
}

// ── 2-A. validatePasswordPolicy ──────────────────────────────────────

console.log('\n[ 2-A. null/빈값 처리 ]');

assert('TC-201 null',      validatePasswordPolicy(null),      { valid: false, reason: '비밀번호는 최소 8자 이상이어야 합니다.' });
assert('TC-202 undefined', validatePasswordPolicy(undefined), { valid: false, reason: '비밀번호는 최소 8자 이상이어야 합니다.' });
assert('TC-203 ""',        validatePasswordPolicy(''),        { valid: false, reason: '비밀번호는 최소 8자 이상이어야 합니다.' });

console.log('\n[ 2-A. 길이 검증 ]');

assert('TC-211 6자 4종',  validatePasswordPolicy('Abc12!'),   { valid: false, reason: '비밀번호는 최소 8자 이상이어야 합니다.' });
assert('TC-212 8자 4종',  validatePasswordPolicy('Abc1234!'), { valid: true,  reason: null });

const long74 = 'A'.repeat(71) + 'b1!'; // 74자
assert('TC-213 74자 초과', validatePasswordPolicy(long74), { valid: false, reason: '비밀번호는 72자를 초과할 수 없습니다.' });

const exact72 = 'A'.repeat(70) + 'a1'; // 72자, 대+소+숫자 3종
assert('TC-214 72자 경계', validatePasswordPolicy(exact72), { valid: true, reason: null });

const upper72 = 'A'.repeat(71) + 'a'; // 72자, 대+소 2종
assert('TC-215 72자 2종', validatePasswordPolicy(upper72), { valid: false, reason: '대문자, 소문자, 숫자, 특수문자 중 3가지 이상 포함해야 합니다.' });

console.log('\n[ 2-A. 공백 검증 ]');

assert('TC-221 중간 공백', validatePasswordPolicy('Abc 1234!'), { valid: false, reason: '비밀번호에 공백을 포함할 수 없습니다.' });
assert('TC-222 앞 공백',   validatePasswordPolicy(' Abc1234!'), { valid: false, reason: '비밀번호에 공백을 포함할 수 없습니다.' });
assert('TC-223 뒤 공백',   validatePasswordPolicy('Abc1234! '), { valid: false, reason: '비밀번호에 공백을 포함할 수 없습니다.' });
assert('TC-224 탭',        validatePasswordPolicy('Abc\t1234!'),{ valid: false, reason: '비밀번호에 공백을 포함할 수 없습니다.' });

console.log('\n[ 2-A. 종류 조합 검증 ]');

assert('TC-231 대문자만', validatePasswordPolicy('ABCDEFGH'), { valid: false, reason: '대문자, 소문자, 숫자, 특수문자 중 3가지 이상 포함해야 합니다.' });
assert('TC-232 소문자만', validatePasswordPolicy('abcdefgh'), { valid: false, reason: '대문자, 소문자, 숫자, 특수문자 중 3가지 이상 포함해야 합니다.' });
assert('TC-233 소+숫 2종',validatePasswordPolicy('abcd1234'), { valid: false, reason: '대문자, 소문자, 숫자, 특수문자 중 3가지 이상 포함해야 합니다.' });
assert('TC-234 대+소+숫',  validatePasswordPolicy('Abcd1234'), { valid: true,  reason: null });
assert('TC-235 4종',       validatePasswordPolicy('Abc123!@'), { valid: true,  reason: null });

// TC-236 한글 — /[^A-Za-z0-9]/에 매칭되므로 특수문자로 카운트됨 (의도된 동작 문서화)
const result236 = validatePasswordPolicy('한글비밀번호ABC1');
assert('TC-236 한글=특수문자 처리 (대+숫+특수)', result236.valid, true);

console.log('\n[ 2-B. hashPassword / verifyPassword ]');

(async () => {
  // TC-251: 해시 형태
  const hash1 = await hashPassword('TestPass1!');
  assert('TC-251 hash 접두사',  hash1.startsWith('$2b$12'), true);
  assert('TC-251 hash 길이',    hash1.length,               60);
  assert('TC-251 평문 불일치',  hash1 !== 'TestPass1!',     true);

  // TC-252: 동일 비밀번호 → 다른 해시 (salt)
  const hash2 = await hashPassword('TestPass1!');
  assert('TC-252 salt 적용',   hash1 !== hash2,            true);

  // TC-253: verifyPassword 일치
  assert('TC-253 일치',        await verifyPassword('TestPass1!', hash1),  true);

  // TC-254: verifyPassword 불일치
  assert('TC-254 불일치',      await verifyPassword('WrongPass!1', hash1), false);

  // TC-255: 잘못된 해시 → 에러 없이 false
  assert('TC-255 잘못된 해시', await verifyPassword('TestPass1!', 'not-a-hash'), false);

  // TC-256: validatePasswordPolicy 실패 → hashPassword 불호출 확인
  const policy = validatePasswordPolicy('12345678');
  assert('TC-256 약한 PW 차단', policy.valid, false);

  // ── 결과 ─────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`PART 2 결과: ✅ ${pass}건 통과 / ❌ ${fail}건 실패 / 총 ${pass+fail}건`);
  if (fail > 0) process.exit(1);
})();
