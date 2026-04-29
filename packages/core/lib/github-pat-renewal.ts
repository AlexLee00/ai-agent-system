const GITHUB_FINE_GRAINED_PAT_URL = 'https://github.com/settings/personal-access-tokens/new';

type PermissionLevel = 'read' | 'write' | 'admin';
type PermissionMap = Record<string, PermissionLevel>;

type BuildPatPrefillOptions = {
  name?: string;
  description?: string;
  targetName?: string;
  expiresIn?: number | 'none' | string;
  permissions?: PermissionMap;
};

const PERMISSION_PRESETS: Record<string, PermissionMap> = {
  repo_read: {
    contents: 'read',
    metadata: 'read',
  },
  repo_write_pr: {
    contents: 'write',
    pull_requests: 'write',
    metadata: 'read',
  },
  issues_triage: {
    issues: 'write',
    pull_requests: 'read',
    metadata: 'read',
  },
  repo_automation: {
    actions: 'write',
    contents: 'write',
    pull_requests: 'write',
    workflows: 'write',
    metadata: 'read',
  },
  models_read: {
    organization_models: 'read',
  },
};

function normalizeText(value: unknown): string {
  return String(value == null ? '' : value).trim();
}

function isValidPermissionLevel(value: string): value is PermissionLevel {
  return ['read', 'write', 'admin'].includes(value);
}

function clampExpiration(value: unknown): string {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return '30';
  if (raw === 'none') return 'none';
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return '30';
  return String(Math.max(1, Math.min(366, Math.round(parsed))));
}

function parsePermissionPairs(input: unknown): PermissionMap {
  const raw = normalizeText(input);
  if (!raw) return {};

  const entries = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const next: PermissionMap = {};
  for (const entry of entries) {
    const [keyPart, valuePart] = entry.split('=');
    const key = normalizeText(keyPart);
    const level = normalizeText(valuePart).toLowerCase();
    if (!key || !isValidPermissionLevel(level)) continue;
    next[key] = level;
  }
  return next;
}

function mergePermissions(...sets: Array<PermissionMap | null | undefined>): PermissionMap {
  const merged: PermissionMap = {};
  for (const set of sets) {
    if (!set) continue;
    for (const [key, value] of Object.entries(set)) {
      if (!key || !isValidPermissionLevel(String(value))) continue;
      merged[key] = value;
    }
  }
  if (Object.keys(merged).length > 0 && !merged.metadata) {
    merged.metadata = 'read';
  }
  return merged;
}

function resolvePermissionPreset(names: unknown): PermissionMap {
  const raw = normalizeText(names);
  if (!raw) return {};
  const resolved: PermissionMap = {};
  for (const name of raw.split(',').map((item) => item.trim()).filter(Boolean)) {
    const preset = PERMISSION_PRESETS[name];
    if (!preset) continue;
    Object.assign(resolved, preset);
  }
  return resolved;
}

function buildGitHubPatPrefillUrl(options: BuildPatPrefillOptions): string {
  const params = new URLSearchParams();
  const name = normalizeText(options.name);
  const description = normalizeText(options.description);
  const targetName = normalizeText(options.targetName);
  const expiresIn = clampExpiration(options.expiresIn);
  const permissions = options.permissions || {};

  if (name) params.set('name', name);
  if (description) params.set('description', description);
  if (targetName) params.set('target_name', targetName);
  if (expiresIn) params.set('expires_in', expiresIn);

  for (const [permission, level] of Object.entries(permissions).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!permission || !isValidPermissionLevel(String(level))) continue;
    params.set(permission, level);
  }

  const query = params.toString();
  return query ? `${GITHUB_FINE_GRAINED_PAT_URL}?${query}` : GITHUB_FINE_GRAINED_PAT_URL;
}

function parseRepositories(input: unknown): string[] {
  const raw = normalizeText(input);
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function summarizePermissions(permissions: PermissionMap): string[] {
  return Object.entries(permissions)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}:${value}`);
}

export = {
  GITHUB_FINE_GRAINED_PAT_URL,
  PERMISSION_PRESETS,
  parsePermissionPairs,
  parseRepositories,
  resolvePermissionPreset,
  mergePermissions,
  clampExpiration,
  buildGitHubPatPrefillUrl,
  summarizePermissions,
};
