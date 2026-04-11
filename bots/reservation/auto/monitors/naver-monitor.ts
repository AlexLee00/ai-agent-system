type LegacyMonitorModule = Record<string, unknown>;

const legacyModule = require('./naver-monitor.legacy.js') as LegacyMonitorModule;

export = legacyModule;
