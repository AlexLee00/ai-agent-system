import crypto from 'node:crypto';
import eventLake = require('./event-lake');
import experienceStore = require('./experience-store');
import rag = require('./rag');
import { getTraceId } from './trace';

type FailureTrajectoryInput = {
  team?: string;
  agent?: string;
  intent?: string;
  command?: string | string[];
  exitCode?: number | string | null;
  stdout?: string | null;
  stderr?: string | null;
  diffSummary?: string | null;
  testResult?: string | null;
  recoveryResult?: string | null;
  rootCause?: string | null;
  resolutionHint?: string | null;
  traceId?: string | null;
  incidentKey?: string | null;
  metadata?: Record<string, unknown>;
};

type FailureTrajectorySummary = {
  team: string;
  agent: string;
  intent: string;
  signature: string;
  traceId: string;
  command: string;
  exitCode: string;
  stdoutTail: string;
  stderrTail: string;
  diffSummary: string;
  testResult: string;
  recoveryResult: string;
  rootCause: string;
  resolutionHint: string;
  incidentKey: string;
  metadata: Record<string, unknown>;
};

type ExperienceHit = {
  content?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function normalizeCommand(command: unknown): string {
  if (Array.isArray(command)) return command.map((item) => String(item || '').trim()).filter(Boolean).join(' ');
  return normalizeText(command);
}

function tail(value: unknown, max = 1600): string {
  const text = normalizeText(value);
  if (text.length <= max) return text;
  return text.slice(-max);
}

function signatureFor(summary: Pick<FailureTrajectorySummary, 'team' | 'agent' | 'intent' | 'command' | 'stderrTail' | 'testResult' | 'rootCause'>): string {
  const source = [
    summary.team,
    summary.agent,
    summary.intent,
    summary.command,
    summary.rootCause,
    summary.testResult,
    summary.stderrTail.slice(-500),
  ].join('\n');
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);
}

function buildFailureTrajectory(input: FailureTrajectoryInput): FailureTrajectorySummary {
  const team = normalizeText(input.team, 'general');
  const agent = normalizeText(input.agent, 'unknown');
  const intent = normalizeText(input.intent, 'failure_recovery');
  const summary = {
    team,
    agent,
    intent,
    signature: '',
    traceId: normalizeText(input.traceId || getTraceId() || ''),
    command: normalizeCommand(input.command),
    exitCode: normalizeText(input.exitCode, ''),
    stdoutTail: tail(input.stdout),
    stderrTail: tail(input.stderr),
    diffSummary: tail(input.diffSummary, 2000),
    testResult: tail(input.testResult, 2000),
    recoveryResult: tail(input.recoveryResult, 2000),
    rootCause: tail(input.rootCause, 1000),
    resolutionHint: tail(input.resolutionHint, 1000),
    incidentKey: normalizeText(input.incidentKey),
    metadata: input.metadata || {},
  };
  return {
    ...summary,
    signature: signatureFor(summary),
  };
}

function buildContent(summary: FailureTrajectorySummary): string {
  return [
    `failure trajectory: ${summary.team}/${summary.agent}/${summary.intent}`,
    summary.command ? `command: ${summary.command}` : '',
    summary.exitCode ? `exit_code: ${summary.exitCode}` : '',
    summary.rootCause ? `root_cause: ${summary.rootCause}` : '',
    summary.resolutionHint ? `resolution_hint: ${summary.resolutionHint}` : '',
    summary.testResult ? `test_result: ${summary.testResult}` : '',
    summary.stderrTail ? `stderr_tail: ${summary.stderrTail}` : '',
    summary.stdoutTail ? `stdout_tail: ${summary.stdoutTail}` : '',
  ].filter(Boolean).join('\n');
}

async function recordFailureTrajectory(input: FailureTrajectoryInput): Promise<{ signature: string; experienceId: unknown; eventId: unknown }> {
  const summary = buildFailureTrajectory(input);
  const content = buildContent(summary);
  const details = {
    metadata: summary.metadata,
    kind: 'failure_trajectory',
    team: summary.team,
    agent: summary.agent,
    signature: summary.signature,
    trace_id: summary.traceId,
    command: summary.command,
    exit_code: summary.exitCode,
    stdout_tail: summary.stdoutTail,
    stderr_tail: summary.stderrTail,
    diff_summary: summary.diffSummary,
    test_result: summary.testResult,
    recovery_result: summary.recoveryResult,
    root_cause: summary.rootCause,
    resolution_hint: summary.resolutionHint,
    incident_key: summary.incidentKey,
  };

  const experienceId = await experienceStore.storeExperience({
    userInput: content,
    intent: summary.intent,
    response: summary.resolutionHint || summary.rootCause || summary.stderrTail || 'failure trajectory recorded',
    result: 'failure',
    why: summary.rootCause || summary.testResult || summary.stderrTail || 'failure trajectory',
    team: summary.team,
    sourceBot: summary.agent,
    details,
    successOnly: false,
  });

  const eventId = await eventLake.record({
    eventType: 'failure_trajectory_recorded',
    team: summary.team,
    botName: summary.agent,
    severity: 'warn',
    traceId: summary.traceId,
    title: `${summary.intent}:${summary.signature}`,
    message: content.slice(0, 1000),
    tags: ['failure_trajectory', summary.intent, summary.agent],
    metadata: details,
  });

  return { signature: summary.signature, experienceId, eventId };
}

async function searchFailureHints(query: string, options: { team?: string; agent?: string; intent?: string; limit?: number } = {}): Promise<ExperienceHit[]> {
  const team = normalizeText(options.team);
  const intent = normalizeText(options.intent, 'failure_recovery');
  const limit = Math.max(1, Math.min(Number(options.limit || 5), 20));
  const filter: Record<string, unknown> = {
    kind: 'failure_trajectory',
    result: 'failure',
    intent,
  };
  if (team) filter.team = team;
  if (options.agent) filter.agent = normalizeText(options.agent);

  return rag.search('experience', query, {
    limit,
    filter,
  }) as Promise<ExperienceHit[]>;
}

export = {
  buildFailureTrajectory,
  recordFailureTrajectory,
  searchFailureHints,
  _testOnly_signatureFor: signatureFor,
};
