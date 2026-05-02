'use strict';

const CLOUD_AI_COMPANION_SERVICE = 'cloudaicompanion.googleapis.com';

function normalizeProjectId(projectId) {
  return String(projectId || '').trim();
}

function buildServiceUsageUrl(projectId, service = CLOUD_AI_COMPANION_SERVICE) {
  const project = normalizeProjectId(projectId);
  if (!project) throw new Error('gemini_codeassist_project_missing');
  return `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(project)}/services/${encodeURIComponent(service)}`;
}

async function parseJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function summarizeServiceUsageError(status, body = {}) {
  const error = body?.error || body || {};
  const message = String(error.message || '').slice(0, 500);
  const errorStatus = String(error.status || '').trim();
  const missingPermission = Array.isArray(error.details)
    ? error.details.some((detail) => String(detail?.reason || detail?.metadata?.permission || '').includes('serviceusage'))
    : false;
  const kind = status === 401
    ? 'auth_required'
    : status === 403
      ? (missingPermission ? 'permission_denied' : 'forbidden')
      : status === 404
        ? 'project_or_service_not_found'
        : 'service_usage_error';
  return {
    kind,
    status,
    google_status: errorStatus || null,
    message,
  };
}

function serviceActivationUrl(projectId) {
  const project = normalizeProjectId(projectId);
  if (!project) return null;
  return `https://console.developers.google.com/apis/api/${CLOUD_AI_COMPANION_SERVICE}/overview?project=${encodeURIComponent(project)}`;
}

async function checkGeminiCodeAssistServiceStatus(options = {}) {
  const projectId = normalizeProjectId(options.projectId);
  const accessToken = String(options.accessToken || '').trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!projectId) {
    return {
      ok: false,
      service: CLOUD_AI_COMPANION_SERVICE,
      project_id_configured: false,
      state: null,
      error: 'gemini_codeassist_project_missing',
      activation_url: null,
    };
  }
  if (!accessToken) {
    return {
      ok: false,
      service: CLOUD_AI_COMPANION_SERVICE,
      project_id_configured: true,
      state: null,
      error: 'gemini_codeassist_access_token_missing',
      activation_url: serviceActivationUrl(projectId),
    };
  }

  const response = await fetchImpl(buildServiceUsageUrl(projectId), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const body = await parseJsonSafely(response);
  const state = String(body?.state || '').trim().toUpperCase() || null;
  const enabled = response.ok && state === 'ENABLED';
  const activationUrl = serviceActivationUrl(projectId);
  return {
    ok: enabled,
    service: CLOUD_AI_COMPANION_SERVICE,
    project_id_configured: true,
    http_status: Number(response.status || 0),
    state,
    activation_url: activationUrl,
    error: enabled ? null : (
      response.ok
        ? {
          kind: state === 'DISABLED' ? 'service_disabled' : 'service_not_enabled',
          status: Number(response.status || 0),
          message: `${CLOUD_AI_COMPANION_SERVICE} state=${state || 'unknown'}`,
        }
        : summarizeServiceUsageError(Number(response.status || 0), body)
    ),
    operator_action: enabled
      ? null
      : `Enable Gemini for Google Cloud API for the quota project: ${activationUrl}`,
  };
}

module.exports = {
  CLOUD_AI_COMPANION_SERVICE,
  buildServiceUsageUrl,
  checkGeminiCodeAssistServiceStatus,
  serviceActivationUrl,
  summarizeServiceUsageError,
};
