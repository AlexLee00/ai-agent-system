/**
 * lib/password-validator.js — 프론트엔드 비밀번호 검증 유틸
 * 백엔드 bots/worker/lib/auth.js의 validatePasswordPolicy와 동일한 규칙 적용
 */

/**
 * 비밀번호 유효성 검사
 * @param {string} password
 * @returns {{ isValid: boolean, rules: object, categoryCount: number, strength: string }}
 */
export function validatePassword(password) {
  const str = password || '';

  const rules = {
    minLength:      { passed: str.length >= 8,              label: '8자 이상' },
    hasUppercase:   { passed: /[A-Z]/.test(str),            label: '대문자 포함' },
    hasLowercase:   { passed: /[a-z]/.test(str),            label: '소문자 포함' },
    hasNumber:      { passed: /[0-9]/.test(str),            label: '숫자 포함' },
    hasSpecialChar: { passed: /[^A-Za-z0-9]/.test(str),     label: '특수문자 포함' },
  };

  const categoryCount = [
    rules.hasUppercase.passed,
    rules.hasLowercase.passed,
    rules.hasNumber.passed,
    rules.hasSpecialChar.passed,
  ].filter(Boolean).length;

  const isValid = rules.minLength.passed && categoryCount >= 3;

  let strength;
  if (!rules.minLength.passed || categoryCount < 2) {
    strength = 'weak';
  } else if (categoryCount === 2) {
    strength = 'fair';
  } else if (categoryCount === 3) {
    strength = 'strong';
  } else {
    // categoryCount === 4
    strength = str.length >= 12 ? 'very_strong' : 'strong';
  }

  return { isValid, rules, categoryCount, strength };
}

/**
 * 강도별 색상 클래스
 */
export function getStrengthColor(strength) {
  return {
    weak:        'bg-red-500',
    fair:        'bg-yellow-500',
    strong:      'bg-blue-500',
    very_strong: 'bg-green-500',
  }[strength] || 'bg-gray-200';
}

/**
 * 강도별 한국어 라벨
 */
export function getStrengthLabel(strength) {
  return {
    weak:        '약함',
    fair:        '보통',
    strong:      '강함',
    very_strong: '매우 강함',
  }[strength] || '';
}
