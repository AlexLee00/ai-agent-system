const path = require('node:path');
const { canWrite } = require('../../../../packages/core/lib/file-guard.ts');
const { validateToolServerAdmission } = require('./tool-server-attestation');

const RISK_RANK = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const SIDE_EFFECT_RISK = {
  none: 'low',
  read_only: 'low',
  write: 'medium',
  external_mutation: 'high',
};

function text(value, fallback = '') {
  const normalized = String(value == null ? fallback : value).trim();
  return normalized || fallback;
}

function riskRank(value) {
  return RISK_RANK[text(value, 'low').toLowerCase()] || RISK_RANK.low;
}

function deriveWritePaths(input = {}) {
  const candidates = [
    input.file,
    input.filePath,
    input.path,
    input.output,
    input.outputPath,
    input.reportPath,
    input.writePath,
    input.targetPath,
    ...(Array.isArray(input.files) ? input.files : []),
    ...(Array.isArray(input.paths) ? input.paths : []),
    ...(Array.isArray(input.writePaths) ? input.writePaths : []),
  ];
  return [...new Set(candidates.map((candidate) => text(candidate)).filter(Boolean))];
}

function normalizeRisk(tool = {}, input = {}) {
  return text(input.risk || input.riskTier || tool.defaultRisk || SIDE_EFFECT_RISK[tool.sideEffect] || 'low', 'low').toLowerCase();
}

function buildAuditBase(tool = {}, input = {}, context = {}) {
  const agent = text(context.agent || input.agent || input.bot || input.botName, 'unknown');
  const team = text(context.team || input.team || tool.ownerTeam, tool.ownerTeam || 'hub');
  return {
    agent,
    team,
    tool: text(tool.name, 'unknown_tool'),
    sideEffect: text(tool.sideEffect, 'none'),
    risk: normalizeRisk(tool, input),
  };
}

function validateAgentToolAdmission({ tool, input = {}, context = {} }) {
  const audit = buildAuditBase(tool, input, context);
  const attestationDecision = validateToolServerAdmission(tool, {
    attestationId: input.expectedAttestationId || context.expectedAttestationId,
  });

  if (!attestationDecision.ok) {
    return {
      ok: false,
      error: attestationDecision.error,
      detail: attestationDecision.detail || null,
      audit: {
        ...audit,
        decision: 'denied',
        reason: attestationDecision.error,
        attestationId: attestationDecision.attestation?.attestationId || attestationDecision.attestation?.attestation?.attestationId || null,
      },
    };
  }

  const attestationId = attestationDecision.attestation?.attestationId || null;
  const writePaths = deriveWritePaths(input);
  if (!['none', 'read_only'].includes(audit.sideEffect)) {
    for (const writePath of writePaths) {
      if (!canWrite(path.resolve(writePath), audit.agent)) {
        return {
          ok: false,
          error: 'write_scope_violation',
          path: writePath,
          audit: {
            ...audit,
            decision: 'denied',
            reason: 'write_scope_violation',
            writePaths,
            attestationId,
          },
        };
      }
    }
  }

  const maxRisk = text(context.maxRisk || input.maxRisk || '', '').toLowerCase();
  if (maxRisk && riskRank(audit.risk) > riskRank(maxRisk)) {
    return {
      ok: false,
      error: 'agent_tool_risk_exceeds_context',
      audit: {
        ...audit,
        decision: 'denied',
        reason: 'agent_tool_risk_exceeds_context',
        maxRisk,
        attestationId,
      },
    };
  }

  return {
    ok: true,
    audit: {
      ...audit,
      decision: 'allowed',
      reason: 'policy_pass',
      writePaths,
      attestationId,
    },
    attestation: attestationDecision.attestation,
  };
}

async function recordAgentGuardAudit(decision, extra = {}) {
  try {
    const eventLake = require('../../../../packages/core/lib/event-lake');
    const audit = decision?.audit || {};
    return await eventLake.record({
      eventType: 'hub_agent_guard_admission',
      team: audit.team || 'hub',
      botName: audit.agent || 'unknown',
      severity: decision?.ok ? 'info' : 'warn',
      traceId: extra.traceId || '',
      title: decision?.ok ? 'AgentGuard admission allowed' : 'AgentGuard admission denied',
      message: `${audit.tool || 'unknown_tool'} ${audit.decision || 'unknown'}${audit.reason ? `: ${audit.reason}` : ''}`,
      tags: ['agent-guard', audit.decision || 'unknown', audit.sideEffect || 'none'],
      metadata: {
        ...audit,
        error: decision?.error || null,
        detail: decision?.detail || null,
        context: extra.context || null,
      },
    });
  } catch {
    return null;
  }
}

module.exports = {
  deriveWritePaths,
  validateAgentToolAdmission,
  recordAgentGuardAudit,
  _testOnly: {
    riskRank,
    normalizeRisk,
  },
};
