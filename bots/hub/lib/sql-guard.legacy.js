'use strict';

const ALLOWED_PREFIXES = [/^\s*select\b/i, /^\s*with\b/i, /^\s*explain\b/i];
const BLOCKED_KEYWORDS = [
  /\binsert\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\bupsert\b/i,
  /\bmerge\b/i,
  /\bdrop\b/i,
  /\balter\b/i,
  /\btruncate\b/i,
  /\bcreate\b/i,
  /\breindex\b/i,
  /\bgrant\b/i,
  /\brevoke\b/i,
  /\bcopy\b/i,
  /\bvacuum\b/i,
  /\banalyze\b/i,
  /\bcomment\b/i,
  /\bcall\b/i,
  /\bexecute\b/i,
  /\brefresh\b/i,
  /\blisten\b/i,
  /\bnotify\b/i,
  /\bset\s+role\b/i,
  /\bpg_sleep\s*\(/i,
  /;\s*(select|with|explain)?/i,
];

const ALLOWED_SCHEMAS = new Set([
  'agent',
  'claude',
  'reservation',
  'investment',
  'ska',
  'worker',
  'blog',
  'public',
]);

function normalizeSql(sql) {
  return String(sql || '').trim();
}

function validateSchema(schema) {
  const normalized = String(schema || 'public').trim().toLowerCase();
  if (!ALLOWED_SCHEMAS.has(normalized)) {
    return {
      ok: false,
      reason: `invalid schema: ${normalized}`,
    };
  }
  return { ok: true, schema: normalized };
}

function validateSql(sql) {
  const normalized = normalizeSql(sql);
  if (!normalized) {
    return { ok: false, reason: 'empty sql' };
  }

  for (const pattern of BLOCKED_KEYWORDS) {
    const match = normalized.match(pattern);
    if (match) {
      return {
        ok: false,
        reason: `blocked keyword: ${match[0].trim().toLowerCase()}`,
      };
    }
  }

  if (!ALLOWED_PREFIXES.some((pattern) => pattern.test(normalized))) {
    return { ok: false, reason: 'only SELECT/WITH/EXPLAIN allowed' };
  }

  return { ok: true, sql: normalized };
}

module.exports = {
  ALLOWED_SCHEMAS,
  validateSchema,
  validateSql,
};
