const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const env = require('../../../../packages/core/lib/env.legacy.js');

const CALLBACK_PREFIX = 'luna_live_fire:';
const EMERGENCY_STOP_ACTION = 'emergency_stop';
const CALLBACK_SECRET_HEADER = 'x-hub-control-callback-secret';
const WATCHDOG_CONFIRM = 'rollback-luna-live-fire';
const WATCHDOG_TIMEOUT_MS = 30_000;

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function parseCsvEnv(name, source = process.env) {
  return String(source[name] || '')
    .split(',')
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function parseCsvEnvUsernames(name, source = process.env) {
  return parseCsvEnv(name, source)
    .map((item) => item.replace(/^@+/, '').toLowerCase())
    .filter(Boolean);
}

function getHeaderValue(req, headerName) {
  const lower = headerName.toLowerCase();
  const candidate = req?.headers?.[lower]
    ?? req?.headers?.[headerName]
    ?? req?.get?.(headerName)
    ?? req?.get?.(lower);
  return normalizeText(Array.isArray(candidate) ? candidate[0] : candidate, '');
}

function safeTimingEqual(expected, actual) {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function parseLunaLiveFireCallbackData(callbackData) {
  const normalized = normalizeText(callbackData);
  if (!normalized.startsWith(CALLBACK_PREFIX)) return { ok: false, error: 'unsupported_callback_prefix' };
  const action = normalizeText(normalized.slice(CALLBACK_PREFIX.length));
  if (action !== EMERGENCY_STOP_ACTION) return { ok: false, error: 'unsupported_luna_live_fire_action' };
  return { ok: true, action };
}

function extractActorContext(req) {
  return {
    actorId: normalizeText(req?.body?.from?.id, ''),
    actorUsername: normalizeText(req?.body?.from?.username, '').replace(/^@+/, '').toLowerCase(),
    chatId: normalizeText(req?.body?.message?.chat?.id, ''),
  };
}

function validateLunaLiveFireCallbackEnvelope(req, source = process.env) {
  const configuredSecret = normalizeText(source.HUB_CONTROL_CALLBACK_SECRET, '');
  if (!configuredSecret) return { ok: false, status: 503, error: 'luna_live_fire_callback_secret_not_configured' };
  const providedSecret = getHeaderValue(req, CALLBACK_SECRET_HEADER);
  if (!providedSecret || !safeTimingEqual(configuredSecret, providedSecret)) {
    return { ok: false, status: 403, error: 'luna_live_fire_callback_untrusted_source' };
  }

  const actor = extractActorContext(req);
  const allowedActorIds = parseCsvEnv('HUB_CONTROL_APPROVER_IDS', source);
  const allowedUsernames = parseCsvEnvUsernames('HUB_CONTROL_APPROVER_USERNAMES', source);
  if (allowedActorIds.length === 0 && allowedUsernames.length === 0) {
    return { ok: false, status: 503, error: 'luna_live_fire_approver_not_configured', actor };
  }
  const actorAllowed = (actor.actorId && allowedActorIds.includes(actor.actorId))
    || (actor.actorUsername && allowedUsernames.includes(actor.actorUsername));
  if (!actorAllowed) return { ok: false, status: 403, error: 'luna_live_fire_actor_not_allowed', actor };

  const expectedChatId = normalizeText(source.HUB_CONTROL_APPROVAL_CHAT_ID || source.TELEGRAM_GROUP_ID, '');
  if (expectedChatId && actor.chatId && actor.chatId !== expectedChatId) {
    return { ok: false, status: 403, error: 'luna_live_fire_chat_not_allowed', actor };
  }
  return { ok: true, status: 200, actor };
}

function buildLunaLiveFireEmergencyStopCommand(projectRoot = env.PROJECT_ROOT) {
  return {
    command: 'npm',
    args: [
      '--prefix',
      path.join(projectRoot, 'bots', 'investment'),
      'run',
      '-s',
      'runtime:luna-live-fire-watchdog',
      '--',
      '--apply',
      '--force-stop',
      `--confirm=${WATCHDOG_CONFIRM}`,
      '--json',
    ],
    timeoutMs: WATCHDOG_TIMEOUT_MS,
  };
}

function runEmergencyStop(projectRoot = env.PROJECT_ROOT) {
  const commandSpec = buildLunaLiveFireEmergencyStopCommand(projectRoot);
  const result = spawnSync(commandSpec.command, commandSpec.args, {
    encoding: 'utf8',
    timeout: commandSpec.timeoutMs,
  });
  const stdout = normalizeText(result.stdout, '');
  const stderr = normalizeText(result.stderr, '');
  let parsed = null;
  try {
    parsed = stdout ? JSON.parse(stdout) : null;
  } catch {
    parsed = null;
  }
  return {
    ok: result.status === 0 && parsed?.applied === true,
    status: result.status,
    signal: result.signal || null,
    stdout,
    stderr,
    parsed,
    command: [commandSpec.command, ...commandSpec.args].join(' '),
    timeoutMs: commandSpec.timeoutMs,
  };
}

async function lunaLiveFireCallbackRoute(req, res) {
  const parsedCallback = parseLunaLiveFireCallbackData(req?.body?.callback_data || req?.body?.callback_query?.data);
  if (!parsedCallback.ok) return res.status(400).json({ ok: false, error: parsedCallback.error });

  const envelope = validateLunaLiveFireCallbackEnvelope(req);
  if (!envelope.ok) return res.status(envelope.status).json({ ok: false, error: envelope.error });

  const stopResult = runEmergencyStop();
  return res.status(stopResult.ok ? 200 : 500).json({
    ok: stopResult.ok,
    status: stopResult.ok ? 'luna_live_fire_emergency_stop_applied' : 'luna_live_fire_emergency_stop_failed',
    action: parsedCallback.action,
    actor: envelope.actor,
    timeoutMs: stopResult.timeoutMs,
    result: stopResult.parsed || {
      status: stopResult.status,
      signal: stopResult.signal,
      stderr: stopResult.stderr,
    },
  });
}

module.exports = {
  CALLBACK_PREFIX,
  EMERGENCY_STOP_ACTION,
  WATCHDOG_CONFIRM,
  parseLunaLiveFireCallbackData,
  validateLunaLiveFireCallbackEnvelope,
  buildLunaLiveFireEmergencyStopCommand,
  lunaLiveFireCallbackRoute,
};
