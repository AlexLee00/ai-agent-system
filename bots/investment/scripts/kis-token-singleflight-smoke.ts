// @ts-nocheck
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const botRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(botRoot, '../..');
const kisClientUrl = pathToFileURL(path.join(botRoot, 'shared/kis-client.ts')).href;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-token-singleflight-'));
process.env.TMPDIR = tempRoot;
process.env.KIS_USE_MCP = 'false';
process.env.KIS_APP_KEY = 'smoke-kis-app-key';
process.env.KIS_APP_SECRET = 'smoke-kis-app-secret';
process.env.IS_OPS = '1';

let tokenCalls = 0;
let quoteCalls = 0;

globalThis.fetch = async (url) => {
  const text = String(url || '');
  if (text.includes('/oauth2/tokenP')) {
    tokenCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return new Response(JSON.stringify({
      access_token: `smoke-token-${tokenCalls}`,
      expires_in: 3600,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (text.includes('/uapi/domestic-stock/v1/quotations/inquire-price')) {
    quoteCalls += 1;
    return new Response(JSON.stringify({
      rt_cd: '0',
      output: {
        stck_prpr: '70000',
        acml_vol: '10',
        stck_oprc: '69000',
        stck_hgpr: '71000',
        stck_lwpr: '68000',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ rt_cd: '1', msg1: 'unexpected smoke url' }), { status: 500 });
};

try {
  const kis = await import('../shared/kis-client.ts');
  const [first, second] = await Promise.all([
    kis.getDomesticQuoteSnapshot('005930', false),
    kis.getDomesticQuoteSnapshot('000660', false),
  ]);

  if (tokenCalls !== 1) {
    throw new Error(`expected exactly 1 KIS token issuance, got ${tokenCalls}`);
  }
  if (quoteCalls !== 2) {
    throw new Error(`expected 2 KIS quote calls, got ${quoteCalls}`);
  }
  if (first.price !== 70000 || second.price !== 70000) {
    throw new Error('unexpected quote price from smoke fixture');
  }

  fs.rmSync(path.join(tempRoot, 'kis-token-live.json'), { force: true });
  fs.rmSync(path.join(tempRoot, 'kis-token-live.lock'), { recursive: true, force: true });

  const childTokenLog = path.join(tempRoot, 'child-token-calls.log');
  const childScript = path.join(tempRoot, 'child-kis-token-smoke.mjs');
  fs.writeFileSync(childScript, `
    process.env.TMPDIR = ${JSON.stringify(tempRoot)};
    process.env.KIS_USE_MCP = 'false';
    process.env.KIS_APP_KEY = 'smoke-kis-app-key';
    process.env.KIS_APP_SECRET = 'smoke-kis-app-secret';
    process.env.IS_OPS = '1';
    globalThis.fetch = async (url) => {
      const text = String(url || '');
      if (text.includes('/oauth2/tokenP')) {
        await import('fs').then(({ appendFileSync }) => appendFileSync(${JSON.stringify(childTokenLog)}, 'token\\\\n'));
        await new Promise((resolve) => setTimeout(resolve, 120));
        return new Response(JSON.stringify({ access_token: 'child-smoke-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (text.includes('/uapi/domestic-stock/v1/quotations/inquire-price')) {
        return new Response(JSON.stringify({
          rt_cd: '0',
          output: { stck_prpr: '70000', acml_vol: '10', stck_oprc: '69000', stck_hgpr: '71000', stck_lwpr: '68000' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ rt_cd: '1', msg1: 'unexpected smoke url' }), { status: 500 });
    };
    const kis = await import(${JSON.stringify(kisClientUrl)});
    await kis.getDomesticQuoteSnapshot('005930', false);
  `);

  const runChild = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript], {
      cwd: repoRoot,
      env: { ...process.env, TMPDIR: tempRoot, KIS_USE_MCP: 'false', KIS_APP_KEY: 'smoke-kis-app-key', KIS_APP_SECRET: 'smoke-kis-app-secret', IS_OPS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`child exited ${code}: ${stderr || stdout}`));
    });
  });

  await Promise.all([runChild(), runChild()]);
  const childTokenCalls = fs.existsSync(childTokenLog)
    ? fs.readFileSync(childTokenLog, 'utf8').split('\n').filter(Boolean).length
    : 0;
  if (childTokenCalls !== 1) {
    throw new Error(`expected exactly 1 cross-process KIS token issuance, got ${childTokenCalls}`);
  }

  console.log(JSON.stringify({
    ok: true,
    smoke: 'kis-token-singleflight',
    tokenCalls,
    quoteCalls,
    childTokenCalls,
  }, null, 2));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
