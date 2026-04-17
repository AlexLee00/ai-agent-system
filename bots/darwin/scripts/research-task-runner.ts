'use strict';

const tasks = require('../lib/research-tasks');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');

const MAX_TASKS_PER_RUN = 3;

async function main() {
  await tasks.ensureTaskStatusSchema();
  const pending = await tasks.getPendingTasks();
  if (pending.length === 0) {
    console.log('[task-runner] 대기 중인 과제 없음');
    return;
  }

  const runnable = pending.slice(0, MAX_TASKS_PER_RUN);
  console.log(`[task-runner] 대기 과제 ${pending.length}건, 이번 실행 ${runnable.length}건 (최대 ${MAX_TASKS_PER_RUN}건)`);

  for (const task of runnable) {
    console.log(`[task-runner] 실행: ${task.id} (${task.type})`);

    try {
      if (task.type === 'github_analysis') {
        const result = await tasks.executeGitHubAnalysis(task);
        const spawnedSkillTask = tasks.autoCreateSkillTaskFromAnalysis(result, task.id);

        await postAlarm({
          message: `📊 연구 과제 완료!\n📋 ${task.title}\n🔗 ${task.target.owner}/${task.target.repo}\n⭐ ${result.repoInfo.stars} | 📂 ${result.structure.totalFiles}파일\n📝 분석 문서 자동 생성!\n${spawnedSkillTask ? `🧠 후속 스킬 과제 생성: ${spawnedSkillTask.id}` : '🧠 후속 과제 없음 (조건 미충족)'}`,
          team: 'darwin',
          fromBot: 'task-runner',
          inlineKeyboard: !spawnedSkillTask ? [[
            { text: '🧠 스킬 과제 생성', callback_data: `darwin_create_skill:${task.id}` },
            { text: '⏭ 건너뜀', callback_data: `darwin_skip_skill:${task.id}` },
          ]] : null,
        });
        continue;
      }

      if (task.type === 'skill_creation') {
        const result = await tasks.executeSkillCreation(task);
        await postAlarm({
          message: `🧠 스킬 자동 생성 ${result.syntaxOk ? '✅' : '❌'}!\n📋 ${task.title}\n📂 ${result.skillPath}\n📊 ${result.linesOfCode}줄\n✅ 문법: ${result.syntaxOk ? '통과' : '실패'}\n${result.branch ? `🌿 검증 브랜치: ${result.branch}` : ''}`,
          team: 'darwin',
          fromBot: 'task-runner',
          inlineKeyboard: result.syntaxOk ? [[
            { text: '✅ 머지 승인', callback_data: `darwin_merge_skill:${task.id}` },
            { text: '📝 수동 검토', callback_data: `darwin_manual:${task.id}` },
          ]] : null,
        });
        continue;
      }

      console.log(`[task-runner] 미지원 과제 타입 스킵: ${task.type}`);
    } catch (err) {
      console.error(`[task-runner] 과제 실패 (${task.id}): ${err.message}`);
      await postAlarm({
        message: `❌ 연구 과제 실패: ${task.id}\n${err.message}`,
        team: 'darwin',
        fromBot: 'task-runner',
      });
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
