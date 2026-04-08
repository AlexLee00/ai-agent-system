const doctorModule = require('./doctor.js');

export const execute = doctorModule.execute;
export const canRecover = doctorModule.canRecover;
export const logRecovery = doctorModule.logRecovery;
export const getRecoveryHistory = doctorModule.getRecoveryHistory;
export const getAvailableTasks = doctorModule.getAvailableTasks;
export const pollDoctorTasks = doctorModule.pollDoctorTasks;
export const discoverServices = doctorModule.discoverServices;
export const checkLaunchdHealth = doctorModule.checkLaunchdHealth;
export const recoverDownServices = doctorModule.recoverDownServices;
export const scanAndRecover = doctorModule.scanAndRecover;
export const emergencyDirectRecover = doctorModule.emergencyDirectRecover;
export const getPastSuccessfulFix = doctorModule.getPastSuccessfulFix;
export const WHITELIST = doctorModule.WHITELIST;
export const BLACKLIST = doctorModule.BLACKLIST;
