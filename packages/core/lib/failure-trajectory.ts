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

type ExecutionResult = 'success' | 'failure';

type ExecutionTrajectoryInput = FailureTrajectoryInput & {
  result?: ExecutionResult;
};

type FailureTrajectoryLoopOptions = FailureTrajectoryInput & {
  query?: string;
  limit?: number;
  hintTitle?: string;
};

type FailureTrajectoryLoopContext = {
  hints: ExperienceHit[];
  failureHints: ExperienceHit[];
  successHints: ExperienceHit[];
  hintText: string;
  recordFailure: (overrides?: Partial<FailureTrajectoryInput>) => Promise<{ signature: string; experienceId: unknown; eventId: unknown }>;
  recordSuccess: (overrides?: Partial<FailureTrajectoryInput>) => Promise<{ signature: string; experienceId: unknown; eventId: unknown }>;
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

function buildExecutionContent(summary: FailureTrajectorySummary, result: ExecutionResult): string {
  return [
    `${result} trajectory: ${summary.team}/${summary.agent}/${summary.intent}`,
    summary.command ? `command: ${summary.command}` : '',
    summary.exitCode ? `exit_code: ${summary.exitCode}` : '',
    summary.recoveryResult ? `recovery_result: ${summary.recoveryResult}` : '',
    summary.resolutionHint ? `resolution_hint: ${summary.resolutionHint}` : '',
    summary.testResult ? `test_result: ${summary.testResult}` : '',
    summary.rootCause ? `root_cause: ${summary.rootCause}` : '',
    summary.stderrTail ? `stderr_tail: ${summary.stderrTail}` : '',
    summary.stdoutTail ? `stdout_tail: ${summary.stdoutTail}` : '',
  ].filter(Boolean).join('\n');
}

function formatFailureHints(hints: ExperienceHit[] = [], options: { title?: string; limit?: number } = {}): string {
  if (!Array.isArray(hints) || hints.length === 0) return '';
  const title = normalizeText(options.title, '표준 실패 궤적');
  const limit = Math.max(1, Math.min(Number(options.limit || 3), 10));
  const lines = hints.slice(0, limit).map((hit, index) => {
    const metadata = hit?.metadata || {};
    return [
      `${index + 1}. signature=${String(metadata.signature || 'unknown')}`,
      metadata.root_cause ? `root=${String(metadata.root_cause).slice(0, 180)}` : '',
      metadata.resolution_hint ? `hint=${String(metadata.resolution_hint).slice(0, 240)}` : '',
      metadata.test_result ? `test=${String(metadata.test_result).slice(0, 180)}` : '',
      metadata.stderr_tail ? `stderr=${String(metadata.stderr_tail).slice(0, 180)}` : '',
    ].filter(Boolean).join(' | ');
  });
  return `\n\n[${title}]\n${lines.join('\n')}`;
}

function formatExecutionHints(hints: ExperienceHit[] = [], options: { title?: string; limit?: number } = {}): string {
  if (!Array.isArray(hints) || hints.length === 0) return '';
  const title = normalizeText(options.title, '표준 성공 궤적');
  const limit = Math.max(1, Math.min(Number(options.limit || 3), 10));
  const lines = hints.slice(0, limit).map((hit, index) => {
    const metadata = hit?.metadata || {};
    return [
      `${index + 1}. signature=${String(metadata.signature || 'unknown')}`,
      metadata.recovery_result ? `result=${String(metadata.recovery_result).slice(0, 220)}` : '',
      metadata.resolution_hint ? `hint=${String(metadata.resolution_hint).slice(0, 240)}` : '',
      metadata.test_result ? `test=${String(metadata.test_result).slice(0, 180)}` : '',
      metadata.stdout_tail ? `stdout=${String(metadata.stdout_tail).slice(0, 180)}` : '',
    ].filter(Boolean).join(' | ');
  });
  return `\n\n[${title}]\n${lines.join('\n')}`;
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

async function recordExecutionTrajectory(input: ExecutionTrajectoryInput): Promise<{ signature: string; experienceId: unknown; eventId: unknown }> {
  const result: ExecutionResult = input.result === 'failure' ? 'failure' : 'success';
  const summary = buildFailureTrajectory(input);
  const content = buildExecutionContent(summary, result);
  const details = {
    metadata: summary.metadata,
    kind: 'execution_trajectory',
    result,
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
    response: summary.recoveryResult || summary.resolutionHint || summary.rootCause || summary.stderrTail || `${result} trajectory recorded`,
    result,
    why: result === 'success'
      ? summary.recoveryResult || summary.testResult || summary.resolutionHint || 'execution succeeded'
      : summary.rootCause || summary.testResult || summary.stderrTail || 'execution failed',
    team: summary.team,
    sourceBot: summary.agent,
    details,
    successOnly: false,
  });

  const eventId = await eventLake.record({
    eventType: 'execution_trajectory_recorded',
    team: summary.team,
    botName: summary.agent,
    severity: result === 'success' ? 'info' : 'warn',
    traceId: summary.traceId,
    title: `${summary.intent}:${result}:${summary.signature}`,
    message: content.slice(0, 1000),
    tags: ['execution_trajectory', result, summary.intent, summary.agent],
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

async function searchExecutionHints(query: string, options: { team?: string; agent?: string; intent?: string; result?: ExecutionResult; limit?: number } = {}): Promise<ExperienceHit[]> {
  const team = normalizeText(options.team);
  const intent = normalizeText(options.intent, 'failure_recovery');
  const limit = Math.max(1, Math.min(Number(options.limit || 5), 20));
  const filter: Record<string, unknown> = {
    kind: 'execution_trajectory',
    intent,
  };
  if (options.result) filter.result = options.result;
  if (team) filter.team = team;
  if (options.agent) filter.agent = normalizeText(options.agent);

  return rag.search('experience', query, {
    limit,
    filter,
  }) as Promise<ExperienceHit[]>;
}

async function prepareFailureTrajectoryLoop(options: FailureTrajectoryLoopOptions): Promise<FailureTrajectoryLoopContext> {
  const team = normalizeText(options.team, 'general');
  const agent = normalizeText(options.agent, 'unknown');
  const intent = normalizeText(options.intent, 'failure_recovery');
  const query = normalizeText(
    options.query,
    [
      normalizeCommand(options.command),
      normalizeText(options.rootCause),
      normalizeText(options.stderr),
      normalizeText(options.testResult),
    ].filter(Boolean).join('\n') || intent,
  ).slice(0, 4000);

  let hints: ExperienceHit[] = [];
  try {
    hints = await searchFailureHints(query, {
      team,
      agent,
      intent,
      limit: options.limit || 3,
    });
  } catch {
    hints = [];
  }

  let successHints: ExperienceHit[] = [];
  try {
    successHints = await searchExecutionHints(query, {
      team,
      agent,
      intent,
      result: 'success',
      limit: options.limit || 3,
    });
  } catch {
    successHints = [];
  }

  const failureHintText = formatFailureHints(hints, {
    title: options.hintTitle,
    limit: options.limit,
  });
  const successHintText = formatExecutionHints(successHints, {
    limit: options.limit,
  });

  return {
    hints,
    failureHints: hints,
    successHints,
    hintText: `${failureHintText}${successHintText}`,
    recordFailure: (overrides: Partial<FailureTrajectoryInput> = {}) => recordFailureTrajectory({
      ...options,
      ...overrides,
      team,
      agent,
      intent,
      metadata: {
        ...(options.metadata || {}),
        ...(overrides.metadata || {}),
        failure_hint_count: hints.length,
        success_hint_count: successHints.length,
        failure_loop_applied: true,
      },
    }),
    recordSuccess: (overrides: Partial<FailureTrajectoryInput> = {}) => recordExecutionTrajectory({
      ...options,
      ...overrides,
      result: 'success',
      team,
      agent,
      intent,
      metadata: {
        ...(options.metadata || {}),
        ...(overrides.metadata || {}),
        failure_hint_count: hints.length,
        success_hint_count: successHints.length,
        execution_loop_applied: true,
      },
    }),
  };
}

const prepareExecutionTrajectoryLoop = prepareFailureTrajectoryLoop;

export = {
  buildFailureTrajectory,
  formatExecutionHints,
  formatFailureHints,
  prepareExecutionTrajectoryLoop,
  prepareFailureTrajectoryLoop,
  recordExecutionTrajectory,
  recordFailureTrajectory,
  searchExecutionHints,
  searchFailureHints,
  _testOnly_signatureFor: signatureFor,
};
