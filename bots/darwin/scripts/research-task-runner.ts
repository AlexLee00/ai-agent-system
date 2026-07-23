'use strict';

const tasks = require('../lib/research-tasks');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const autonomyLevel = require('../lib/autonomy-level');
const { assertOpsRootOnMain } = require('../lib/ops-root-guard');

interface AlarmPayload {
  message: string;
  team: string;
  fromBot: string;
  inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>> | null;
}

interface RunnerOptions {
  dryRun?: boolean;
  json?: boolean;
}

interface AlarmResult {
  ok?: boolean;
}

interface TaskTarget {
  owner: string;
  repo: string;
}

interface ResearchTask {
  id: string;
  type: 'github_analysis' | 'skill_creation' | string;
  title: string;
  target: TaskTarget;
  stale_recovered?: boolean;
}

interface GitHubAnalysisResult {
  repoInfo: {
    stars: number;
  };
  structure: {
    totalFiles: number;
  };
}

interface SkillCreationResult {
  syntaxOk: boolean;
  branch?: string | null;
  skillPath: string;
  linesOfCode: number;
}

interface TaskModule {
  ensureTaskStatusSchema(): Promise<void>;
  getPendingTasks(options?: { skipRuntimeStatus?: boolean; includeStaleRunning?: boolean }): Promise<ResearchTask[]>;
  executeGitHubAnalysis(task: ResearchTask): Promise<GitHubAnalysisResult>;
  autoCreateSkillTaskFromAnalysis(result: GitHubAnalysisResult, taskId: string): ResearchTask | null;
  executeSkillCreation(task: ResearchTask): Promise<SkillCreationResult>;
}

interface AutonomyLevelModule {
  requiresApproval(): boolean;
}

const tasksTyped: TaskModule = tasks;
const autonomyLevelTyped: AutonomyLevelModule = autonomyLevel;

const MAX_TASKS_PER_RUN = 3;

function parseArgs(argv: string[]): RunnerOptions {
  return {
    dryRun: argv.includes('--dry-run') || process.env.DARWIN_TASK_RUNNER_DRY_RUN === '1',
    json: argv.includes('--json') || process.env.DARWIN_TASK_RUNNER_JSON === '1',
  };
}

function log(options: RunnerOptions, message: string): void {
  if (!options.json) console.log(message);
}

function toErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { stderr?: unknown; stdout?: unknown; message?: unknown; stack?: unknown };
    return String(maybe.stderr || maybe.stdout || maybe.message || maybe.stack || 'unknown error');
  }
  return String(error || 'unknown error');
}

async function runMain() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.dryRun) {
    await tasksTyped.ensureTaskStatusSchema();
  }
  const pending = await tasksTyped.getPendingTasks(
    options.dryRun ? { skipRuntimeStatus: true } : { includeStaleRunning: true },
  );
  const staleRecovered = pending.filter((task) => task.stale_recovered === true).length;
  if (pending.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({
        ok: true,
        dryRun: Boolean(options.dryRun),
        pending: 0,
        runnable: 0,
        executed: 0,
        alarmSent: 0,
        gitMutations: 0,
        staleRecovered: 0,
      }, null, 2));
      return;
    }
    console.log('[task-runner] 대기 중인 과제 없음');
    return;
  }

  const runnable = pending.slice(0, MAX_TASKS_PER_RUN);
  log(options, `[task-runner] 대기 과제 ${pending.length}건, 이번 실행 ${runnable.length}건 (최대 ${MAX_TASKS_PER_RUN}건)`);
  const summary = {
    ok: true,
    dryRun: Boolean(options.dryRun),
    pending: pending.length,
    runnable: runnable.length,
    executed: 0,
    alarmSent: 0,
    gitMutations: 0,
    staleRecovered,
    planned: runnable.map((task) => ({
      id: task.id,
      type: task.type,
      title: task.title,
      target: task.target || null,
      staleRecovered: task.stale_recovered === true,
    })),
    failures: [] as Array<{ id: string; error: string }>,
  };

  if (options.dryRun) {
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else {
      log(options, '[task-runner][dry-run] 실제 과제 실행/알림/git 변경 없이 계획만 출력');
      for (const item of summary.planned) {
        log(options, `- ${item.id} (${item.type}) ${item.title}`);
      }
    }
    return;
  }

  for (const task of runnable) {
    console.log(`[task-runner] 실행: ${task.id} (${task.type})`);

    try {
      if (task.type === 'github_analysis') {
        const result = await tasksTyped.executeGitHubAnalysis(task);
        const spawnedSkillTask = tasksTyped.autoCreateSkillTaskFromAnalysis(result, task.id);

        await postAlarm({
          message: `📊 연구 과제 완료!\n📋 ${task.title}\n🔗 ${task.target.owner}/${task.target.repo}\n⭐ ${result.repoInfo.stars} | 📂 ${result.structure.totalFiles}파일\n📝 분석 문서 자동 생성!\n${spawnedSkillTask ? `🧠 후속 스킬 과제 생성: ${spawnedSkillTask.id}` : '🧠 후속 과제 없음 (조건 미충족)'}`,
          team: 'darwin',
          fromBot: 'task-runner',
          inlineKeyboard: !spawnedSkillTask && autonomyLevelTyped.requiresApproval() ? [[
            { text: '🧠 스킬 과제 생성', callback_data: `darwin_create_skill:${task.id}` },
            { text: '⏭ 건너뜀', callback_data: `darwin_skip_skill:${task.id}` },
          ]] : null,
        } as AlarmPayload);
        summary.alarmSent += 1;
        summary.executed += 1;
        continue;
      }

      if (task.type === 'skill_creation') {
        const result = await tasksTyped.executeSkillCreation(task);

        await postAlarm({
          message: `🧠 스킬 자동 생성 ${result.syntaxOk ? '✅' : '❌'}!\n📋 ${task.title}\n📂 ${result.skillPath}\n📊 ${result.linesOfCode}줄\n✅ 문법: ${result.syntaxOk ? '통과' : '실패'}\n${result.branch ? `🌿 검증 브랜치: ${result.branch}` : ''}`,
          team: 'darwin',
          fromBot: 'task-runner',
          inlineKeyboard: null,
        } as AlarmPayload);
        summary.alarmSent += 1;
        summary.executed += 1;
        continue;
      }

      console.log(`[task-runner] 미지원 과제 타입 스킵: ${task.type}`);
    } catch (err) {
      const errorMessage = toErrorMessage(err);
      console.error(`[task-runner] 과제 실패 (${task.id}): ${errorMessage}`);
      summary.ok = false;
      summary.failures.push({ id: task.id, error: errorMessage.slice(0, 500) });
      await postAlarm({
        message: `❌ 연구 과제 실패: ${task.id}\n${errorMessage}`,
        team: 'darwin',
        fromBot: 'task-runner',
      } as AlarmPayload);
      summary.alarmSent += 1;
    }
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  }
}

async function main() {
  assertOpsRootOnMain({ context: 'research-task-runner:start' });
  try {
    await runMain();
  } finally {
    assertOpsRootOnMain({ context: 'research-task-runner:end' });
  }
}

main().catch((error) => {
  console.error(toErrorMessage(error));
  process.exit(1);
});
