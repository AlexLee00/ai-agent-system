'use strict';

const { getTraceId } = require('./trace');
const eventLake = require('./event-lake');

/**
 * @typedef {Object} LoggerOptions
 * @property {string} [team]
 */

/**
 * @typedef {Object.<string, any>} LoggerData
 */

function _eventType(botName, level) {
  if (level === 'ERROR') return `${botName}_error`;
  if (level === 'WARN') return `${botName}_warn`;
  return `${botName}_log`;
}

/**
 * @param {string} bot
 * @param {LoggerOptions} [options]
 */
function createLogger(bot, options = {}) {
  const botName = String(bot || 'unknown').trim() || 'unknown';
  const team = String(options.team || '').trim();

  /**
   * @param {'INFO'|'WARN'|'ERROR'|'DEBUG'|string} level
   * @param {string} message
   * @param {LoggerData|null} [data]
   */
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
    } else {
      console[method](line);
    }

    if (upper === 'WARN' || upper === 'ERROR') {
      eventLake.record({
        eventType: _eventType(botName, upper),
        team: team || 'general',
        botName,
        severity: /** @type {'warn'|'error'} */ (upper.toLowerCase()),
        traceId,
        title: String(message || '').slice(0, 140),
        message: String(message || ''),
        tags: [botName, team || 'general', upper.toLowerCase()],
        metadata: data && Object.keys(data).length > 0 ? data : {},
      }).catch(() => {});
    }
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
