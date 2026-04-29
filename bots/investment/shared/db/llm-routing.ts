// @ts-nocheck
/**
 * LLM route-log DB helpers.
 *
 * These helpers keep cleanup/reporting scripts away from raw SQL fragments and
 * make the smoke-artifact contract explicit.
 */

import { query, get, run } from './core.ts';

export const HUB_DISABLED_SMOKE_ARTIFACT_WHERE = `
  provider = 'direct_fallback'
  AND COALESCE(error, '') = 'hub_disabled'
  AND market IS NULL
  AND symbol IS NULL
  AND incident_key IS NULL
`;

export async function listHubDisabledSmokeArtifacts({ limit = 50 } = {}) {
  return query(
    `SELECT id, agent_name, provider, response_ok, fallback_used, error, created_at
       FROM investment.llm_routing_log
      WHERE ${HUB_DISABLED_SMOKE_ARTIFACT_WHERE}
      ORDER BY created_at ASC
      LIMIT $1`,
    [Math.min(500, Math.max(1, Number(limit || 50)))],
  );
}

export async function countHubDisabledSmokeArtifacts() {
  const row = await get(
    `SELECT COUNT(*)::int AS count
       FROM investment.llm_routing_log
      WHERE ${HUB_DISABLED_SMOKE_ARTIFACT_WHERE}`,
  );
  return Number(row?.count || 0);
}

export async function deleteHubDisabledSmokeArtifacts() {
  return run(
    `DELETE FROM investment.llm_routing_log
      WHERE ${HUB_DISABLED_SMOKE_ARTIFACT_WHERE}`,
  );
}

export default {
  HUB_DISABLED_SMOKE_ARTIFACT_WHERE,
  listHubDisabledSmokeArtifacts,
  countHubDisabledSmokeArtifacts,
  deleteHubDisabledSmokeArtifacts,
};
