type LegacyKioskMonitorModule = Record<string, unknown>;

const legacyModule = require('./pickko-kiosk-monitor.legacy.js') as LegacyKioskMonitorModule;

export = legacyModule;
