const { createHubApp } = require('../src/app');

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

async function main() {
  const startupApp = createHubApp({
    isShuttingDown: () => false,
    isStartupComplete: () => false,
  });
  await withServer(startupApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/hub/health/startup`);
    const body = await response.json();
    if (response.status !== 503 || body.startup_complete !== false) {
      throw new Error('startup readiness contract mismatch');
    }
  });

  const shutdownApp = createHubApp({
    isShuttingDown: () => true,
    isStartupComplete: () => true,
  });
  await withServer(shutdownApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/hub/health/live`);
    const body = await response.json();
    if (response.status !== 503 || String(body.error || '') !== 'server shutting down') {
      throw new Error('shutdown live contract mismatch');
    }
  });

  console.log('hub_app_factory_smoke_ok');
}

main().catch((error) => {
  console.error('[app-factory-smoke] failed:', error?.message || error);
  process.exit(1);
});
