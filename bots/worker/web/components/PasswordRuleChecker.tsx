// @ts-nocheck
'use client';
import { validatePassword, getStrengthColor, getStrengthLabel } from '@/lib/password-validator';

const STRENGTH_WIDTH = {
  weak:        'w-1/4',
  fair:        'w-2/4',
  strong:      'w-3/4',
  very_strong: 'w-full',
};

export default function PasswordRuleChecker({ password }) {
  const isEmpty = !password;
  const { rules, strength, categoryCount } = validatePassword(password);

  return (
    <div className="mt-2 space-y-1.5">
      {/* 규칙 체크리스트 */}
      {Object.values(rules).map(rule => (
        <div key={rule.label} className="flex items-center gap-2 text-sm">
          {isEmpty ? (
            <span className="text-gray-300 text-xs">○</span>
          ) : rule.passed ? (
            <span className="text-green-500 text-xs font-bold">✓</span>
          ) : (
            <span className="text-red-400 text-xs font-bold">✗</span>
          )}
          <span className={
            isEmpty
              ? 'text-gray-400'
              : rule.passed ? 'text-gray-700' : 'text-gray-400'
          }>
            {rule.label}
          </span>
        </div>
      ))}

      {/* 강도 바 */}
      <div className="pt-1">
        <div className="h-1 w-full bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              isEmpty ? 'w-0' : STRENGTH_WIDTH[strength]
            } ${isEmpty ? '' : getStrengthColor(strength)}`}
          />
        </div>
        {!isEmpty && (
          <p className="text-xs text-gray-400 mt-1">
            강도: <span className="font-medium text-gray-600">{getStrengthLabel(strength)}</span>
          </p>
        )}
      </div>

      {/* 안내 문구 */}
      {!isEmpty && categoryCount < 3 && (
        <p className="text-xs text-gray-400">
          ⓘ 대문자, 소문자, 숫자, 특수문자 중 3가지 이상 포함 필요
        </p>
      )}
    </div>
  );
}
