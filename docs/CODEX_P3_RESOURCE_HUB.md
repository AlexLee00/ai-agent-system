# Codex 프롬프트 P3: Resource API Hub 구현

> 목적: 맥북 에어(DEV)에서 맥 스튜디오(OPS) 리소스를 안전하게 접근할 수 있는
>        경량 HTTP 허브를 맥 스튜디오에 구축한다.
> 전제: P1 (env.js 확산) 완료 후 실행
> 대상 머신: 맥 스튜디오 M4 Max (alexlee)

---

## 핵심 배경

맥북 에어(DEV)에서 개발 시 맥 스튜디오(OPS) 리소스에 접근이 필요하다:
- PostgreSQL: 읽기 전용 쿼리 (운영 데이터 조회)
- n8n: 웹훅 트리거 및 상태 확인
- launchd: 서비스 상태 모니터링
- 환경 정보: OPS 환경변수 요약

Resource API Hub는 이 리소스들을 단일 HTTP 엔드포인트로 통합하고,
DB 쓰기 차단 등 안전 게이트 역할을 수행한다.

**보안 원칙**: Hub는 리소스 프록시 전용이며 API 키/시크릿을 절대 노출하지 않는다.
`/hub/env` 엔드포인트는 MODE, IS_OPS 등 비민감 환경정보만 반환한다.
API 키 동기화는 별도 `scripts/sync-dev-secrets.sh`(SSH/scp)로 처리한다.

---

## 디렉토리 구조 (신규 생성)

```
bots/hub/
├── package.json
├── src/
│   └── hub.js              ← 메인 진입점 (Express)
├── lib/
│   ├── auth.js             ← Bearer 토큰 검증 미들웨어
│   ├── sql-guard.js        ← SQL 안전 파싱 (SELECT만 허용)
│   └── routes/
│       ├── health.js       ← GET /hub/health
│       ├── pg.js           ← POST /hub/pg/query
│       ├── n8n.js          ← n8n 웹훅/헬스 프록시
│       └── services.js     ← launchd 상태 + 환경 정보
└── launchd/
    └── ai.hub.resource-api.plist
```

---

## 작업 1: bots/hub/package.json 생성

```json
{
  "name": "@team-jay/hub",
  "version": "1.0.0",
  "description": "Resource API Hub — OPS 리소스 안전 프록시",
  "main": "src/hub.js",
  "scripts": {
    "start": "node src/hub.js"
  },
  "dependencies": {}
}
```

참고: express, express-rate-limit 은 프로젝트 루트 node_modules 에 이미 설치되어 있다.
없으면 프로젝트 루트에서 `npm install express express-rate-limit` 실행.

---

## 작업 2: bots/hub/lib/auth.js — Bearer 토큰 검증 미들웨어

```javascript
'use strict';
const { HUB_AUTH_TOKEN } = require('../../../packages/core/lib/env');

/**
 * Bearer Token 인증 미들웨어.
 * /hub/health 는 토큰 없이 접근 가능 (Dexter 헬스체크용).
 * 나머지 엔드포인트는 Authorization: Bearer <token> 필수.
 */
function authMiddleware(req, res, next) {
  // /hub/health 는 인증 면제
  if (req.path === '/hub/health') return next();

  if (!HUB_AUTH_TOKEN) {
    return res.status(500).json({
      error: 'HUB_AUTH_TOKEN not configured on server',
    });
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : '';

  if (token !== HUB_AUTH_TOKEN) {
    return res.status(401).json({ error: 'invalid or missing auth token' });
  }

  next();
}

module.exports = { authMiddleware };
```

---

## 작업 3: bots/hub/lib/sql-guard.js — SQL 안전 파싱

```javascript
'use strict';

/**
 * SQL 쿼리 안전성 검증.
 * SELECT / WITH ... SELECT / EXPLAIN 만 허용.
 * DML(INSERT/UPDATE/DELETE), DDL(CREATE/DROP/ALTER), 위험 함수 차단.
 *
 * @param {string} sql
 * @returns {{ allowed: boolean, reason?: string }}
 */
function validateQuery(sql) {
  if (!sql || typeof sql !== 'string') {
    return { allowed: false, reason: 'empty or non-string query' };
  }

  const trimmed = sql.trim();

  // 다중 쿼리 차단: 마지막 세미콜론 이후에 내용이 있으면 거부
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    return { allowed: false, reason: 'multi-statement query blocked' };
  }

  const normalized = trimmed.replace(/\s+/g, ' ').toLowerCase();

  // 허용 패턴: SELECT, WITH ... SELECT, EXPLAIN
  const allowedPrefixes = [
    /^select\b/,
    /^with\b/,
    /^explain\b/,
  ];

  if (!allowedPrefixes.some(p => p.test(normalized))) {
    return {
      allowed: false,
      reason: `query must start with SELECT, WITH, or EXPLAIN (got: "${normalized.slice(0, 20)}...")`,
    };
  }

  // DML/DDL 키워드 차단
  const blocked = [
    'insert ', 'update ', 'delete ', 'drop ', 'alter ',
    'truncate ', 'create ', 'grant ', 'revoke ',
    'vacuum ', 'reindex ',
  ];
  for (const kw of blocked) {
    if (normalized.includes(kw)) {
      return { allowed: false, reason: `blocked keyword: ${kw.trim()}` };
    }
  }

  // 위험 함수 차단
  const dangerous = [
    'pg_sleep', 'pg_read_file', 'pg_read_binary_file',
    'pg_ls_dir', 'lo_import', 'lo_export',
    'dblink', 'pg_execute_server_program',
    'copy ', 'pg_terminate_backend',
  ];
  for (const fn of dangerous) {
    if (normalized.includes(fn)) {
      return { allowed: false, reason: `dangerous function: ${fn.trim()}` };
    }
  }

  return { allowed: true };
}

module.exports = { validateQuery };
```

---

## 작업 4: bots/hub/lib/routes/health.js

```javascript
'use strict';
const pgPool = require('../../../../packages/core/lib/pg-pool');

const HUB_START = Date.now();

async function healthRoute(req, res) {
  const result = {
    status: 'ok',
    uptime_s: Math.floor((Date.now() - HUB_START) / 1000),
    resources: {},
  };

  // PostgreSQL 체크
  try {
    const t0 = Date.now();
    await pgPool.query('public', 'SELECT 1');
    result.resources.postgresql = {
      status: 'ok',
      latency_ms: Date.now() - t0,
    };
  } catch (err) {
    result.resources.postgresql = {
      status: 'error',
      detail: err.message,
    };
    result.status = 'degraded';
  }

  // n8n 체크
  try {
    const t0 = Date.now();
    const n8nRes = await fetch('http://127.0.0.1:5678/healthz', {
      signal: AbortSignal.timeout(3000),
    });
    result.resources.n8n = {
      status: n8nRes.ok ? 'ok' : 'warn',
      latency_ms: Date.now() - t0,
    };
  } catch (err) {
    result.resources.n8n = {
      status: 'error',
      detail: err.message,
    };
    result.status = 'degraded';
  }

  res.json(result);
}

module.exports = { healthRoute };
```

---

## 작업 5: bots/hub/lib/routes/pg.js

```javascript
'use strict';
const pgPool = require('../../../../packages/core/lib/pg-pool');
const { validateQuery } = require('../sql-guard');

const MAX_ROWS = 1000;
const QUERY_TIMEOUT_MS = 5000;

async function pgQueryRoute(req, res) {
  const { sql, params = [], schema = 'public' } = req.body || {};

  // 입력 검증
  if (!sql || typeof sql !== 'string') {
    return res.status(400).json({ error: 'sql is required (string)' });
  }

  const validSchemas = ['public', 'claude', 'reservation', 'investment', 'ska'];
  if (!validSchemas.includes(schema)) {
    return res.status(400).json({ error: `invalid schema: ${schema}` });
  }

  // SQL 안전 검증
  const check = validateQuery(sql);
  if (!check.allowed) {
    return res.status(403).json({
      error: 'query rejected by sql-guard',
      reason: check.reason,
    });
  }

  try {
    const t0 = Date.now();
    // LIMIT 강제 적용: 기존 LIMIT이 없으면 추가
    let safeSql = sql.trim().replace(/;\s*$/, '');
    if (!/\blimit\b/i.test(safeSql)) {
      safeSql += ` LIMIT ${MAX_ROWS}`;
    }

    const result = await pgPool.query(schema, safeSql, params);
    const rows = Array.isArray(result) ? result : (result.rows || []);
    res.json({
      rows: rows.slice(0, MAX_ROWS),
      rowCount: rows.length,
      duration_ms: Date.now() - t0,
      truncated: rows.length > MAX_ROWS,
    });
  } catch (err) {
    res.status(500).json({
      error: 'query execution failed',
      detail: err.message,
    });
  }
}

module.exports = { pgQueryRoute };
```

---

## 작업 6: bots/hub/lib/routes/n8n.js

```javascript
'use strict';
const { N8N_BASE_URL } = require('../../../../packages/core/lib/env');

async function n8nWebhookRoute(req, res) {
  const webhookPath = req.params.path || req.params[0];
  const targetUrl = `${N8N_BASE_URL}/webhook/${webhookPath}`;

  try {
    const n8nRes = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(10000),
    });

    const data = await n8nRes.json().catch(() => ({}));
    res.status(n8nRes.status).json(data);
  } catch (err) {
    res.status(502).json({
      error: 'n8n webhook proxy failed',
      detail: err.message,
    });
  }
}

async function n8nHealthRoute(req, res) {
  try {
    const n8nRes = await fetch(`${N8N_BASE_URL}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    res.json({ status: n8nRes.ok ? 'ok' : 'warn' });
  } catch (err) {
    res.json({ status: 'error', detail: err.message });
  }
}

module.exports = { n8nWebhookRoute, n8nHealthRoute };
```

---

## 작업 7: bots/hub/lib/routes/services.js

```javascript
'use strict';
const { execSync } = require('child_process');
const env = require('../../../../packages/core/lib/env');

// 감시 대상 launchd 서비스 목록
const WATCHED_SERVICES = [
  'ai.investment.crypto',
  'ai.ska.commander',
  'ai.ska.naver-monitor',
  'ai.blog.daily',
  'ai.worker.lead',
  'ai.worker.task-runner',
  'ai.orchestrator',
  'ai.claude.commander',
  'ai.claude.dexter',
  'ai.claude.dexter.quick',
  'ai.claude.dexter.daily',
  'ai.claude.archer',
  'ai.hub.resource-api',
];

function getServiceStatus(label) {
  try {
    const uid = execSync('id -u', { encoding: 'utf8' }).trim();
    const raw = execSync(
      `launchctl print gui/${uid}/${label} 2>/dev/null | head -20`,
      { encoding: 'utf8', timeout: 3000 }
    );
    const pidMatch = raw.match(/pid\s*=\s*(\d+)/i);
    const stateMatch = raw.match(/state\s*=\s*(\w+)/i);
    return {
      label,
      pid: pidMatch ? parseInt(pidMatch[1]) : null,
      state: stateMatch ? stateMatch[1] : 'unknown',
      running: !!pidMatch,
    };
  } catch {
    return { label, pid: null, state: 'not_found', running: false };
  }
}

async function servicesStatusRoute(req, res) {
  const services = WATCHED_SERVICES.map(getServiceStatus);
  const up = services.filter(s => s.running).length;
  res.json({
    services,
    summary: { up, total: services.length },
  });
}

async function envRoute(req, res) {
  // 민감 정보 제외, 환경 요약만 반환
  res.json({
    MODE: env.MODE,
    IS_OPS: env.IS_OPS,
    PAPER_MODE: env.PAPER_MODE,
    NODE_ENV: env.NODE_ENV,
    N8N_ENABLED: env.N8N_ENABLED,
    LAUNCHD_AVAILABLE: env.LAUNCHD_AVAILABLE,
    OPENCLAW_PORT: env.OPENCLAW_PORT,
    PROJECT_ROOT: env.PROJECT_ROOT,
    HUB_PORT: env.HUB_PORT,
  });
}

module.exports = { servicesStatusRoute, envRoute };
```

---

## 작업 8: bots/hub/src/hub.js — 메인 진입점

```javascript
'use strict';

/**
 * bots/hub/src/hub.js — Resource API Hub
 *
 * 맥 스튜디오(OPS) 전용 경량 HTTP 서버.
 * 맥북 에어(DEV)에서 OPS 리소스를 안전하게 접근하는 프록시.
 *
 * 엔드포인트:
 *   GET  /hub/health              통합 헬스체크
 *   POST /hub/pg/query            읽기 전용 DB 쿼리
 *   POST /hub/n8n/webhook/:path   n8n 웹훅 프록시
 *   GET  /hub/n8n/health          n8n 헬스 프록시
 *   GET  /hub/services/status     launchd 서비스 상태
 *   GET  /hub/env                 OPS 환경 요약
 *
 * 실행: MODE=ops node bots/hub/src/hub.js
 * launchd: ai.hub.resource-api
 */

const express = require('express');
const env = require('../../../packages/core/lib/env');

// OPS 전용 — DEV에서 기동 시 즉시 종료
env.ensureOps('Resource API Hub');
env.printModeBanner('Resource API Hub');

const { authMiddleware } = require('../lib/auth');
const { healthRoute } = require('../lib/routes/health');
const { pgQueryRoute } = require('../lib/routes/pg');
const { n8nWebhookRoute, n8nHealthRoute } = require('../lib/routes/n8n');
const { servicesStatusRoute, envRoute } = require('../lib/routes/services');

const app = express();
const PORT = env.HUB_PORT || 7788;

// ─── 미들웨어 ──────────────────────────────────────

// JSON 파싱 (1MB 제한)
app.use(express.json({ limit: '1mb' }));

// 요청 로깅
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const tag = status >= 400 ? '⚠️' : '✅';
    console.log(`${tag} ${req.method} ${req.path} → ${status} (${ms}ms)`);
  });
  next();
});

// 인증 (Bearer Token)
app.use('/hub', authMiddleware);

// Rate Limiting
let rateLimit;
try {
  rateLimit = require('express-rate-limit');
} catch {
  // express-rate-limit 미설치 시 no-op 미들웨어
  rateLimit = () => (req, res, next) => next();
  console.warn('[hub] ⚠️ express-rate-limit 미설치 — rate limit 비활성');
}

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'rate limit exceeded (100/min)' },
});

const pgLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'DB query rate limit exceeded (30/min)' },
});

// ─── 라우트 ──────────────────────────────────────────

app.get('/hub/health', generalLimiter, healthRoute);
app.post('/hub/pg/query', pgLimiter, pgQueryRoute);
app.post('/hub/n8n/webhook/:path', generalLimiter, n8nWebhookRoute);
app.get('/hub/n8n/health', generalLimiter, n8nHealthRoute);

app.get('/hub/services/status', generalLimiter, servicesStatusRoute);
app.get('/hub/env', generalLimiter, envRoute);

// 404 fallback
app.use('/hub', (req, res) => {
  res.status(404).json({ error: `unknown endpoint: ${req.method} ${req.path}` });
});

// ─── 서버 시작 ──────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Resource API Hub 시작 — http://0.0.0.0:${PORT}/hub/health`);
  console.log(`   인증: ${env.HUB_AUTH_TOKEN ? 'Bearer Token 활성' : '⚠️ HUB_AUTH_TOKEN 미설정'}`);
});

// 비정상 종료 처리
process.on('uncaughtException', (err) => {
  console.error('[hub] uncaughtException:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[hub] unhandledRejection:', err);
});
```

---

## 작업 9: bots/hub/launchd/ai.hub.resource-api.plist

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.hub.resource-api</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>bots/hub/src/hub.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/alexlee/projects/ai-agent-system</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>MODE</key>
    <string>ops</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/alexlee/projects/ai-agent-system/bots/hub/hub.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/alexlee/projects/ai-agent-system/bots/hub/hub.err.log</string>

  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
```

설치 방법 (수동):
```bash
cp bots/hub/launchd/ai.hub.resource-api.plist \
   ~/Library/LaunchAgents/ai.hub.resource-api.plist
launchctl load ~/Library/LaunchAgents/ai.hub.resource-api.plist
launchctl start ai.hub.resource-api
```

---

## 작업 10: bots/claude/lib/checks/hub.js — Dexter 헬스체크 통합

```javascript
'use strict';
/**
 * checks/hub.js — Resource API Hub 헬스체크
 *
 * Dexter가 Hub의 /hub/health 를 호출하여 상태를 확인한다.
 * Hub가 다운되면 DEV 환경에서 OPS 리소스 접근이 불가하므로 warn 등급으로 보고.
 */

const { checkHttp } = require('../../../../packages/core/lib/health-provider');
const { LAUNCHD_AVAILABLE } = require('../../../../packages/core/lib/env');

const HUB_HEALTH_URL = process.env.HUB_HEALTH_URL || 'http://127.0.0.1:7788/hub/health';
const HUB_TIMEOUT_MS = 3000;

async function run() {
  const items = [];

  // launchd 없는 환경(DEV)에서는 체크 스킵
  if (!LAUNCHD_AVAILABLE) {
    return { items: [{ status: 'ok', label: 'Hub', detail: 'DEV 환경 — 체크 스킵' }] };
  }

  const healthy = await checkHttp(HUB_HEALTH_URL, HUB_TIMEOUT_MS);
  items.push({
    status: healthy ? 'ok' : 'warn',
    label: 'Resource API Hub',
    detail: healthy ? 'health 정상' : 'Hub 응답 없음 (DEV 접근 불가)',
  });

  // Hub 응답이 있으면 하위 리소스 상태도 파싱
  if (healthy) {
    try {
      const res = await fetch(HUB_HEALTH_URL, {
        signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
      });
      const data = await res.json();
      if (data.resources) {
        for (const [name, info] of Object.entries(data.resources)) {
          items.push({
            status: info.status || 'ok',
            label: `Hub → ${name}`,
            detail: info.detail || `${info.latency_ms || '?'}ms`,
          });
        }
      }
    } catch { /* 이미 warn 보고됨 */ }
  }

  return { items };
}

module.exports = { run };
```

그리고 bots/claude/src/dexter.js (또는 dexter-quickcheck.js) 에서
checks 목록에 hub.js 를 추가한다:

```javascript
// 기존 checks 목록에 추가
const hubCheck = require('../lib/checks/hub');
// ...
checks.push({ name: 'hub', fn: hubCheck.run });
```

구체적 위치는 dexter.js / dexter-quickcheck.js 에서 기존 체크 모듈 등록 패턴을 따른다.
(예: n8n.js, openclaw.js 등이 등록된 방식과 동일하게)

---

## 작업 11: bots/registry.json 에 Hub 등록

기존 registry.json 에 hub 항목을 추가한다:

```json
{
  "hub": {
    "name": "Resource API Hub",
    "team": "hub",
    "entrypoint": "bots/hub/src/hub.js",
    "launchd": "ai.hub.resource-api",
    "type": "service",
    "port": 7788,
    "description": "OPS 리소스 안전 프록시 (DEV→OPS)"
  }
}
```

기존 항목들 뒤에 추가. 전체 JSON 구조를 깨뜨리지 않도록 주의.

---

## 완료 기준

```bash
# 1. 파일 존재 확인
ls bots/hub/package.json
ls bots/hub/src/hub.js
ls bots/hub/lib/auth.js
ls bots/hub/lib/sql-guard.js
ls bots/hub/lib/routes/health.js
ls bots/hub/lib/routes/pg.js
ls bots/hub/lib/routes/n8n.js
ls bots/hub/lib/routes/services.js
ls bots/hub/launchd/ai.hub.resource-api.plist
ls bots/claude/lib/checks/hub.js

# 2. 문법 검사
find bots/hub -name "*.js" | xargs -I{} node --check {}
node --check bots/claude/lib/checks/hub.js

# 3. Hub 기동 테스트 (OPS 모드)
MODE=ops HUB_AUTH_TOKEN=test123 node bots/hub/src/hub.js &
HUB_PID=$!
sleep 2

# 4. 헬스체크 (토큰 불필요)
curl -s http://localhost:7788/hub/health | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('status:', d.status);
  console.log('pg:', d.resources?.postgresql?.status);
"

# 5. 인증 테스트 — 토큰 없이 pg/query 접근 → 401
curl -s -o /dev/null -w '%{http_code}' \
  -X POST http://localhost:7788/hub/pg/query \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT 1"}'
# 기대 출력: 401

# 6. 인증 성공 + 읽기 쿼리 테스트
curl -s -X POST http://localhost:7788/hub/pg/query \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer test123' \
  -d '{"sql":"SELECT count(*) FROM investment.positions","schema":"investment"}' \
  | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('rowCount:', d.rowCount, 'duration:', d.duration_ms + 'ms');
  "

# 7. 쓰기 차단 테스트
curl -s -X POST http://localhost:7788/hub/pg/query \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer test123' \
  -d '{"sql":"DELETE FROM investment.positions WHERE 1=0","schema":"investment"}' \
  | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('blocked:', d.error, d.reason);
  "
# 기대: error=query rejected, reason=blocked keyword: delete

# 8. DEV 모드 기동 거부 테스트
MODE=dev node bots/hub/src/hub.js 2>&1 | grep -q "MODE=ops" && echo "OK: DEV blocked"

# 9. 정리
kill $HUB_PID 2>/dev/null
```


---

## 커밋 메시지

```
feat(hub): Resource API Hub — OPS 리소스 안전 프록시

- bots/hub/ 신규: 맥 스튜디오(OPS) 경량 HTTP 허브 (Express, 포트 7788)
  맥북 에어(DEV)에서 OPS 리소스를 안전하게 접근하는 단일 진입점

- 엔드포인트:
  GET  /hub/health           통합 헬스체크 (PG + n8n)
  POST /hub/pg/query         읽기 전용 DB 쿼리 (sql-guard: SELECT만 허용)
  POST /hub/n8n/webhook/:path  n8n 웹훅 프록시
  GET  /hub/n8n/health       n8n 헬스 프록시
  GET  /hub/services/status  launchd 전 서비스 상태
  GET  /hub/env              OPS 환경 요약
  GET  /hub/secrets/:category  시크릿 프록시 (llm/telegram/exchange/reservation)

- 보안: Bearer Token 인증 + Rate Limit (100/분, DB 30/분)
  /hub/health만 토큰 없이 접근 가능 (Dexter 헬스체크용)
  /hub/secrets는 Rate Limit 10/분 (시크릿 보호)

- sql-guard.js: DML/DDL/위험함수 차단, 다중쿼리 차단, 1000행 제한
- bots/claude/lib/checks/hub.js: Dexter 헬스체크 통합
- launchd plist: ai.hub.resource-api (KeepAlive)
- registry.json: hub 항목 추가
```

---

## 작업 12: bots/hub/lib/routes/secrets.js — 시크릿 프록시

DEV에서 OPS의 API 키를 Hub를 통해 안전하게 조회한다.
카테고리별로 분리하여 필요한 키만 반환하며, 티어 4 (OPS 전용) 키는 절대 반환하지 않는다.

```javascript
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const env = require('../../../../packages/core/lib/env');

const CONFIG_YAML = path.join(env.PROJECT_ROOT, 'bots/investment/config.yaml');
const RSV_SECRETS = path.join(env.PROJECT_ROOT, 'bots/reservation/secrets.json');
const WKR_SECRETS = path.join(env.PROJECT_ROOT, 'bots/worker/secrets.json');

let _configCache = null;
let _configMtime = 0;

function loadConfigYaml() {
  try {
    const stat = fs.statSync(CONFIG_YAML);
    if (_configCache && stat.mtimeMs === _configMtime) return _configCache;
    _configCache = yaml.load(fs.readFileSync(CONFIG_YAML, 'utf8')) || {};
    _configMtime = stat.mtimeMs;
    return _configCache;
  } catch { return {}; }
}

function loadJson(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch { return {}; }
}

/**
 * 카테고리별 시크릿 반환.
 * 티어 4 (OPS 전용) 키는 절대 포함하지 않는다.
 */
const CATEGORY_HANDLERS = {

  // LLM API 키 (티어 2: 공유)
  llm: () => {
    const c = loadConfigYaml();
    return {
      anthropic: { api_key: c.anthropic?.api_key, admin_api_key: c.anthropic?.admin_api_key },
      openai: { api_key: c.openai?.api_key, admin_api_key: c.openai?.admin_api_key, model: c.openai?.model },
      gemini: { api_key: c.gemini?.api_key, image_api_key: c.gemini?.image_api_key },
      groq: { accounts: c.groq?.accounts || [] },

      cerebras: { api_key: c.cerebras?.api_key },
      sambanova: { api_key: c.sambanova?.api_key },
      xai: { api_key: c.xai?.api_key },
      billing: c.billing || {},
    };
  },

  // 텔레그램 (티어 2: 공유)
  telegram: () => {
    const c = loadConfigYaml();
    return {
      bot_token: c.telegram?.bot_token,
      chat_id: String(c.telegram?.chat_id || process.env.TELEGRAM_CHAT_ID || ''),
    };
  },

  // 거래소 키 (티어 3: DEV는 paper/testnet 강제)
  exchange: () => {
    const c = loadConfigYaml();
    return {
      binance: {
        api_key: c.binance?.api_key,
        api_secret: c.binance?.api_secret,
        testnet: true,  // ★ DEV용: 항상 testnet 강제
        symbols: c.binance?.symbols || [],
      },
      upbit: {
        access_key: c.upbit?.access_key,
        secret_key: c.upbit?.secret_key,
      },

      kis: {
        app_key: c.kis?.paper_app_key || c.kis?.app_key,  // ★ DEV: paper 키 우선
        app_secret: c.kis?.paper_app_secret || c.kis?.app_secret,
        account_number: c.kis?.paper_account_number || c.kis?.account_number,
        paper_trading: true,  // ★ DEV용: 항상 paper 강제
      },
      // DEV 안전 모드 강제
      trading_mode: 'paper',
      paper_mode: true,
    };
  },

  // 예약 시크릿 (티어 2+4: 공유키만, OPS 전용 제외)
  reservation: () => {
    const d = loadJson(RSV_SECRETS);
    return {
      // 티어 2: 공유 가능
      telegram_bot_token: d.telegram_bot_token || '',
      telegram_chat_id: d.telegram_chat_id || '',
      telegram_group_id: d.telegram_group_id || '',
      telegram_topic_ids: d.telegram_topic_ids || {},
      // 티어 4: OPS 전용 — 빈값으로 마스킹
      naver_id: '',
      naver_pw: '',
      pickko_id: '',
      pickko_pw: '',
      naver_url: '',
      pickko_url: '',

      db_encryption_key: '',
      db_key_pepper: '',
      datagokr_holiday_key: '',
      datagokr_weather_key: '',
      datagokr_neis_key: '',
      datagokr_festival_key: '',
    };
  },

  // 전체 config.yaml (llm-keys.js loadConfig 호환)
  config: () => {
    const c = loadConfigYaml();
    // DEV 안전 오버라이드 적용
    return {
      ...c,
      trading_mode: 'paper',
      paper_mode: true,
      binance: { ...(c.binance || {}), testnet: true },
      kis: { ...(c.kis || {}), paper_trading: true },
    };
  },
};

async function secretsRoute(req, res) {
  const { category } = req.params;
  const handler = CATEGORY_HANDLERS[category];
  if (!handler) {
    return res.status(404).json({
      error: `unknown secrets category: ${category}`,

      available: Object.keys(CATEGORY_HANDLERS),
    });
  }

  try {
    const data = handler();
    res.json({ category, data });
  } catch (err) {
    res.status(500).json({ error: 'secrets load failed', detail: err.message });
  }
}

module.exports = { secretsRoute };
```

---

## 작업 13: hub.js 에 secrets 라우트 추가

bots/hub/src/hub.js 에서 기존 라우트 등록 부분 뒤에 추가:

```javascript
const { secretsRoute } = require('../lib/routes/secrets');

// 시크릿 프록시 (Rate Limit 강화: 10/분)
const secretsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'secrets rate limit exceeded (10/min)' },
});

app.get('/hub/secrets/:category', secretsLimiter, secretsRoute);
```


---

## 작업 14: packages/core/lib/llm-keys.js 수정 — Hub 커넥터 패턴

llm-keys.js의 loadConfig()에 Hub fallback을 추가한다.
DEV 환경에서는 로컬 config.yaml 대신 Hub에서 설정을 가져온다.
이 한 곳의 수정으로 llm-fallback, llm-model-selector, llm-router 전체가 자동 적용.

**기존 코드:**
```javascript
function loadConfig() {
  if (_config) return _config;
  try {
    const yaml = require('js-yaml');
    _config = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {
    _config = {};
  }
  return _config;
}
```

**수정 후:**
```javascript
const env = require('./env');

let _hubConfigLoaded = false;

function loadConfig() {
  if (_config) return _config;

  // DEV + Hub 사용 가능: 캐시된 Hub 설정 반환
  // (initHubConfig()이 사전 호출되어야 함)
  if (env.USE_HUB && _hubConfigLoaded) return _config;

  // OPS 또는 Hub 미초기화: 로컬 config.yaml
  try {
    const yaml = require('js-yaml');
    _config = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {
    _config = {};
  }
  return _config;
}

/**
 * DEV 환경 Hub 초기화 — 프로세스 시작 시 1회 호출.
 * Hub에서 config를 가져와 메모리 캐시에 저장.
 * 이후 getAnthropicKey() 등 동기 함수가 Hub 데이터를 반환.
 *
 * 사용법:
 *   const { initHubConfig } = require('./llm-keys');
 *   await initHubConfig();  // 프로세스 시작 시 1회
 */
async function initHubConfig() {
  if (!env.USE_HUB || !env.HUB_BASE_URL) return;

  try {
    const res = await fetch(
      `${env.HUB_BASE_URL}/hub/secrets/config`,
      {
        headers: { 'Authorization': `Bearer ${env.HUB_AUTH_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!res.ok) throw new Error(`Hub secrets/config 실패: ${res.status}`);
    const { data } = await res.json();
    _config = data;
    _hubConfigLoaded = true;
    console.log('[llm-keys] ✅ Hub에서 config 로드 완료 (DEV 모드)');
  } catch (err) {
    console.warn(`[llm-keys] ⚠️ Hub config 로드 실패: ${err.message}`);
    console.warn('[llm-keys]    로컬 config.yaml fallback 사용');
    // Hub 실패 시 로컬 config.yaml 사용 (있으면)
    loadConfig();
  }
}
```

module.exports 에 추가:
```javascript
module.exports = {
  // 기존
  getAnthropicKey, getAnthropicAdminKey,
  getOpenAIKey, getOpenAIAdminKey,
  getGeminiKey, getGeminiImageKey,
  getGroqAccounts,
  getCerebrasKey, getSambaNovaKey, getXAIKey,
  getBillingBudget,
  // 신규
  initHubConfig,
  loadConfig,  // 테스트·디버깅용 직접 접근
};
```

**호출 패턴 (각 봇 진입점에서):**
```javascript
// bots/investment/markets/crypto.js 등 진입점 최상단
const env = require('../../../packages/core/lib/env');
const { initHubConfig } = require('../../../packages/core/lib/llm-keys');

async function main() {
  await initHubConfig();  // DEV: Hub에서 키 로드, OPS: no-op
  // ... 기존 코드
}
main();
```

> **핵심**: `initHubConfig()`은 DEV에서만 동작하고, OPS에서는 no-op.
> 즉 OPS 코드는 변경 없이 기존대로 config.yaml을 읽는다.
> Hub 연결 실패 시 로컬 config.yaml로 자동 폴백.

---

## 작업 15: 완료 기준에 시크릿 테스트 추가

기존 완료 기준(작업 11 이후)에 다음 테스트 추가:

```bash
# 10. 시크릿 프록시 테스트 — LLM 키
curl -s -X GET http://localhost:7788/hub/secrets/llm \
  -H 'Authorization: Bearer test123' \
  | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('anthropic key:', d.data?.anthropic?.api_key ? '✅ 있음' : '❌ 없음');
    console.log('groq accounts:', d.data?.groq?.accounts?.length || 0, '개');
  "

# 11. 시크릿 프록시 테스트 — 거래소 (paper 강제)
curl -s -X GET http://localhost:7788/hub/secrets/exchange \

  -H 'Authorization: Bearer test123' \
  | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('trading_mode:', d.data?.trading_mode);
    console.log('testnet:', d.data?.binance?.testnet);
    console.assert(d.data?.trading_mode === 'paper', 'trading_mode must be paper');
    console.assert(d.data?.binance?.testnet === true, 'testnet must be true');
    console.log('✅ 거래소 DEV 안전 모드 확인');
  "

# 12. 시크릿 프록시 — reservation 마스킹 확인
curl -s -X GET http://localhost:7788/hub/secrets/reservation \
  -H 'Authorization: Bearer test123' \
  | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.assert(d.data?.naver_id === '', 'naver_id must be masked');
    console.assert(d.data?.pickko_pw === '', 'pickko_pw must be masked');
    console.assert(d.data?.telegram_bot_token !== '', 'telegram must exist');
    console.log('✅ reservation 티어4 마스킹 확인');
  "

# 13. 토큰 없이 시크릿 접근 → 401
curl -s -o /dev/null -w '%{http_code}' \
  http://localhost:7788/hub/secrets/llm
# 기대: 401
```

