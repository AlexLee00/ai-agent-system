import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const criticalIncident = require('./critical-incident-bridge.cjs');

export const updateCriticalIncidentCache = criticalIncident.updateCriticalIncidentCache;
export default criticalIncident;
