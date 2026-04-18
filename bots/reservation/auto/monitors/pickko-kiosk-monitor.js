#!/usr/bin/env node

const path = require('node:path');
const { loadTsSourceBridge } = require('../../lib/ts-source-bridge.js');

loadTsSourceBridge(path.dirname(__filename), 'pickko-kiosk-monitor');
