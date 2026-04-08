const workerLeadModule = require('./worker-lead.js') as typeof import('./worker-lead.js');

export const { handleCommand } = workerLeadModule;
