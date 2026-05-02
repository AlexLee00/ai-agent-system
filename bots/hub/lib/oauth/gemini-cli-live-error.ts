'use strict';

type GeminiCliLiveErrorKind =
  | 'service_disabled'
  | 'auth_required'
  | 'permission_denied'
  | 'quota_project_missing'
  | 'unknown';

interface GeminiCliLiveErrorClassification {
  kind: GeminiCliLiveErrorKind;
  service: string | null;
  activationUrl: string | null;
  operatorAction: string | null;
}

const CLOUD_AI_COMPANION_SERVICE = 'cloudaicompanion.googleapis.com';

function firstMatch(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match?.[0] || null;
}

function normalizeActivationUrl(url: string | null, projectId: string | null): string | null {
  if (url) return url.replace(/[)\].,;]+$/g, '');
  if (!projectId) return null;
  return `https://console.developers.google.com/apis/api/${CLOUD_AI_COMPANION_SERVICE}/overview?project=${encodeURIComponent(projectId)}`;
}

function classifyGeminiCliLiveError(errorText: unknown): GeminiCliLiveErrorClassification {
  const text = String(errorText || '');
  const lower = text.toLowerCase();
  const service = lower.includes(CLOUD_AI_COMPANION_SERVICE)
    ? CLOUD_AI_COMPANION_SERVICE
    : firstMatch(text, /[a-z0-9-]+\.googleapis\.com/i);
  const projectId = firstMatch(text, /project\s+([a-z][a-z0-9-]{4,})/i)?.replace(/^project\s+/i, '') || null;
  const activationUrl = normalizeActivationUrl(
    firstMatch(text, /https:\/\/console\.developers\.google\.com\/apis\/api\/[^\s"']+/i),
    service === CLOUD_AI_COMPANION_SERVICE ? projectId : null,
  );

  if (
    service === CLOUD_AI_COMPANION_SERVICE
    && (
      text.includes('SERVICE_DISABLED')
      || text.includes('accessNotConfigured')
      || lower.includes('has not been used')
      || lower.includes('it is disabled')
    )
  ) {
    return {
      kind: 'service_disabled',
      service,
      activationUrl,
      operatorAction: activationUrl
        ? `Enable Gemini for Google Cloud API for the quota project: ${activationUrl}`
        : 'Enable Gemini for Google Cloud API for the Gemini CLI quota project.',
    };
  }

  if (lower.includes('quota project') || lower.includes('billing/quota project')) {
    return {
      kind: 'quota_project_missing',
      service,
      activationUrl,
      operatorAction: 'Set GEMINI_OAUTH_PROJECT_ID or GOOGLE_CLOUD_PROJECT to a Gemini CLI quota project.',
    };
  }

  if (lower.includes('login') || lower.includes('unauthenticated') || lower.includes('invalid_grant')) {
    return {
      kind: 'auth_required',
      service,
      activationUrl,
      operatorAction: 'Refresh Gemini CLI OAuth with gemini auth login, then rerun the live readiness probe.',
    };
  }

  if (lower.includes('permission') || lower.includes('forbidden') || lower.includes('403')) {
    return {
      kind: 'permission_denied',
      service,
      activationUrl,
      operatorAction: 'Verify the authenticated Google account has access to Gemini for Google Cloud on the quota project.',
    };
  }

  return {
    kind: 'unknown',
    service,
    activationUrl,
    operatorAction: null,
  };
}

module.exports = {
  classifyGeminiCliLiveError,
};
