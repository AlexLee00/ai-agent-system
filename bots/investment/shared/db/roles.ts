// @ts-nocheck
import { query, run, get } from './core.ts';

export async function upsertAgentRoleProfile({
  agentId,
  team = 'investment',
  primaryRole,
  secondaryRoles = [],
  capabilities = [],
  defaultPriority = 50,
  metadata = {},
} = {}) {
  if (!agentId || !primaryRole) return null;
  return get(
    `INSERT INTO agent_role_profiles (
       agent_id, team, primary_role, secondary_roles, capabilities, default_priority, metadata, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (agent_id) DO UPDATE SET
       team = EXCLUDED.team,
       primary_role = EXCLUDED.primary_role,
       secondary_roles = EXCLUDED.secondary_roles,
       capabilities = EXCLUDED.capabilities,
       default_priority = EXCLUDED.default_priority,
       metadata = EXCLUDED.metadata,
       updated_at = now()
     RETURNING *`,
    [
      String(agentId),
      String(team || 'investment'),
      String(primaryRole),
      JSON.stringify(Array.isArray(secondaryRoles) ? secondaryRoles : []),
      JSON.stringify(Array.isArray(capabilities) ? capabilities : []),
      Math.max(0, Math.round(Number(defaultPriority || 50))),
      JSON.stringify(metadata || {}),
    ],
  );
}

export async function upsertAgentRoleState({
  agentId,
  team = 'investment',
  scopeType = 'global',
  scopeKey = 'investment',
  mission,
  roleMode,
  priority = 50,
  status = 'active',
  reason = null,
  state = {},
} = {}) {
  if (!agentId || !mission || !roleMode) return null;
  const updated = await get(
    `UPDATE agent_role_state
     SET team = $1,
         mission = $2,
         role_mode = $3,
         priority = $4,
         status = $5,
         reason = $6,
         state = $7::jsonb,
         updated_at = now()
     WHERE agent_id = $8
       AND scope_type = $9
       AND scope_key = $10
       AND status = 'active'
     RETURNING *`,
    [
      String(team || 'investment'),
      String(mission),
      String(roleMode),
      Math.max(0, Math.round(Number(priority || 50))),
      String(status || 'active'),
      reason ? String(reason) : null,
      JSON.stringify(state || {}),
      String(agentId),
      String(scopeType || 'global'),
      String(scopeKey || 'investment'),
    ],
  );
  if (updated) return updated;

  return get(
    `INSERT INTO agent_role_state (
       agent_id, team, scope_type, scope_key, mission, role_mode, priority, status, reason, state
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      String(agentId),
      String(team || 'investment'),
      String(scopeType || 'global'),
      String(scopeKey || 'investment'),
      String(mission),
      String(roleMode),
      Math.max(0, Math.round(Number(priority || 50))),
      String(status || 'active'),
      reason ? String(reason) : null,
      JSON.stringify(state || {}),
    ],
  );
}

export async function getActiveAgentRoleStates({
  team = 'investment',
  scopeType = null,
  scopeKey = null,
  limit = 100,
} = {}) {
  const conditions = [`status = 'active'`, `team = $1`];
  const params = [String(team || 'investment')];
  if (scopeType) {
    params.push(String(scopeType));
    conditions.push(`scope_type = $${params.length}`);
  }
  if (scopeKey) {
    params.push(String(scopeKey));
    conditions.push(`scope_key = $${params.length}`);
  }
  params.push(Math.max(1, Number(limit || 100)));
  return query(
    `SELECT *
     FROM agent_role_state
     WHERE ${conditions.join(' AND ')}
     ORDER BY priority DESC, updated_at DESC
     LIMIT $${params.length}`,
    params,
  );
}

export async function getAgentRoleState({
  agentId,
  team = 'investment',
  scopeType = 'market',
  scopeKey,
} = {}) {
  if (!agentId || !scopeKey) return null;
  return get(
    `SELECT *
     FROM agent_role_state
     WHERE status = 'active'
       AND team = $1
       AND agent_id = $2
       AND scope_type = $3
       AND scope_key = $4
     ORDER BY priority DESC, updated_at DESC
     LIMIT 1`,
    [
      String(team || 'investment'),
      String(agentId),
      String(scopeType || 'market'),
      String(scopeKey),
    ],
  );
}
