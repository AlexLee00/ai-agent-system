const researchTasksModule =
  require('./research-tasks.js') as typeof import('./research-tasks.js');

export const {
  TASKS_DIR,
  ensureDir,
  createTask,
  loadTask,
  getPendingTasks,
  getCompletedTasks,
  hasTaskForRepo,
  updateTask,
  ensureTaskStatusSchema,
  executeGitHubAnalysis,
  executeSkillCreation,
  autoCreateSkillTaskFromAnalysis,
} = researchTasksModule;
