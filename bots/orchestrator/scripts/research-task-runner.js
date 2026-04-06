'use strict';

const tasks = require('../lib/research/research-tasks');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');

async function main() {
  const pending = tasks.getPendingTasks();
  if (pending.length === 0) {
    console.log('[task-runner] 대기 중인 과제 없음');
    return;
  }

  console.log(`[task-runner] 대기 과제 ${pending.length}건`);

  for (const task of pending) {
    console.log(`[task-runner] 실행: ${task.id} (${task.type})`);

    try {
      if (task.type === 'github_analysis') {
        const result = await tasks.executeGitHubAnalysis(task);
        const spawnedSkillTask = tasks.autoCreateSkillTaskFromAnalysis(result, task.id);

        await postAlarm({
          message: `📊 연구 과제 완료!
📋 ${task.title}
🔗 ${task.target.owner}/${task.target.repo}
⭐ ${result.repoInfo.stars} | 📂 ${result.structure.totalFiles}파일
📝 분석 문서 자동 생성!
${spawnedSkillTask ? `🧠 후속 스킬 과제 생성: ${spawnedSkillTask.id}` : '🧠 후속 스킬 과제 없음'}`,
          team: 'darwin',
          fromBot: 'task-runner',
        });
        continue;
      }

      if (task.type === 'skill_creation') {
        const result = await tasks.executeSkillCreation(task);
        await postAlarm({
          message: `🧠 스킬 자동 생성 ${result.syntaxOk ? '✅' : '❌'}!
📋 ${task.title}
📂 ${result.skillPath}
📊 ${result.linesOfCode}줄
✅ 문법: ${result.syntaxOk ? '통과' : '실패'}
${result.branch ? `🌿 검증 브랜치: ${result.branch}` : ''}`,
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
