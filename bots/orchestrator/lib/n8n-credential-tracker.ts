'use strict';

const N8N_CREDENTIAL_MISSING_CODE = 'n8n_credential_missing';

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function createN8nCredentialMissingError(name, cause) {
  const credentialName = normalizeText(name, 'unknown');
  const error = new Error(`n8n credential missing: ${credentialName}`);
  error.code = N8N_CREDENTIAL_MISSING_CODE;
  error.credentialName = credentialName;
  error.cause = cause;
  error.trackingKey = `n8n:credential:${credentialName.toLowerCase().replace(/\s+/g, '_')}`;
  return error;
}

function classifyN8nCredentialError(error) {
  const code = normalizeText(error?.code, '');
  const message = normalizeText(error?.message || error, '');
  const credentialName = normalizeText(error?.credentialName, '');
  const match = message.match(/자격증명\s+"([^"]+)"/) || message.match(/credential missing:\s*([^—\n]+)/i);
  if (code === N8N_CREDENTIAL_MISSING_CODE || /자격증명.+없음|credential missing/i.test(message)) {
    return {
      kind: 'credential_missing',
      code: N8N_CREDENTIAL_MISSING_CODE,
      credentialName: credentialName || normalizeText(match?.[1], 'unknown'),
      message,
    };
  }
  return {
    kind: 'unknown',
    code: code || 'unknown',
    credentialName: credentialName || 'unknown',
    message,
  };
}

function buildN8nCredentialTrackingEvent(input = {}) {
  const classified = classifyN8nCredentialError(input.error);
  return {
    eventType: 'n8n_credential_error',
    kind: classified.kind,
    code: classified.code,
    credentialName: normalizeText(input.credentialName, classified.credentialName),
    workflowName: normalizeText(input.workflowName, 'unknown'),
    team: normalizeText(input.team, 'orchestrator'),
    severity: classified.kind === 'credential_missing' ? 'warn' : 'info',
    message: classified.message,
  };
}

module.exports = {
  N8N_CREDENTIAL_MISSING_CODE,
  buildN8nCredentialTrackingEvent,
  classifyN8nCredentialError,
  createN8nCredentialMissingError,
};
