const { parsePositiveIntEnv } = require('./env-utils');

const REQUEST_TIMEOUT_MS = parsePositiveIntEnv('HUB_REQUEST_TIMEOUT_MS', 120000);
const HEADERS_TIMEOUT_MS = parsePositiveIntEnv('HUB_HEADERS_TIMEOUT_MS', 65000);
const KEEP_ALIVE_TIMEOUT_MS = parsePositiveIntEnv('HUB_KEEP_ALIVE_TIMEOUT_MS', 5000);
const MAX_REQUESTS_PER_SOCKET = parsePositiveIntEnv('HUB_MAX_REQUESTS_PER_SOCKET', 1000);

function configureHttpServer(server, options = {}) {
  const onFatalError = options.onFatalError || (() => {});

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = Math.min(HEADERS_TIMEOUT_MS, Math.max(REQUEST_TIMEOUT_MS - 1000, 1000));
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = MAX_REQUESTS_PER_SOCKET;

  server.on('clientError', (error, socket) => {
    console.warn('[hub] clientError:', error?.code || error?.message || error);
    try {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    } catch {
      try { socket.destroy(); } catch {}
    }
  });

  server.on('error', (error) => {
    console.error('[hub] server error:', error);
    onFatalError(error);
  });
}

module.exports = {
  configureHttpServer,
  parsePositiveIntEnv,
};
