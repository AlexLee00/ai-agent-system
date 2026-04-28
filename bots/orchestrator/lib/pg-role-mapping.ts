'use strict';

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function resolvePgRoleMapping(env = process.env) {
  const pgDirect = isEnabled(env.PG_DIRECT);
  const hubReadonlyConfigured = Boolean(env.HUB_BASE_URL && env.HUB_PG_USER);
  const directUser = normalizeText(env.PG_USER, 'os_user');
  const database = normalizeText(env.PG_DATABASE, 'jay');

  const mode = pgDirect
    ? 'direct_writer'
    : hubReadonlyConfigured
      ? 'hub_readonly'
      : 'direct_default';

  return {
    mode,
    database,
    schemas: {
      writer: ['agent', 'claude'],
      readonly: ['public', 'agent', 'claude'],
    },
    directWriter: {
      enabled: pgDirect || !hubReadonlyConfigured,
      user: directUser,
      reason: pgDirect ? 'PG_DIRECT=true' : 'no_hub_readonly_role_configured',
    },
    hubReadonly: {
      configured: hubReadonlyConfigured,
      user: normalizeText(env.HUB_PG_USER, ''),
      database: normalizeText(env.HUB_PG_DATABASE, database),
      reason: hubReadonlyConfigured ? 'HUB_BASE_URL+HUB_PG_USER configured' : 'not_configured',
    },
  };
}

function validatePgRoleMapping(mapping = resolvePgRoleMapping()) {
  const warnings = [];
  if (mapping.mode === 'direct_default') {
    warnings.push('hub_readonly_not_configured_using_direct_default');
  }
  if (mapping.directWriter.enabled && mapping.directWriter.user === 'os_user') {
    warnings.push('pg_user_implicit_os_user');
  }
  return {
    ok: warnings.length === 0 || mapping.mode === 'direct_writer',
    warnings,
  };
}

module.exports = {
  resolvePgRoleMapping,
  validatePgRoleMapping,
};
