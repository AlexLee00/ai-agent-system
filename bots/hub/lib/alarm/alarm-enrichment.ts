'use strict';

const pgPool = require('../../../../packages/core/lib/pg-pool');

function isEnabled(): boolean {
  const raw = String(process.env.HUB_ALARM_ENRICHMENT_ENABLED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

export interface AlarmEnrichment {
  clusterCount: number;
  recentTeamCount: number;
  firstSeenAt: string | null;
}

export async function enrichAlarm({
  team,
  clusterKey,
  lookbackMinutes = 60,
}: {
  team: string;
  clusterKey?: string;
  lookbackMinutes?: number;
}): Promise<AlarmEnrichment | null> {
  if (!isEnabled()) return null;

  try {
    const safeMinutes = Math.max(1, Math.min(1440, Number(lookbackMinutes) || 60));

    const [clusterResult, teamResult] = await Promise.allSettled([
      clusterKey
        ? pgPool.get('agent', `
            SELECT COUNT(*)::int AS cnt, MIN(created_at)::text AS first_seen
            FROM agent.event_lake
            WHERE event_type = 'hub_alarm'
              AND created_at >= NOW() - ($1::int * INTERVAL '1 minute')
              AND metadata->>'cluster_key' = $2
          `, [safeMinutes, clusterKey])
        : Promise.resolve(null),
      pgPool.get('agent', `
        SELECT COUNT(*)::int AS cnt
        FROM agent.event_lake
        WHERE event_type = 'hub_alarm'
          AND created_at >= NOW() - ($1::int * INTERVAL '1 minute')
          AND team = $2
      `, [safeMinutes, team]),
    ]);

    const clusterData = clusterResult.status === 'fulfilled' ? clusterResult.value : null;
    const teamData = teamResult.status === 'fulfilled' ? teamResult.value : null;

    return {
      clusterCount: Number(clusterData?.cnt || 0),
      recentTeamCount: Number(teamData?.cnt || 0),
      firstSeenAt: clusterData?.first_seen || null,
    };
  } catch {
    return null;
  }
}

module.exports = { enrichAlarm };
