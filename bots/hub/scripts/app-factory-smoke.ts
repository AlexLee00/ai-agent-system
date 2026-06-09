const { createHubApp } = require('../src/app');

type SmokeServer = {
  address: () => { port: number } | string | null;
  close: (callback: () => void) => void;
};

async function withServer(app: { listen: (port: number, host: string, callback: () => void) => SmokeServer }, fn: (baseUrl: string) => Promise<void>) {
  const server = await new Promise<SmokeServer>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address missing port');
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

    const invalidJsonResponse = await fetch(`${baseUrl}/hub/alarm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"invalid"',
    });
    const invalidJsonBody = await invalidJsonResponse.json();
    if (invalidJsonResponse.status !== 400 || invalidJsonBody.error !== 'invalid_json_body') {
      throw new Error('invalid JSON error boundary contract mismatch');
    }
    if (JSON.stringify(invalidJsonBody).includes('SyntaxError')) {
      throw new Error('invalid JSON response leaked stack detail');
    }

    const longPathResponse = await fetch(`${baseUrl}/${'a'.repeat(510)}`);
    const longPathBody = await longPathResponse.json();
    if (longPathResponse.status !== 414 || longPathBody.error !== 'URI too long') {
      throw new Error('long path guard contract mismatch');
    }

    const repeatedPathResponse = await fetch(`${baseUrl}/${'b'.repeat(60)}`);
    const repeatedPathBody = await repeatedPathResponse.json();
    if (repeatedPathResponse.status !== 400 || repeatedPathBody.error !== 'invalid path pattern') {
      throw new Error('repeated path guard contract mismatch');
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
  console.error('[app-factory-smoke] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
