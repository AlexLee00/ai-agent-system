'use strict';

/**
 * lib/vip.js — VIP 고객 인식 모듈
 *
 * reservations 테이블에서 phone 기준 completed 건수를 집계하여
 * VIP 등급을 반환한다.
 *
 * 등급:
 *   🥉 일반VIP : 3~6회
 *   🥈 실버    : 7~14회
 *   🥇 골드    : 15회↑
 */

const { getDb } = require('./db');

// ── 등급 기준 ──────────────────────────────────────────
const VIP_TIERS = [
  { min: 15, icon: '🥇', label: '골드' },
  { min:  7, icon: '🥈', label: '실버' },
  { min:  3, icon: '🥉', label: '일반VIP' },
];

/**
 * 전화번호로 VIP 정보 조회
 * @param {string} phone - 포맷된 전화번호 (예: "010-XXXX-XXXX")
 * @returns {{ isVip: boolean, tier: string|null, icon: string|null, count: number }}
 */
function getVipInfo(phone) {
  if (!phone) return { isVip: false, tier: null, icon: null, count: 0 };

  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM reservations
      WHERE phone = ?
        AND status IN ('completed', 'processing')
        AND seen_only = 0
    `).get(phone);

    const count = row?.cnt || 0;
    const tier = VIP_TIERS.find(t => count >= t.min) || null;

    return {
      isVip:  !!tier,
      tier:   tier?.label || null,
      icon:   tier?.icon  || null,
      count,
    };
  } catch (e) {
    return { isVip: false, tier: null, icon: null, count: 0 };
  }
}

/**
 * VIP 표시 문자열 반환
 * 예: " (VIP 🥈 실버 9회)" — VIP가 아니면 빈 문자열
 */
function formatVipBadge(phone) {
  const info = getVipInfo(phone);
  if (!info.isVip) return '';
  return ` (VIP ${info.icon} ${info.tier} ${info.count}회)`;
}

module.exports = { getVipInfo, formatVipBadge };
