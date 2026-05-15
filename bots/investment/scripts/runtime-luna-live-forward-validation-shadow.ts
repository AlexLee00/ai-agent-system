#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { callViaHub } from '../shared/hub-llm-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaPhase4LiveForwardRows,
  ensureLunaPhase4Schema,
  fixturePhase4Inputs,
  insertLunaPhase4LiveForwardShadow,
  loadLunaPhase4Inputs,
} from '../shared/luna-phase4-live-forward.ts';

const CONFIRM = 'luna-phase4-live-forward-shadow';

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function redact(value) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
    .replace(/(token|secret|password|api[_-]?key)[=:][A-Za-z0-9._:-]{8,}/gi, '$1=***')
    .slice(0, 800);
}

function parseLlmJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fenced ? fenced[1] : raw;
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body.slice(0, 1200) };
  }
}

async function maybeAttachHubJudge(rows, { maxLlmCalls = 0, timeoutMs = 12_000 } = {}) {
  const limit = Math.max(0, Number(maxLlmCalls || 0));
  if (limit <= 0) return rows;

  const selected = rows.slice(0, limit);
  for (const row of selected) {
    try {
      const result = await callViaHub(
        'luna.phase4.live_forward',
        [
          '너는 Luna Phase 4 live-forward validation shadow judge다.',
          '실거래 실행, 주문, 설정 변경을 제안하지 말고 shadow 검증 의견만 JSON으로 답한다.',
          'JSON keys: verdict, confidence, risk_notes, promotion_blockers.',
        ].join('\n'),
        JSON.stringify({
          symbol: row.symbol,
          market: row.market,
          amaScore: row.amaScore,
          finsaberScore: row.finsaberScore,
          regimeRiskScore: row.regimeRiskScore,
          reasons: row.reasons,
          evidence: row.evidence?.components || {},
        }),
        {
          symbol: row.symbol,
          market: row.market,
          taskType: 'luna_phase4_live_forward_shadow',
          urgency: 'low',
          maxTokens: 500,
          timeoutMs,
        },
      );
      row.evidence.llmGateway = {
        route: 'hub',
        status: result.ok ? 'ok' : 'failed',
        provider: result.provider || 'hub',
        latencyMs: result.latencyMs || 0,
        costUsd: result.costUsd || 0,
        directProviderCall: false,
        error: result.ok ? null : redact(result.error || 'unknown'),
        judge: result.ok ? parseLlmJson(result.text) : null,
      };
    } catch (error) {
      row.evidence.llmGateway = {
        route: 'hub',
        status: 'failed',
        directProviderCall: false,
        error: redact(error?.message || error),
      };
    }
  }
  return rows;
}

export async function runLunaLiveForwardValidationShadow(options = {}, deps = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const fixture = options.fixture === true;
  const json = options.json === true;
  const confirm = String(options.confirm || '');
  const market = options.market || null;
  const limit = Math.max(1, Number(options.limit || process.env.LUNA_PHASE4_LIVE_FORWARD_LIMIT || 50));
  const maxLlmCalls = Math.max(0, Number(options.maxLlmCalls || 0));

  if (apply && options.dryRun === true) {
    throw new Error('runtime:luna-live-forward-validation-shadow cannot combine --apply with --dry-run');
  }
  if (apply && confirm !== CONFIRM) {
    throw new Error(`runtime:luna-live-forward-validation-shadow apply requires --confirm=${CONFIRM}`);
  }

  const inputs = fixture
    ? fixturePhase4Inputs()
    : deps.loadInputs
      ? await deps.loadInputs({ limit, market })
      : await loadLunaPhase4Inputs({ limit, market });
  let rows = buildLunaPhase4LiveForwardRows(inputs, { llmEnabled: maxLlmCalls > 0 });
  rows = await maybeAttachHubJudge(rows, { maxLlmCalls });

  if (apply && !dryRun && rows.length > 0) {
    if (deps.ensureSchema) await deps.ensureSchema();
    else {
      await db.initSchema();
      await ensureLunaPhase4Schema();
    }
    for (const row of rows) {
      if (deps.insertRow) await deps.insertRow(row);
      else await insertLunaPhase4LiveForwardShadow(row);
    }
  }

  const summary = {
    total: rows.length,
    shadowPass: rows.filter((row) => row.liveForwardStatus === 'shadow_pass').length,
    shadowHold: rows.filter((row) => row.liveForwardStatus !== 'shadow_pass').length,
    hyperoptRequired: rows.filter((row) => row.hyperoptRequired === true).length,
    llmCallsAttempted: Math.min(maxLlmCalls, rows.length),
    liveMutation: false,
  };

  const payload = {
    ok: true,
    status: apply ? 'luna_phase4_live_forward_shadow_written' : 'luna_phase4_live_forward_shadow_planned',
    phase: 'luna_phase4_codex_p2',
    task: 'ama_finsaber_live_forward_validation',
    dryRun,
    apply,
    fixture,
    writeMode: apply ? 'shadow-apply' : 'plan-only',
    shadowMode: true,
    confirmToken: CONFIRM,
    market: market || 'all',
    summary,
    rows,
  };
  if (!json) {
    console.log(`[luna-phase4-live-forward] ${payload.status} total=${summary.total} pass=${summary.shadowPass} hold=${summary.shadowHold}`);
  }
  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaLiveForwardValidationShadow({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      fixture: hasFlag('fixture'),
      limit: Number(argValue('limit', process.env.LUNA_PHASE4_LIVE_FORWARD_LIMIT || 50)),
      market: argValue('market', null),
      confirm: argValue('confirm', ''),
      maxLlmCalls: Number(argValue('max-llm-calls', 0)),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-live-forward-validation-shadow error:',
  });
}
