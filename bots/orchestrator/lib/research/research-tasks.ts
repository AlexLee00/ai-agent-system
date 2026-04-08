const researchTasksModule = require('./research-tasks.js');

export const TASKS_DIR = researchTasksModule.TASKS_DIR;
export const ensureDir = researchTasksModule.ensureDir;
export const createTask = researchTasksModule.createTask;
export const loadTask = researchTasksModule.loadTask;
export const getPendingTasks = researchTasksModule.getPendingTasks;
export const getCompletedTasks = researchTasksModule.getCompletedTasks;
export const hasTaskForRepo = researchTasksModule.hasTaskForRepo;
export const updateTask = researchTasksModule.updateTask;
export const ensureTaskStatusSchema = researchTasksModule.ensureTaskStatusSchema;
export const executeGitHubAnalysis = researchTasksModule.executeGitHubAnalysis;
export const executeSkillCreation = researchTasksModule.executeSkillCreation;
export const autoCreateSkillTaskFromAnalysis = researchTasksModule.autoCreateSkillTaskFromAnalysis;
