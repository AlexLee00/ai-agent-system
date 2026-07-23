const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const env = require('../../../../packages/core/lib/env');
const { publishToWebhook } = require('../../../../packages/core/lib/reporting-hub');
const eventLake = require('../../../../packages/core/lib/event-lake');
const proposalStore = require('../../../darwin/lib/proposal-store');
const autonomyLevel = require('../../../darwin/lib/autonomy-level');
const researchTasks = require('../../../darwin/lib/research-tasks');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
const CALLBACK_SECRET_HEADER = 'x-hub-control-callback-secret';

function normalizeText(value: unknown) {
  return String(value == null ? '' : value).trim();
}

function parseCsv(value: unknown) {
  return normalizeText(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function getHeader(req: any, name: string) {
  const candidate = req?.headers?.[name]
    ?? req?.headers?.[name.toLowerCase()]
    ?? req?.get?.(name)
    ?? req?.get?.(name.toLowerCase());
  return normalizeText(Array.isArray(candidate) ? candidate[0] : candidate);
}

function safeEqual(expected: string, actual: string) {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function extractActor(req: any) {
  const callbackQuery = req?.body?.callback_query || {};
  const from = req?.body?.from || callbackQuery.from || {};
  const message = req?.body?.message || callbackQuery.message || {};
  return {
    id: normalizeText(from.id),
    username: normalizeText(from.username).replace(/^@+/, '').toLowerCase(),
    chatId: normalizeText(message?.chat?.id),
  };
}

function validateDarwinCallbackEnvelope(req: any, source: NodeJS.ProcessEnv = process.env) {
  const configuredSecret = normalizeText(source.HUB_CONTROL_CALLBACK_SECRET);
  if (!configuredSecret) return { ok: false, status: 503, error: 'darwin_callback_secret_not_configured' };
  const providedSecret = getHeader(req, CALLBACK_SECRET_HEADER);
  if (!providedSecret || !safeEqual(configuredSecret, providedSecret)) {
    return { ok: false, status: 403, error: 'darwin_callback_untrusted_source' };
  }

  const actor = extractActor(req);
  const allowedIds = parseCsv(source.HUB_CONTROL_APPROVER_IDS);
  const allowedUsernames = parseCsv(source.HUB_CONTROL_APPROVER_USERNAMES)
    .map((item) => item.replace(/^@+/, '').toLowerCase());
  if (allowedIds.length === 0 && allowedUsernames.length === 0) {
    return { ok: false, status: 503, error: 'darwin_callback_approver_not_configured', actor };
  }
  if (!allowedIds.includes(actor.id) && !allowedUsernames.includes(actor.username)) {
    return { ok: false, status: 403, error: 'darwin_callback_actor_not_allowed', actor };
  }

  const expectedChatId = normalizeText(source.HUB_CONTROL_APPROVAL_CHAT_ID || source.TELEGRAM_GROUP_ID);
  if (expectedChatId && actor.chatId !== expectedChatId) {
    return { ok: false, status: 403, error: 'darwin_callback_chat_not_allowed', actor };
  }
  return { ok: true, status: 200, actor };
}

function implementationBranch(proposalId: string) {
  return `darwin/${proposalId.replace(/[^A-Za-z0-9._/-]+/g, '-').slice(0, 96)}`;
}

function skillTaskId(parentTaskId: string) {
  const safeParent = parentTaskId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 38);
  const digest = crypto.createHash('sha256').update(parentTaskId).digest('hex').slice(0, 10);
  return `SKILL-${safeParent}-${digest}`;
}

function readTelegramToken() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return store?.darwin?.telegram_bot_token
      || store?.telegram?.darwin_bot_token
      || store?.telegram?.bot_token
      || store?.reservation?.telegram_bot_token
      || process.env.DARWIN_TELEGRAM_BOT_TOKEN
      || '';
  } catch {
    return process.env.DARWIN_TELEGRAM_BOT_TOKEN || '';
  }
}

async function answerCallbackQuery(callbackQueryId: string | null, text: string) {
  const botToken = readTelegramToken();
  if (!callbackQueryId || !botToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: String(text || '').slice(0, 180),
        show_alert: false,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error: any) {
    console.warn(`[darwin-callback] answerCallbackQuery 실패: ${error.message}`);
  }
}

export async function darwinCallbackRoute(req: any, res: any) {
  const callbackData = req.body?.callback_data || req.body?.callback_query?.data || '';
  const callbackQueryId = req.body?.callback_query_id || req.body?.callback_query?.id || null;

  if (!callbackData) {
    return res.status(400).json({ ok: false, error: 'callback_data required' });
  }

  const envelope = validateDarwinCallbackEnvelope(req);
  if (!envelope.ok) {
    return res.status(envelope.status).json({ ok: false, error: envelope.error });
  }

  const parts = String(callbackData).split(':');
  if (parts.length !== 2) {
    return res.status(400).json({ ok: false, error: 'invalid callback_data format' });
  }

  const action = String(parts[0] || '').trim();
  const proposalId = String(parts[1] || '').trim();
  const allowedActions = new Set([
    'darwin_approve',
    'darwin_reject',
    'darwin_manual',
    'darwin_merge',
    'darwin_merge_skill',
    'darwin_create_skill',
    'darwin_skip_skill',
    'darwin_feedback_up',
    'darwin_feedback_down',
  ]);

  if (!allowedActions.has(action)) {
    return res.status(400).json({ ok: false, error: `unknown action: ${action}` });
  }

  try {
    proposalStore.validateProposalId(proposalId);
  } catch {
    return res.status(400).json({ ok: false, error: 'proposalId required' });
  }

  try {
    if (action === 'darwin_merge' || action === 'darwin_merge_skill') {
      return res.status(409).json({ ok: false, error: 'direct_main_merge_retired' });
    }

    if (action === 'darwin_approve') {
      const proposal = proposalStore.loadProposal(proposalId);
      if (!proposal) return res.status(404).json({ ok: false, error: 'proposal not found' });
      const state = proposalStore.normalizeProposalState(proposal.status);
      if (state !== 'proposed') {
        return res.status(409).json({ ok: false, error: `proposal_not_proposed:${state}` });
      }
      const now = new Date().toISOString();
      proposalStore.transitionProposal(proposalId, 'implementing', {
        reason: 'master_approved',
        approved_at: now,
        implementation_queued_at: now,
        branch: implementationBranch(proposalId),
      });
      await answerCallbackQuery(callbackQueryId, '승인 완료! edison이 구현을 시작합니다.');
      const implementor = require('../../../darwin/lib/implementor');
      setImmediate(() => {
        Promise.resolve(implementor.triggerImplementation(proposalId)).catch((error: any) => {
          autonomyLevel.recordError(error);
          console.error(`[darwin-callback] 구현 시작 실패 (${proposalId}): ${error.message}`);
        });
      });
      return res.json({ ok: true, action: 'approved', proposalId });
    }

    if (action === 'darwin_reject') {
      const proposal = proposalStore.loadProposal(proposalId);
      if (!proposal) return res.status(404).json({ ok: false, error: 'proposal not found' });
      const state = proposalStore.normalizeProposalState(proposal.status);
      if (state === 'archived' || state === 'adopted') {
        return res.status(409).json({ ok: false, error: `proposal_terminal:${state}` });
      }
      proposalStore.transitionProposal(proposalId, 'archived', {
        reason: 'master_rejected',
        rejected_at: new Date().toISOString(),
      });
      await answerCallbackQuery(callbackQueryId, '거절 처리되었습니다.');
      return res.json({ ok: true, action: 'rejected', proposalId });
    }

    if (action === 'darwin_manual') {
      const proposal = proposalStore.loadProposal(proposalId);
      if (!proposal) return res.status(404).json({ ok: false, error: 'proposal not found' });
      const state = proposalStore.normalizeProposalState(proposal.status);
      if (state === 'archived' || state === 'adopted') {
        return res.status(409).json({ ok: false, error: `proposal_terminal:${state}` });
      }
      proposalStore.transitionProposal(proposalId, 'archived', {
        reason: 'manual_review',
        manual_review_at: new Date().toISOString(),
      });
      await answerCallbackQuery(callbackQueryId, '수동 검토 대상으로 전환했습니다.');
      return res.json({ ok: true, action: 'manual_review', proposalId });
    }

    if (action === 'darwin_create_skill') {
      const parentTask = await researchTasks.loadTask(proposalId);
      if (!parentTask?.result) {
        return res.status(404).json({ ok: false, error: 'parent task result missing' });
      }
      const repoName = String(
        parentTask.result?.repoInfo?.name
        || [parentTask.target?.owner, parentTask.target?.repo].filter(Boolean).join('/')
        || ''
      );
      if (!repoName) {
        return res.status(400).json({ ok: false, error: 'repo name missing' });
      }
      const repoPart = repoName.split('/')[1] || repoName;
      const taskId = skillTaskId(proposalId);
      const newTask = researchTasks.createTask({
        id: taskId,
        title: `${repoName} 패턴 → 스킬 생성 (마스터 승인!)`,
        type: 'skill_creation',
        target: parentTask.target,
        description: '마스터 승인으로 강제 생성.',
        assignee: 'edison',
        priority: 2,
        source: { type: 'master_approved', parent_task: proposalId },
        targetCategory: 'shared',
        skillName: repoPart.toLowerCase().replace(/[^a-z0-9-]/g, '-') + '-patterns',
      });
      await answerCallbackQuery(callbackQueryId, '스킬 과제를 생성했습니다.');
      await publishToWebhook({
        event: {
          from_bot: 'darwin-callback',
          team: 'darwin',
          event_type: 'skill_task_created',
          alert_level: 1,
          message: `✅ 마스터 승인! 스킬 과제 생성\n🧠 ${newTask.id}`,
        },
      });
      return res.json({ ok: true, action: 'skill_task_created', proposalId, taskId: newTask.id });
    }

    if (action === 'darwin_skip_skill') {
      await answerCallbackQuery(callbackQueryId, '스킬 과제를 건너뜁니다.');
      await publishToWebhook({
        event: {
          from_bot: 'darwin-callback',
          team: 'darwin',
          event_type: 'skill_task_skipped',
          alert_level: 1,
          message: `⏭ 스킬 과제 건너뜀: ${proposalId}`,
        },
      });
      return res.json({ ok: true, action: 'skill_task_skipped', proposalId });
    }

    if (action === 'darwin_feedback_up' || action === 'darwin_feedback_down') {
      const score = action === 'darwin_feedback_up' ? 1 : -1;
      const label = action === 'darwin_feedback_up' ? '유익함' : '아쉬움';
      const eventId = Number.parseInt(proposalId, 10);
      if (!Number.isInteger(eventId) || eventId <= 0) {
        return res.status(400).json({ ok: false, error: 'valid event id required' });
      }
      const updated = await eventLake.addFeedback(eventId, {
        score,
        feedback: label,
      });
      if (!updated) {
        return res.status(404).json({ ok: false, error: 'event not found' });
      }
      await answerCallbackQuery(callbackQueryId, `피드백 기록: ${label}`);
      return res.json({ ok: true, action: 'feedback_recorded', eventId, score });
    }
  } catch (error: any) {
    autonomyLevel.recordError(error);
    console.error('[darwin-callback] 오류:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports.validateDarwinCallbackEnvelope = validateDarwinCallbackEnvelope;
