'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../../packages/core/lib/env');
const proposalStore = require('../../../orchestrator/lib/research/proposal-store');
const autonomyLevel = require('../../../orchestrator/lib/research/autonomy-level');
const researchTasks = require('../../../orchestrator/lib/research/research-tasks');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

function _readTelegramToken() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return store?.telegram?.bot_token || store?.reservation?.telegram_bot_token || '';
  } catch {
    return '';
  }
}

async function _answerCallbackQuery(callbackQueryId, text) {
  const botToken = _readTelegramToken();
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
  } catch (error) {
    console.warn(`[darwin-callback] answerCallbackQuery 실패: ${error.message}`);
  }
}

async function darwinCallbackRoute(req, res) {
  const callbackData = req.body?.callback_data || req.body?.callback_query?.data || '';
  const callbackQueryId = req.body?.callback_query_id || req.body?.callback_query?.id || null;

  if (!callbackData) {
    return res.status(400).json({ ok: false, error: 'callback_data required' });
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
  ]);

  if (!allowedActions.has(action)) {
    return res.status(400).json({ ok: false, error: `unknown action: ${action}` });
  }

  if (!proposalId || proposalId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(proposalId)) {
    return res.status(400).json({ ok: false, error: 'proposalId required' });
  }

  try {
    if (action === 'darwin_approve') {
      proposalStore.updateStatus(proposalId, 'approved', { approved_at: new Date().toISOString() });
      await _answerCallbackQuery(callbackQueryId, '승인 완료! edison이 구현을 시작합니다.');
      const implementor = require('../../../orchestrator/lib/research/implementor');
      setImmediate(() => implementor.triggerImplementation(proposalId));
      return res.json({ ok: true, action: 'approved', proposalId });
    }

    if (action === 'darwin_reject') {
      proposalStore.updateStatus(proposalId, 'rejected', { rejected_at: new Date().toISOString() });
      await _answerCallbackQuery(callbackQueryId, '거절 처리되었습니다.');
      return res.json({ ok: true, action: 'rejected', proposalId });
    }

    if (action === 'darwin_manual') {
      proposalStore.updateStatus(proposalId, 'manual_review', { manual_review_at: new Date().toISOString() });
      await _answerCallbackQuery(callbackQueryId, '수동 검토 대상으로 전환했습니다.');
      return res.json({ ok: true, action: 'manual_review', proposalId });
    }

    if (action === 'darwin_merge') {
      await _answerCallbackQuery(callbackQueryId, '머지를 시작합니다.');
      const verifier = require('../../../orchestrator/lib/research/verifier');
      setImmediate(() => verifier.mergeVerifiedProposal(proposalId));
      return res.json({ ok: true, action: 'merge_started', proposalId });
    }

    if (action === 'darwin_merge_skill') {
      const task = researchTasks.loadTask(proposalId);
      if (!task?.result?.branch) {
        return res.status(404).json({ ok: false, error: 'skill task branch missing' });
      }
      await _answerCallbackQuery(callbackQueryId, '스킬 브랜치 머지를 시작합니다.');
      const verifier = require('../../../orchestrator/lib/research/verifier');
      setImmediate(async () => {
        try {
          await verifier.mergeBranch(task.result.branch, task.id);
          researchTasks.updateTask(task.id, {
            status: 'merged',
            merged_at: new Date().toISOString(),
          });
        } catch (error) {
          researchTasks.updateTask(task.id, {
            status: 'merge_failed',
            merge_error: error.message,
          });
        }
      });
      return res.json({ ok: true, action: 'skill_merge_started', proposalId });
    }
  } catch (error) {
    autonomyLevel.recordError(error);
    console.error('[darwin-callback] 오류:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  darwinCallbackRoute,
};
