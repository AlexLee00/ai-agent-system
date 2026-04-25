const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { createHubApp } = require('./app');

const SHUTDOWN_TIMEOUT_MS = 10000;
const UNCAUGHT_OVERFLOW_LIMIT = 3;
const UNCAUGHT_RESET_MS = 5 * 60 * 1000;

const runtime = {
  app: null,
  server: null,
  activeConnections: new Set(),
  isShuttingDown: false,
  startupComplete: false,
};

let uncaughtCount = 0;
let uncaughtResetTimer = null;

function resetUncaughtOverflowTimer() {
  if (uncaughtResetTimer) clearTimeout(uncaughtResetTimer);
  uncaughtResetTimer = setTimeout(() => {
    uncaughtCount = 0;
    uncaughtResetTimer = null;
  }, UNCAUGHT_RESET_MS);
  uncaughtResetTimer.unref?.();
}

async function gracefulShutdown(reason, exitCode = 0) {
  if (runtime.isShuttingDown) return;
  runtime.isShuttingDown = true;
  console.error(`[hub] ${reason} → graceful shutdown 시작`);

  const forceTimer = setTimeout(() => {
    console.error(`[hub] 강제 종료 (${SHUTDOWN_TIMEOUT_MS}ms 타임아웃)`);
    for (const socket of runtime.activeConnections) {
      try { socket.destroy(); } catch {}
    }
    process.exit(exitCode || 1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref?.();

  try {
    if (runtime.server) {
      await new Promise((resolve) => {
        runtime.server.close(() => resolve());
      });
    }
    await pgPool.closeAll?.();
    clearTimeout(forceTimer);
    process.exit(exitCode);
  } catch (error) {
    clearTimeout(forceTimer);
    console.error('[hub] graceful shutdown 실패:', error);
    process.exit(1);
  }
}

function registerProcessHooks() {
  process.on('SIGTERM', () => { gracefulShutdown('SIGTERM', 0).catch(() => {}); });
  process.on('SIGINT', () => { gracefulShutdown('SIGINT', 0).catch(() => {}); });
  process.on('uncaughtException', (error) => {
    uncaughtCount += 1;
    resetUncaughtOverflowTimer();
    console.error(`[hub] uncaughtException #${uncaughtCount}:`, error);
    if (uncaughtCount >= UNCAUGHT_OVERFLOW_LIMIT) {
      gracefulShutdown('uncaught_overflow', 1).catch(() => {});
    }
  });
  process.on('unhandledRejection', (error) => {
    console.error('[hub] unhandledRejection:', error);
  });
}

export function startHubServer() {
  env.ensureOps('Resource API Hub');
  env.printModeBanner('Resource API Hub');

  const port = env.HUB_PORT || 7788;
  const bindHost = String(env.HUB_BIND_HOST || '127.0.0.1').trim() || '127.0.0.1';
  runtime.app = createHubApp({
    isShuttingDown: () => runtime.isShuttingDown,
    isStartupComplete: () => runtime.startupComplete,
  });
  runtime.server = runtime.app.listen(port, bindHost, () => {
    runtime.startupComplete = true;
    console.log(`🌐 Resource API Hub 시작 — http://${bindHost}:${port}/hub/health`);
    console.log(`   인증: ${env.HUB_AUTH_TOKEN ? 'Bearer Token 활성' : '⚠️ HUB_AUTH_TOKEN 미설정'}`);
    if (bindHost === '0.0.0.0') {
      console.warn('⚠️  Hub가 모든 인터페이스(0.0.0.0)에 바인딩됨 — 운영 환경에서는 권장하지 않음');
    }
  });

  runtime.server.on('connection', (socket) => {
    runtime.activeConnections.add(socket);
    socket.on('close', () => runtime.activeConnections.delete(socket));
  });

  registerProcessHooks();
  return runtime.server;
}

export function getHubRuntimeState() {
  return {
    startupComplete: runtime.startupComplete,
    isShuttingDown: runtime.isShuttingDown,
    activeConnections: runtime.activeConnections.size,
  };
}
