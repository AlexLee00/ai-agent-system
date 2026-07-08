const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const env = require('../../../../packages/core/lib/env.legacy.js');
const { validateLunaLiveFireCallbackEnvelope } = require('./luna-live-fire-callback.ts');

const CALLBACK_PREFIX = 'luna_meeting:';
const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

type AnyRecord = Record<string, any>;
type ParsedMeetingCallback =
  | { ok: true; decisionId: string; action: 'confirm' | 'defer'; callbackData: string }
  | { ok: false; error: string };
type AnswerCallbackOptions = {
  botToken?: string;
  fetchFn?: (url: string, options: AnyRecord) => Promise<AnyRecord>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeText(value: unknown, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function parseLunaMeetingCallbackData(callbackData: unknown): ParsedMeetingCallback {
  const normalized = normalizeText(callbackData);
  if (!normalized.startsWith(CALLBACK_PREFIX)) return { ok: false, error: 'unsupported_callback_prefix' };
  const parts = normalized.slice(CALLBACK_PREFIX.length).split(':');
  if (parts.length !== 2) return { ok: false, error: 'invalid_luna_meeting_callback_shape' };
  const [decisionId, action] = parts;
  if (!/^[0-9]+$/.test(decisionId)) return { ok: false, error: 'invalid_luna_meeting_decision_id' };
  if (action !== 'confirm' && action !== 'defer') return { ok: false, error: 'unsupported_luna_meeting_action' };
  if (Buffer.byteLength(normalized, 'utf8') > 64) return { ok: false, error: 'luna_meeting_callback_data_too_long' };
  return { ok: true, decisionId, action, callbackData: normalized };
}

function callbackDataFromReq(req: AnyRecord) {
  return req?.body?.callback_data || req?.body?.callback_query?.data;
}

function callbackQueryIdFromReq(req: AnyRecord) {
  return normalizeText(req?.body?.callback_query_id || req?.body?.callback_query?.id, '');
}

function readTelegramToken() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return store?.telegram?.bot_token
      || store?.reservation?.telegram_bot_token
      || process.env.TELEGRAM_BOT_TOKEN
      || '';
  } catch {
    return process.env.TELEGRAM_BOT_TOKEN || '';
  }
}

async function answerMeetingCallbackQuery(callbackQueryId: unknown, text: unknown, options: AnswerCallbackOptions = {}) {
  const normalizedCallbackQueryId = normalizeText(callbackQueryId, '');
  const botToken = normalizeText(options.botToken, '') || readTelegramToken();
  if (!normalizedCallbackQueryId || !botToken) return { ok: false, skipped: true, reason: 'missing_callback_query_or_token' };
  const fetchFn = options.fetchFn || fetch;
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: normalizedCallbackQueryId,
        text: String(text || '').slice(0, 180),
        show_alert: false,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => null);
    return { ok: res.ok && body?.ok === true, status: res.status, body };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
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

function validateLunaMeetingCallbackEnvelope(req: AnyRecord, source: AnyRecord = process.env) {
  return validateLunaLiveFireCallbackEnvelope(req, {
    ...source,
    HUB_CONTROL_APPROVAL_CHAT_ID: '',
    TELEGRAM_GROUP_ID: '',
  });
}

async function lunaMeetingCallbackRoute(req: AnyRecord, res: AnyRecord) {
  const parsedCallback = parseLunaMeetingCallbackData(callbackDataFromReq(req));
  if (!parsedCallback.ok) return res.status(400).json({ ok: false, error: parsedCallback.error });
  const callbackQueryId = callbackQueryIdFromReq(req);

  const envelope = validateLunaMeetingCallbackEnvelope(req);
  if (!envelope.ok) {
    await answerMeetingCallbackQuery(callbackQueryId, '회의실 버튼 처리 권한을 확인할 수 없습니다.');
    return res.status(envelope.status).json({ ok: false, error: envelope.error });
  }

  const callbackAnswer = await answerMeetingCallbackQuery(callbackQueryId, '회의실 버튼 처리 중입니다.');

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
        callback_query_id: callbackQueryId,
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
      callbackAnswer,
      result,
    });
  } catch (error) {
    await answerMeetingCallbackQuery(callbackQueryId, '회의실 버튼 처리에 실패했습니다.');
    const failure = error as AnyRecord;
    const status = Number(failure?.statusCode || 500);
    return res.status(status).json({
      ok: false,
      error: failure?.code || 'luna_meeting_callback_failed',
      message: errorMessage(error),
    });
  }
}

module.exports = {
  CALLBACK_PREFIX,
  parseLunaMeetingCallbackData,
  answerMeetingCallbackQuery,
  validateLunaMeetingCallbackEnvelope,
  loadMeetingDecisionActions,
  lunaMeetingCallbackRoute,
};
