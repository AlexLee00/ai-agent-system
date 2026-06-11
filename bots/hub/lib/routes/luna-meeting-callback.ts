const path = require('node:path');
const { pathToFileURL } = require('node:url');
const env = require('../../../../packages/core/lib/env.legacy.js');
const { validateLunaLiveFireCallbackEnvelope } = require('./luna-live-fire-callback.ts');

const CALLBACK_PREFIX = 'luna_meeting:';

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function parseLunaMeetingCallbackData(callbackData) {
  const normalized = normalizeText(callbackData);
  if (!normalized.startsWith(CALLBACK_PREFIX)) return { ok: false, error: 'unsupported_callback_prefix' };
  const parts = normalized.slice(CALLBACK_PREFIX.length).split(':');
  if (parts.length !== 2) return { ok: false, error: 'invalid_luna_meeting_callback_shape' };
  const [decisionId, action] = parts;
  if (!/^[0-9]+$/.test(decisionId)) return { ok: false, error: 'invalid_luna_meeting_decision_id' };
  if (!['confirm', 'defer'].includes(action)) return { ok: false, error: 'unsupported_luna_meeting_action' };
  if (Buffer.byteLength(normalized, 'utf8') > 64) return { ok: false, error: 'luna_meeting_callback_data_too_long' };
  return { ok: true, decisionId, action, callbackData: normalized };
}

function callbackDataFromReq(req) {
  return req?.body?.callback_data || req?.body?.callback_query?.data;
}

async function loadMeetingDecisionActions(projectRoot = env.PROJECT_ROOT) {
  const modulePath = path.join(
    projectRoot,
    'bots',
    'investment',
    'services',
    'meeting-room',
    'server',
    'meeting-decision-actions.ts',
  );
  return import(pathToFileURL(modulePath).href);
}

async function lunaMeetingCallbackRoute(req, res) {
  const parsedCallback = parseLunaMeetingCallbackData(callbackDataFromReq(req));
  if (!parsedCallback.ok) return res.status(400).json({ ok: false, error: parsedCallback.error });

  const envelope = validateLunaLiveFireCallbackEnvelope(req);
  if (!envelope.ok) return res.status(envelope.status).json({ ok: false, error: envelope.error });

  try {
    const { applyMeetingDecisionAction } = await loadMeetingDecisionActions();
    const result = await applyMeetingDecisionAction({
      id: parsedCallback.decisionId,
      action: parsedCallback.action,
      note: `telegram ${parsedCallback.action}`,
      changedVia: 'telegram',
      actor: envelope.actor,
      callback: {
        data: parsedCallback.callbackData,
        callback_query_id: normalizeText(req?.body?.callback_query_id, ''),
      },
    });
    const actionText = parsedCallback.action === 'confirm' ? '확정됨' : '보류됨';
    return res.status(200).json({
      ok: true,
      status: result.idempotent ? `already_${result.logicalStatus}` : `meeting_decision_${result.logicalStatus}`,
      text: result.idempotent
        ? `이미 ${result.logicalStatus} 처리됨: ${result.decision?.agendaKey || parsedCallback.decisionId}`
        : `${actionText}: ${result.decision?.agendaKey || parsedCallback.decisionId}`,
      action: parsedCallback.action,
      actor: envelope.actor,
      result,
    });
  } catch (error) {
    const status = Number(error?.statusCode || 500);
    return res.status(status).json({
      ok: false,
      error: error?.code || 'luna_meeting_callback_failed',
      message: error?.message || String(error),
    });
  }
}

module.exports = {
  CALLBACK_PREFIX,
  parseLunaMeetingCallbackData,
  loadMeetingDecisionActions,
  lunaMeetingCallbackRoute,
};
