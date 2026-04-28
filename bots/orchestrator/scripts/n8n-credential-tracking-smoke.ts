#!/usr/bin/env tsx
import assert from 'node:assert/strict';

const {
  buildN8nCredentialTrackingEvent,
  classifyN8nCredentialError,
  createN8nCredentialMissingError,
} = require('../lib/n8n-credential-tracker.ts');

const missing = createN8nCredentialMissingError('Team Jay Telegram');
const classified = classifyN8nCredentialError(missing);
assert.equal(classified.kind, 'credential_missing');
assert.equal(classified.credentialName, 'Team Jay Telegram');

const korean = classifyN8nCredentialError(new Error('자격증명 "Team Jay PostgreSQL" 없음'));
assert.equal(korean.kind, 'credential_missing');
assert.equal(korean.credentialName, 'Team Jay PostgreSQL');

const event = buildN8nCredentialTrackingEvent({
  credentialName: 'Team Jay Telegram',
  workflowName: '스카팀 예약 알림',
  team: 'ska',
  error: missing,
});
assert.equal(event.eventType, 'n8n_credential_error');
assert.equal(event.code, 'n8n_credential_missing');
assert.equal(event.severity, 'warn');

console.log('n8n_credential_tracking_smoke_ok');
