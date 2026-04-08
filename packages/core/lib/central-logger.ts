const { getTraceId } = require('./trace');
const eventLake = require('./event-lake');

type LoggerOptions = {
  team?: string;
};

type LoggerData = Record<string, any>;

function eventType(botName: string, level: string): string {
  if (level === 'ERROR') return `${botName}_error`;
  if (level === 'WARN') return `${botName}_warn`;
  return `${botName}_log`;
}

export function createLogger(bot: string, options: LoggerOptions = {}) {
  const botName = String(bot || 'unknown').trim() || 'unknown';
  const team = String(options.team || '').trim();

  function emit(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | string, message: string, data: LoggerData | null = null) {
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
        eventType: eventType(botName, upper),
        team: team || 'general',
        botName,
        severity: upper.toLowerCase(),
        traceId,
        title: String(message || '').slice(0, 140),
        message: String(message || ''),
        tags: [botName, team || 'general', upper.toLowerCase()],
        metadata: data && Object.keys(data).length > 0 ? data : {},
      }).catch(() => {});
    }
  }

  return {
    info(message: string, data: LoggerData | null = null) {
      emit('INFO', message, data);
    },
    warn(message: string, data: LoggerData | null = null) {
      emit('WARN', message, data);
    },
    error(message: string, data: LoggerData | null = null) {
      emit('ERROR', message, data);
    },
    debug(message: string, data: LoggerData | null = null) {
      emit('DEBUG', message, data);
    },
  };
}
