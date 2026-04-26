#!/usr/bin/env tsx
type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

type Check = {
  name: string;
  status: CheckStatus;
  required: boolean;
  http_status?: number | null;
  details?: Record<string, unknown>;
};

const PLACEHOLDER_RE = /(__SET_|CHANGE_ME|REPLACE_ME|TODO|PLACEHOLDER|changeme)/i;

function flag(name: string): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function usableSecret(value: string | undefined): boolean {
  const text = String(value || '').trim();
  return text.length >= 12 && !PLACEHOLDER_RE.test(text);
}

function baseUrl(): string {
  return String(process.env.HUB_BASE_URL || process.env.HUB_URL || 'http://127.0.0.1:7788').replace(/\/+$/, '');
}

function timeoutMs(): number {
  return Math.max(1000, Number(process.env.HUB_LIVE_DRILL_TIMEOUT_MS || 5000) || 5000);
}

function setupMockFetch() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = String(init?.method || 'GET').toUpperCase();
    if (path === '/hub/health/live') {
      return Response.json({ status: 'ok', live: true, mode: 'mock' });
    }
    if (path === '/hub/health/ready') {
      return Response.json({ status: 'ok', ready: true, mode: 'mock' });
    }
    if (path.includes('/hub/oauth/') && path.endsWith('/status')) {
      const provider = path.split('/').at(-2) || 'unknown';
      return Response.json({
        ok: true,
        provider,
        status: { authenticated: true, source: 'mock' },
        canary: { ok: true, checkedAt: new Date().toISOString() },
        token_store: { has_token: true, updated_at: new Date().toISOString() },
      });
    }
    if (method === 'POST' && path === '/hub/alarm/digest/flush') {
      return Response.json({ ok: true, dry_run: true, selected_count: 0, teams: [] });
    }
    if (method === 'POST' && path === '/hub/alarm/suppress/dry-run') {
      return Response.json({ ok: true, dry_run: true, matched_total: 0, sample: [] });
    }
    return Response.json({ ok: false, error: 'mock_route_not_found' }, { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function requestJson({
  name,
  method = 'GET',
  path,
  token,
  body,
  required = true,
  summarize,
}: {
  name: string;
  method?: 'GET' | 'POST';
  path: string;
  token?: string;
  body?: Record<string, unknown>;
  required?: boolean;
  summarize: (payload: any) => Record<string, unknown>;
}): Promise<Check> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${baseUrl()}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : { text: await response.text() };
    const ok = response.ok && payload?.ok !== false;
    return {
      name,
      status: ok ? 'pass' : required ? 'fail' : 'warn',
      required,
      http_status: response.status,
      details: summarize(payload),
    };
  } catch (error: any) {
    return {
      name,
      status: required ? 'fail' : 'warn',
      required,
      http_status: null,
      details: {
        error: error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error),
      },
    };
  }
}

function skipCheck(name: string, reason: string, required = false): Check {
  return {
    name,
    status: required ? 'fail' : 'skip',
    required,
    details: { reason },
  };
}

function aggregate(checks: Check[]) {
  const requiredFailures = checks.filter((check) => check.required && check.status === 'fail');
  const warnings = checks.filter((check) => check.status === 'warn');
  const skipped = checks.filter((check) => check.status === 'skip');
  return {
    ok: requiredFailures.length === 0,
    status: requiredFailures.length ? 'fail' : warnings.length ? 'warn' : 'pass',
    required_failures: requiredFailures.length,
    warnings: warnings.length,
    skipped: skipped.length,
  };
}

async function main() {
  const restoreFetch = flag('HUB_LIVE_DRILL_MOCK') ? setupMockFetch() : null;
  const token = process.env.HUB_AUTH_TOKEN || '';
  const authReady = usableSecret(token);
  const requireAuth = flag('HUB_LIVE_DRILL_REQUIRE_AUTH');

  try {
    const checks: Check[] = [
      await requestJson({
        name: 'health_live',
        path: '/hub/health/live',
        summarize: (payload) => ({
          status: payload?.status || null,
          live: payload?.live ?? null,
          mode: payload?.mode || null,
        }),
      }),
      await requestJson({
        name: 'health_ready',
        path: '/hub/health/ready',
        summarize: (payload) => ({
          status: payload?.status || null,
          ready: payload?.ready ?? payload?.ok ?? null,
          mode: payload?.mode || null,
        }),
      }),
    ];

    if (!authReady) {
      checks.push(skipCheck(
        'authenticated_hub_checks',
        'HUB_AUTH_TOKEN is missing or placeholder; authenticated live checks skipped',
        requireAuth,
      ));
    } else {
      for (const provider of ['openai-codex-oauth', 'claude-code-cli']) {
        checks.push(await requestJson({
          name: `oauth_status_${provider}`,
          path: `/hub/oauth/${provider}/status`,
          token,
          summarize: (payload) => ({
            provider: payload?.provider || provider,
            token_store_has_token: payload?.token_store?.has_token ?? null,
            canary_ok: payload?.canary?.ok ?? null,
            status_ok: payload?.ok ?? null,
          }),
        }));
      }
      checks.push(await requestJson({
        name: 'alarm_digest_dry_run',
        path: '/hub/alarm/digest/flush',
        method: 'POST',
        token,
        body: { dry_run: true, minutes: 60, limit: 20 },
        summarize: (payload) => ({
          dry_run: payload?.dry_run ?? null,
          selected_count: payload?.selected_count ?? null,
          team_count: Array.isArray(payload?.teams) ? payload.teams.length : null,
        }),
      }));
      checks.push(await requestJson({
        name: 'alarm_suppress_dry_run',
        path: '/hub/alarm/suppress/dry-run',
        method: 'POST',
        token,
        body: { minutes: 60, visibility: 'digest' },
        summarize: (payload) => ({
          dry_run: payload?.dry_run ?? null,
          matched_total: payload?.matched_total ?? null,
        }),
      }));
    }

    const summary = aggregate(checks);
    console.log(JSON.stringify({
      ...summary,
      generated_at: new Date().toISOString(),
      base_url: baseUrl(),
      mock: flag('HUB_LIVE_DRILL_MOCK'),
      authenticated_checks_enabled: authReady,
      checks,
      next_actions: summary.ok
        ? ['If mock=false, Hub API responded to live readiness drill without required failures.']
        : ['Fix required live drill failures before running live OAuth canary or Telegram alarm sends.'],
    }, null, 2));
    process.exit(summary.ok ? 0 : 1);
  } finally {
    restoreFetch?.();
  }
}

main().catch((error) => {
  console.error('[hub-live-drill] failed:', error?.message || error);
  process.exit(1);
});
