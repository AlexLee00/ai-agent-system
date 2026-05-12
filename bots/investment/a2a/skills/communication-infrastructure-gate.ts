// @ts-nocheck
import {
  buildLunaCommunicationInfrastructureReport,
  LUNA_COMMUNICATION_PHASE,
} from '../../shared/luna-communication-infrastructure.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

function broadcastEnabled() {
  return String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

export function createCommunicationInfrastructureGateHandler(options = {}) {
  return async function communicationInfrastructureGate(params = {}) {
    const report = buildLunaCommunicationInfrastructureReport({
      investmentRoot: options.investmentRoot || params.investmentRoot,
      projectRoot: options.projectRoot || params.projectRoot,
    });
    const output = {
      ok: report.ok,
      skill: 'communication-infrastructure-gate',
      phase: LUNA_COMMUNICATION_PHASE,
      shadowMode: true,
      status: report.status,
      a2aSkills: report.summary.a2aSkills,
      checks: report.summary,
      failures: report.failures,
      channels: report.channels,
      broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
      liveMutation: false,
      evidence: {
        source: 'luna_communication_infrastructure_report',
        generatedAt: report.generatedAt,
        broadcastDefault: report.broadcastDefault,
      },
    };
    return {
      status: report.ok ? 'completed' : 'failed',
      output,
      metadata: {
        phase: LUNA_COMMUNICATION_PHASE,
        broadcastEnabled: broadcastEnabled(),
        liveMutation: false,
        protectedPidMutation: false,
      },
      error: report.ok ? undefined : {
        code: -32603,
        message: `communication infrastructure blocked: ${report.failures.map((item) => item.name).join(', ')}`,
      },
    };
  };
}

export function registerCommunicationInfrastructureGateSkill(options = {}) {
  registerSkillHandler('communication-infrastructure-gate', createCommunicationInfrastructureGateHandler(options));
}

export default {
  createCommunicationInfrastructureGateHandler,
  registerCommunicationInfrastructureGateSkill,
};
