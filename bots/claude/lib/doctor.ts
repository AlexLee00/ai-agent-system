const doctorModule = require('./doctor.js') as typeof import('./doctor.js');

export const {
  execute,
  canRecover,
  logRecovery,
  getRecoveryHistory,
  getAvailableTasks,
  pollDoctorTasks,
  discoverServices,
  checkLaunchdHealth,
  recoverDownServices,
  scanAndRecover,
  emergencyDirectRecover,
  getPastSuccessfulFix,
  WHITELIST,
  BLACKLIST,
} = doctorModule;
