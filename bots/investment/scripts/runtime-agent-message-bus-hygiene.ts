#!/usr/bin/env node
// @ts-nocheck

import { expireStaleAgentMessages, getMessageBusHygiene } from '../shared/agent-message-bus.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildAgentMessageBusHygienePlan, classifyAgentMessageBusHygiene } from '../shared/luna-operational-closure-pack.ts';
import { buildEvidenceHash } from '../shared/luna-reconcile-evidence-pack.ts';
import { buildLunaDelegatedAuthorityDecision } from '../shared/luna-delegated-authority.ts';

const SAFE_CONFIRM = 'luna-agent-bus-hygiene';
const REVIEW_CONFIRM = 'luna-agent-bus-review-archive';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    staleHours: Math.max(1, Number(argv.find((arg) => arg.startsWith('--stale-hours='))?.split('=')[1] || 24) || 24),
    limit: Math.max(1, Math.min(500, Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 100) || 100)),
    incidentKeyPrefix: argv.find((arg) => arg.startsWith('--incident-prefix='))?.split('=')[1] || '',
    apply: argv.includes('--apply'),
    dryRun: argv.includes('--dry-run') || !argv.includes('--apply'),
    includeReviewRequired: argv.includes('--include-review-required'),
    json: argv.includes('--json'),
    confirm: argv.find((arg) => arg.startsWith('--confirm='))?.split('=')[1] || null,
  };
}

export async function runAgentMessageBusHygiene(args = {}) {
  const staleHours = Math.max(1, Number(args.staleHours || 24) || 24);
  const limit = Math.max(1, Math.min(500, Number(args.limit || 100) || 100));
  const before = await getMessageBusHygiene({ staleHours, limit });
  const includeReviewRequired = args.includeReviewRequired === true;
  const requiredConfirm = includeReviewRequired ? REVIEW_CONFIRM : SAFE_CONFIRM;
  const delegatedAuthority = buildLunaDelegatedAuthorityDecision({
    action: 'safe_maintenance_apply',
    finalGate: {
      ok: includeReviewRequired !== true,
      blockers: includeReviewRequired ? ['review_required_bus_archive_not_delegable'] : [],
    },
  });
  if (args.apply === true && args.confirm !== requiredConfirm && delegatedAuthority.canSelfApprove !== true) {
    const result = {
      ok: false,
      status: 'agent_message_bus_hygiene_confirm_required',
      staleHours,
      includeReviewRequired,
      delegatedAuthority,
      before,
      action: {
        ok: false,
        dryRun: true,
        staleHours,
        candidates: 0,
        expired: 0,
        safeOnly: !includeReviewRequired,
        error: `confirm_required:${requiredConfirm}`,
      },
      after: before,
    };
    result.plan = buildAgentMessageBusHygienePlan(result);
    return result;
  }
  const action = await expireStaleAgentMessages({
    staleHours,
    limit,
    incidentKeyPrefix: args.incidentKeyPrefix || '',
    dryRun: args.apply !== true,
    safeOnly: !includeReviewRequired,
  });
  const after = args.apply === true ? await getMessageBusHygiene({ staleHours, limit }) : before;
  const classification = classifyAgentMessageBusHygiene({ ok: before.ok, before, action });
  const reviewRows = (classification.rows || []).filter((row) => row.hygieneClass === 'review_required');
  const reviewReport = {
    status: reviewRows.length > 0 ? 'operator_review_required' : 'clear',
    safeOnly: !includeReviewRequired,
    includeReviewRequired,
    reviewRequired: Number(classification.reviewRequired || 0),
    safeExpire: Number(classification.safeExpire || 0),
    blocked: Number(classification.blocked || 0),
    rows: reviewRows.map((row) => ({
      toAgent: row.to_agent || row.toAgent || null,
      messageType: row.message_type || row.messageType || null,
      staleCount: Number(row.staleCount || row.stale_count || 0),
      oldestCreatedAt: row.oldest_created_at || row.oldestCreatedAt || null,
      reason: row.reason || null,
    })),
  };
  reviewReport.evidenceHash = buildEvidenceHash({
    type: 'agent_message_bus_review_report',
    staleHours,
    reviewRequired: reviewReport.reviewRequired,
    rows: reviewReport.rows,
  });
  const status = action.expired > 0
    ? 'agent_message_bus_stale_expired'
    : Number(classification.reviewRequired || 0) > 0
      ? 'agent_message_bus_review_required'
      : Number(classification.blocked || 0) > 0
        ? 'agent_message_bus_hygiene_blocked'
        : Number(before.staleCount || 0) > 0
          ? 'agent_message_bus_safe_expire_available'
          : 'agent_message_bus_hygiene_clear';
  const result = {
    ok: before.ok !== false && action.ok !== false,
    status,
    staleHours,
    includeReviewRequired,
    delegatedAuthority,
    before,
    action,
    after,
    reviewReport,
  };
  result.plan = buildAgentMessageBusHygienePlan(result);

  if (args.apply === true) {
    await db.run(
      `INSERT INTO investment.mapek_knowledge (event_type, payload)
       VALUES ($1, $2::jsonb)`,
      [
        'agent_message_bus_hygiene_audit',
        JSON.stringify({
          staleHours,
          limit,
          staleBefore: before.staleCount || 0,
          expired: action.expired || 0,
          confirmed: true,
          approvalSource: args.confirm === requiredConfirm ? 'operator_confirm' : delegatedAuthority.approvalSource,
          includeReviewRequired,
          appliedAt: new Date().toISOString(),
        }),
      ],
    ).catch(() => {});
  }

  if (!args.suppressAlert && (args.apply === true || Number(before.staleCount || 0) > 0)) {
    await publishAlert({
      from_bot: 'luna',
      event_type: 'agent_message_bus_hygiene',
      alert_level: Number(before.staleCount || 0) > 0 ? 1 : 0,
      message: [
        '🧹 Luna Agent message bus hygiene',
        `status=${result.status}`,
        `stale_before=${before.staleCount || 0}, expired=${action.expired || 0}`,
      ].join('\n'),
      payload: result,
    }).catch(() => false);
  }

  return result;
}

async function main() {
  const args = parseArgs();
  const result = await runAgentMessageBusHygiene(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.status} stale_before=${result.before?.staleCount || 0} expired=${result.action?.expired || 0}`);
  return result;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-agent-message-bus-hygiene 실패:',
  });
}
