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
  /\bpg_read_file\s*\(/i,
  /\bpg_read_binary_file\s*\(/i,
  /\bpg_ls_dir\s*\(/i,
  /\bpg_stat_file\s*\(/i,
  /\blo_import\s*\(/i,
  /\blo_export\s*\(/i,
  /\bdblink\s*\(/i,
  /\bdblink_connect\s*\(/i,
  /\bpg_read_server_files\b/i,
  /\bpg_write_server_files\b/i,
  /\bpg_execute_server_program\b/i,
];

export const ALLOWED_SCHEMAS = new Set(['agent', 'claude', 'reservation', 'investment', 'ska', 'blog', 'public']);

function stripSqlComments(sql: string): string {
  let stripped = sql.replace(/--[^\n\r]*(?:\r?\n|$)/g, ' ');
  stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return stripped;
}

function normalizeSql(sql: unknown): string {
  const stripped = stripSqlComments(String(sql || ''));
  return stripped
    .trim()
    .replace(/;\s*$/, '')
    .replace(/\s+/g, ' ');
}

export function validateSchema(schema: unknown): { ok: true; schema: string } | { ok: false; reason: string } {
  const normalized = String(schema || 'public').trim().toLowerCase();
  if (!ALLOWED_SCHEMAS.has(normalized)) {
    return {
      ok: false,
      reason: `invalid schema: ${normalized}`,
    };
  }
  return { ok: true, schema: normalized };
}

export function validateSql(sql: unknown): { ok: true; sql: string } | { ok: false; reason: string } {
  const normalized = normalizeSql(sql);
  if (!normalized) {
    return { ok: false, reason: 'empty sql' };
  }

  if (normalized.includes(';')) {
    return {
      ok: false,
      reason: 'multiple statements not allowed',
    };
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
