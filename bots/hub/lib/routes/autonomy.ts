const TEAM_JAY_DASHBOARD_BASE =
  String(process.env.TEAM_JAY_DASHBOARD_URL || 'http://127.0.0.1:7787').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 10_000;

function cleanString(value: unknown, maxLength: number): string {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeSubtype(value: unknown): 'telegram' | 'phase_change' | 'decision' {
  const subtype = cleanString(value, 64);
  if (subtype === 'phase_change' || subtype === 'decision') return subtype;
  return 'telegram';
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function dashboardToken(): string {
  return String(
    process.env.TEAM_JAY_MASTER_INTERVENTION_TOKEN
    || process.env.HUB_CONTROL_CALLBACK_SECRET
    || '',
  ).trim();
}

export async function autonomyInterventionRoute(req: any, res: any) {
  const title = cleanString(req.body?.title, 240);
  if (!title) {
    return res.status(400).json({ ok: false, error: 'title required' });
  }

  const subtype = normalizeSubtype(req.body?.subtype);
  const metadata = normalizeMetadata(req.body?.metadata);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = dashboardToken();
  if (token) {
    headers['x-team-jay-master-intervention-token'] = token;
  }

  try {
    const response = await fetch(`${TEAM_JAY_DASHBOARD_BASE}/api/master-intervention`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, subtype, metadata }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: 'team_jay_intervention_failed',
        status: response.status,
        detail: body,
      });
    }

    return res.json({
      ok: true,
      route: 'hub.v2.autonomy.intervention',
      forwarded: true,
      team_jay: body,
    });
  } catch (error: any) {
    return res.status(502).json({
      ok: false,
      error: 'team_jay_intervention_unreachable',
      message: error?.message || String(error),
    });
  }
}
