import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as env from '../../../packages/core/lib/env';
const { recordHubTelemetry } = require('./telemetry');
const { canonicalHubTeam }: { canonicalHubTeam: (value: unknown) => string } = require('./team-identity');

type HubAuthPrincipal = {
  principalId: string;
  team: string | null;
  allowedTeams: string[];
  scopes: string[];
  legacy: boolean;
};

type RequestLike = {
  headers: { authorization?: string; [key: string]: unknown };
  method?: string;
  path?: string;
  originalUrl?: string;
  body?: Record<string, unknown>;
  hubRequestContext?: Record<string, unknown>;
  hubAuthPrincipal?: HubAuthPrincipal;
  hubAuthAudit?: Record<string, unknown>;
};

type ResponseLike = {
  status: (code: number) => { json: (body: Record<string, string>) => unknown };
};

type NextLike = () => unknown;

const LEGACY_AUDIT_INTERVAL_MS = 60_000;
const MAX_AUDIT_THROTTLE_KEYS = 1_000;
const auditLastRecordedAt = new Map<string, number>();
const SAFE_AUDIT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
let scopedPrincipalConfigError: string | null = null;

function rememberAuditTimestamp(key: string, now: number): void {
  if (!auditLastRecordedAt.has(key) && auditLastRecordedAt.size >= MAX_AUDIT_THROTTLE_KEYS) {
    const oldest = auditLastRecordedAt.keys().next().value;
    if (oldest) auditLastRecordedAt.delete(oldest);
  }
  if (auditLastRecordedAt.has(key)) auditLastRecordedAt.delete(key);
  auditLastRecordedAt.set(key, now);
}

function readLaunchctlEnv(name: string): string {
  try {
    return String(execFileSync('/bin/launchctl', ['getenv', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }) || '').trim();
  } catch {
    return '';
  }
}

function configuredHubAuthToken(): string {
  return String(process.env.HUB_AUTH_TOKEN || env.HUB_AUTH_TOKEN || readLaunchctlEnv('HUB_AUTH_TOKEN') || '').trim();
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))];
}

function normalizeTeamList(value: unknown): string[] {
  return [...new Set(normalizeList(value).map(canonicalHubTeam).filter(Boolean))];
}

function noteScopedPrincipalConfigError(reason: string | null): void {
  scopedPrincipalConfigError = reason;
  if (!reason) return;
  const key = `scope-config:${reason}`;
  const now = Date.now();
  const lastRecordedAt = auditLastRecordedAt.get(key) || 0;
  if (now - lastRecordedAt < LEGACY_AUDIT_INTERVAL_MS) return;
  rememberAuditTimestamp(key, now);
  recordHubTelemetry('hub.auth.scope_config_error', {
    mode: 'audit_only',
    severity: 'warn',
    reason,
  });
}

function configuredScopedPrincipals(): HubAuthPrincipal[] {
  const raw = String(process.env.HUB_AUTH_SCOPED_PRINCIPALS_JSON || '').trim();
  if (!raw) {
    noteScopedPrincipalConfigError(null);
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      noteScopedPrincipalConfigError('expected_array');
      return [];
    }
    noteScopedPrincipalConfigError(null);
    return parsed.flatMap((entry: Record<string, unknown>) => {
      const principalId = String(entry?.principalId || entry?.id || '').trim();
      if (!principalId) return [];
      const team = canonicalHubTeam(entry?.team) || null;
      return [{
        principalId,
        team,
        allowedTeams: normalizeTeamList(entry?.allowedTeams || (team ? [team] : [])),
        scopes: normalizeList(entry?.scopes),
        legacy: false,
      }];
    });
  } catch {
    noteScopedPrincipalConfigError('invalid_json');
    return [];
  }
}

function resolvePrincipal(token: string, legacyToken: string): HubAuthPrincipal | null {
  if (safeCompare(token, legacyToken)) {
    return {
      principalId: 'legacy-root',
      team: null,
      allowedTeams: ['*'],
      scopes: ['*'],
      legacy: true,
    };
  }
  return null;
}

function resolveAuditPrincipal(req: RequestLike, authenticated: HubAuthPrincipal): HubAuthPrincipal {
  if (!authenticated.legacy) return authenticated;
  const requestedId = String(req.headers?.['x-hub-audit-principal-id'] || '').trim();
  const claimedTeam = canonicalHubTeam(req.body?.callerTeam || req.headers?.['x-caller-team'] || req.headers?.['x-hub-team'] || '')
    .trim()
    .toLowerCase();
  const configured = configuredScopedPrincipals();
  const match = requestedId
    ? configured.find((principal) => principal.principalId === requestedId)
    : configured.find((principal) => principal.team && principal.team === claimedTeam);
  return match || authenticated;
}

function pathForRequest(req: RequestLike): string {
  return String(req.originalUrl || req.path || '').split('?')[0];
}

function requiredScopes(req: RequestLike): string[] {
  const path = pathForRequest(req);
  const method = String(req.method || 'GET').toUpperCase();
  let scopes = [SAFE_AUDIT_METHODS.has(method) ? 'hub:access' : 'hub:write'];
  if (path === '/hub/pg/query') {
    scopes = ['pg:query'];
  } else if (path.startsWith('/hub/oauth/')) {
    scopes = [method === 'GET' && path.endsWith('/status') ? 'oauth:read' : 'oauth:manage'];
  } else if (path.startsWith('/hub/llm/')) {
    const directProviderPath = path === '/hub/llm/oauth'
      || path === '/hub/llm/groq'
      || path === '/hub/llm/tier-probe';
    const invokePath = path === '/hub/llm/call'
      || path === '/hub/llm/vision'
      || path === '/hub/llm/embeddings'
      || (path === '/hub/llm/jobs' && method === 'POST');
    if (directProviderPath) scopes = ['llm:provider_direct'];
    else if (path === '/hub/llm/circuit' && method === 'DELETE') scopes = ['llm:control'];
    else if (invokePath) scopes = ['llm:invoke'];
    else scopes = ['llm:read'];
  } else if (path.startsWith('/hub/secrets/')) {
    const category = path.slice('/hub/secrets/'.length).split('/')[0] || '*';
    scopes = [`secrets:read:${category}`];
  } else if (path === '/hub/secrets-meta' || path.startsWith('/hub/secrets-meta/')) {
    scopes = ['secrets:meta:read'];
  } else if (path.startsWith('/hub/control/') || path === '/hub/tools' || path.startsWith('/hub/tools/')) {
    scopes = [method === 'GET' ? 'control:read' : 'control:invoke'];
  }
  if (path.includes('/callback') && !scopes.includes('callback:invoke')) scopes.push('callback:invoke');
  if (req.body?.policyOverride) scopes.push('llm:policy_override');
  if (String(req.headers?.['x-hub-load-test'] || '') === '1') scopes.push('llm:load_test');
  return scopes;
}

function hasScope(principal: HubAuthPrincipal, required: string): boolean {
  if (principal.scopes.includes('*') || principal.scopes.includes(required)) return true;
  const [namespace, action] = required.split(':');
  return principal.scopes.includes(`${namespace}:*`)
    || principal.scopes.includes(`${namespace}:${action}:*`);
}

function auditPrincipal(
  req: RequestLike,
  principal: HubAuthPrincipal,
  authenticatedPrincipal: HubAuthPrincipal = principal,
): Record<string, unknown> {
  const reasons: string[] = [];
  if (principal.legacy) reasons.push('legacy_unscoped_principal');
  const claimedTeam = String(req.body?.callerTeam || req.headers?.['x-caller-team'] || req.headers?.['x-hub-team'] || '')
    .trim()
    .toLowerCase();
  const canonicalClaimedTeam = canonicalHubTeam(claimedTeam);
  if (
    !principal.legacy
    && principal.team
    && claimedTeam
    && canonicalClaimedTeam !== principal.team
    && !principal.allowedTeams.includes('*')
    && !principal.allowedTeams.includes(canonicalClaimedTeam)
  ) {
    reasons.push('caller_team_mismatch');
  }
  const scopes = requiredScopes(req);
  if (!principal.legacy) {
    for (const scope of scopes) {
      if (!hasScope(principal, scope)) reasons.push(`missing_scope:${scope}`);
    }
  }
  const audit = {
    mode: 'audit_only',
    principalId: principal.principalId,
    authenticatedPrincipalId: authenticatedPrincipal.principalId,
    simulatedScopedPrincipal: authenticatedPrincipal.principalId !== principal.principalId,
    claimedTeam: claimedTeam || null,
    canonicalClaimedTeam: canonicalClaimedTeam || null,
    requiredScopes: scopes,
    wouldDeny: !principal.legacy && reasons.length > 0,
    reasons,
    scopedPrincipalAuditDegraded: Boolean(scopedPrincipalConfigError),
    scopedPrincipalConfigError,
    path: pathForRequest(req),
    method: String(req.method || 'GET').toUpperCase(),
  };
  const auditKey = `${principal.principalId}:${audit.method}:${audit.path}:${audit.wouldDeny}:${reasons.join(',')}`;
  const now = Date.now();
  const lastRecordedAt = auditLastRecordedAt.get(auditKey) || 0;
  if (now - lastRecordedAt >= LEGACY_AUDIT_INTERVAL_MS) {
    rememberAuditTimestamp(auditKey, now);
    recordHubTelemetry('hub.auth.scope_audit', audit);
  }
  return audit;
}

export function safeCompare(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function authMiddleware(req: RequestLike, res: ResponseLike, next: NextLike): unknown {
  const configured = configuredHubAuthToken();
  if (!configured) {
    return res.status(503).json({ error: 'hub_auth_not_configured' });
  }

  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_bearer_token' });
  }

  const token = header.slice('Bearer '.length).trim();
  const principal = token ? resolvePrincipal(token, configured) : null;
  if (!principal) {
    return res.status(401).json({ error: 'invalid_bearer_token' });
  }

  const auditTarget = resolveAuditPrincipal(req, principal);
  req.hubAuthPrincipal = principal;
  req.hubAuthAudit = auditPrincipal(req, auditTarget, principal);
  req.hubRequestContext = req.hubRequestContext || {};
  req.hubRequestContext.authPrincipalId = principal.principalId;
  req.hubRequestContext.authPrincipalTeam = principal.team;

  return next();
}
