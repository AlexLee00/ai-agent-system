// @ts-nocheck
export {
  SYMPHONY_A2A_SKILLS,
  SYMPHONY_FILESYSTEM_SKILLS,
} from './symphony-common.ts';
export { registerDispatchTicketSkill, runDispatchTicket } from './dispatch-ticket.ts';
export { registerPollTasksSkill, runPollTasks } from './poll-tasks.ts';
export { registerAssignAgentSkill, runAssignAgent } from './assign-agent.ts';
export { registerReportStatusSkill, runReportStatus } from './report-status.ts';
export { registerSyncGithubSkill, runSyncGithub } from './sync-github.ts';
export { registerHermesLearnSkill, runHermesLearn } from './hermes-learn.ts';
export { registerSelfHealSkill, runSelfHeal } from './self-heal.ts';
export { registerQualityGateSkill, runQualityGate } from './quality-gate.ts';

import { registerDispatchTicketSkill } from './dispatch-ticket.ts';
import { registerPollTasksSkill } from './poll-tasks.ts';
import { registerAssignAgentSkill } from './assign-agent.ts';
import { registerReportStatusSkill } from './report-status.ts';
import { registerSyncGithubSkill } from './sync-github.ts';
import { registerHermesLearnSkill } from './hermes-learn.ts';
import { registerSelfHealSkill } from './self-heal.ts';
import { registerQualityGateSkill } from './quality-gate.ts';

export function registerSymphonyA2ASkills(): void {
  registerDispatchTicketSkill();
  registerPollTasksSkill();
  registerAssignAgentSkill();
  registerReportStatusSkill();
  registerSyncGithubSkill();
  registerHermesLearnSkill();
  registerSelfHealSkill();
  registerQualityGateSkill();
}
