const pgPool = require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'reservation';

type VipInfo = {
  isVip: boolean;
  tier: string | null;
  icon: string | null;
  count: number;
};

const VIP_TIERS = [
  { min: 15, icon: '🥇', label: '골드' },
  { min: 7, icon: '🥈', label: '실버' },
  { min: 3, icon: '🥉', label: '일반VIP' },
] as const;

async function getVipInfo(phone: string): Promise<VipInfo> {
  if (!phone) return { isVip: false, tier: null, icon: null, count: 0 };

  try {
    const normalizedPhone = String(phone).replace(/\D+/g, '');
    const row = await pgPool.get(
      SCHEMA,
      `
        SELECT COUNT(*)::int AS cnt
        FROM reservations
        WHERE regexp_replace(phone, '\\D', '', 'g') = $1
          AND status IN ('completed', 'processing')
          AND seen_only = 0
      `,
      [normalizedPhone],
    );

    const count = Number(row?.cnt || 0);
    const tier = VIP_TIERS.find((entry) => count >= entry.min) || null;

    return {
      isVip: !!tier,
      tier: tier?.label || null,
      icon: tier?.icon || null,
      count,
    };
  } catch (_error) {
    return { isVip: false, tier: null, icon: null, count: 0 };
  }
}

async function formatVipBadge(phone: string): Promise<string> {
  const info = await getVipInfo(phone);
  if (!info.isVip) return '';
  return ` (VIP ${info.icon} ${info.tier} ${info.count}회)`;
}

module.exports = { getVipInfo, formatVipBadge };
