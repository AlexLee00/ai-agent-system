const taskRunnerModule = require('./task-runner.js') as typeof import('./task-runner.js');

export const { processOne, executeTask } = taskRunnerModule;
