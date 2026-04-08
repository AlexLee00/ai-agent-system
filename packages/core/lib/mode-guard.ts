import env = require('./env');

const MODE = env.MODE;
const ensureOps = env.ensureOps;
const ensureDev = env.ensureDev;
const isOps = (): boolean => env.IS_OPS;
const isDev = (): boolean => env.IS_DEV;
const getMode = (): string => env.MODE;
const runIfOps = env.runIfOps;

export = {
  MODE,
  ensureOps,
  ensureDev,
  isOps,
  isDev,
  getMode,
  runIfOps,
};
