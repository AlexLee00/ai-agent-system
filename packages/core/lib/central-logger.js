'use strict';

const { getTraceId } = require('./trace');

function createLogger(bot, options = {}) {
  const botName = String(bot || 'unknown').trim() || 'unknown';
  const team = String(options.team || '').trim();

  function emit(level, message, data = null) {
    const upper = String(level || 'INFO').toUpperCase();
    const traceId = getTraceId();
    const traceTag = traceId ? `[t:${traceId.replace(/-/g, '').slice(0, 8)}]` : '';
    const teamTag = team ? `[${team}]` : '';
    const prefix = `[${botName}][${upper}]${teamTag}${traceTag}`.trim();
    const line = `${prefix} ${String(message || '')}`.trim();
    const method = upper === 'ERROR' ? 'error' : upper === 'WARN' ? 'warn' : 'log';

    if (data && Object.keys(data).length > 0) {
      console[method](line, data);
      return;
    }
    console[method](line);
  }

  return {
    info(message, data = null) {
      emit('INFO', message, data);
    },
    warn(message, data = null) {
      emit('WARN', message, data);
    },
    error(message, data = null) {
      emit('ERROR', message, data);
    },
    debug(message, data = null) {
      emit('DEBUG', message, data);
    },
  };
}

module.exports = {
  createLogger,
};
