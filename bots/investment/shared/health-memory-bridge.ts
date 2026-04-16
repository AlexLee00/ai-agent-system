import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const healthMemory = require('./health-memory-bridge.cjs');

export const createHealthMemoryHelper = healthMemory.createHealthMemoryHelper;
export default healthMemory;
