# CODEX_P5_SECRET_CONNECTOR — 시크릿 Hub 커넥터

> 실행 대상: Claude Code (Codex)
> 선행 조건: P1~P4 완료, Hub 가동 중 (:7788)
> 예상 변경: 4파일 수정 + 1파일 신규

## 목표

OPS/DEV 모두 Hub를 통해 시크릿에 접근하도록 통합.
진입점 3개만 수정하면 하위 54곳 자동 Hub 경유.

```
수정 전: 모든 봇 → config.yaml / secrets.json 직접 읽기
수정 후: 모든 봇 → Hub /hub/secrets/* (1순위) → 로컬 파일 폴백 (2순위)
```

## 사전 확인

```bash
cat CLAUDE.md
curl -s http://localhost:7788/hub/health | jq .status
node -e "const env = require('./packages/core/lib/env'); console.log({ MODE: env.MODE, USE_HUB: env.USE_HUB })"
wc -l packages/core/lib/llm-keys.js bots/investment/shared/secrets.js bots/reservation/lib/secrets.js
```


---

## 작업 1/5: env.js에 USE_HUB_SECRETS 추가

**파일**: `packages/core/lib/env.js`

`USE_HUB` 정의 바로 아래에 추가:

```javascript
// 기존 (수정하지 않음)
const USE_HUB = IS_DEV && !!HUB_BASE_URL;
const HUB_AUTH_TOKEN = process.env.HUB_AUTH_TOKEN || '';

// ── 아래 추가 ──
/** 시크릿을 Hub 경유로 조회 (OPS+DEV 모두 가능) */
const USE_HUB_SECRETS = process.env.USE_HUB_SECRETS === 'true'
  || (IS_DEV && !!HUB_BASE_URL);
```

exports 객체에 `USE_HUB_SECRETS` 추가.

**검증**: `node -e "const env = require('./packages/core/lib/env'); console.log('USE_HUB_SECRETS:', env.USE_HUB_SECRETS)"`

---

## 작업 2/5: hub-client.js 신규 생성

**파일**: `packages/core/lib/hub-client.js` (신규, CJS)

```javascript
'use strict';
/**
 * packages/core/lib/hub-client.js — Hub 시크릿 프록시 클라이언트
 * 사용법:
 *   const { fetchHubSecrets } = require('./hub-client');
 *   const data = await fetchHubSecrets('llm');
 */
const env = require('./env');

async function fetchHubSecrets(category, timeoutMs = 3000) {
  if (!env.USE_HUB_SECRETS || !env.HUB_BASE_URL) return null;
  const url = `${env.HUB_BASE_URL}/hub/secrets/${category}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${env.HUB_AUTH_TOKEN}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`[hub-client] ${category}: HTTP ${res.status}`); return null; }
    const json = await res.json();
    return json.data || null;
  } catch (err) {
    console.warn(`[hub-client] ${category}: ${err.name === 'AbortError' ? `타임아웃` : err.message}`);
    return null;
  }
}
module.exports = { fetchHubSecrets };
```

설계: USE_HUB_SECRETS false → 즉시 null. 타임아웃 3초. Node 18+ fetch. 패키지 추가 불필요.


---

## 작업 3/5: llm-keys.js Hub 커넥터 (계통 1)

**파일**: `packages/core/lib/llm-keys.js` (전체 교체, CJS)

현재 65줄 → ~85줄. 전 팀 사용. **하위 호환 필수**.

변경: initHubConfig() 추가. Hub 1순위, 로컬 config.yaml 폴백. 기존 getXxxKey() 변경 없음.

```javascript
'use strict';
/**
 * packages/core/lib/llm-keys.js — 통합 LLM API 키 로더
 * Source: Hub /hub/secrets/llm → 폴백: bots/investment/config.yaml
 * 사용법:
 *   const { initHubConfig, getAnthropicKey } = require('./llm-keys');
 *   await initHubConfig();  // 선택적 (봇 시작 시 1회)
 */
const fs   = require('fs');
const path = require('path');
const { fetchHubSecrets } = require('./hub-client');
const CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'bots', 'investment', 'config.yaml');

let _config = null;
let _hubInitDone = false;

function loadConfigLocal() {
  try { const yaml = require('js-yaml'); return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; }
  catch { return {}; }
}

async function initHubConfig() {
  if (_hubInitDone) return !!_config;
  const hubData = await fetchHubSecrets('llm');
  if (hubData) {
    _config = {
      anthropic: hubData.anthropic || {}, openai: hubData.openai || {},
      gemini: hubData.gemini || {}, groq: hubData.groq || {},
      cerebras: hubData.cerebras || {}, sambanova: hubData.sambanova || {},
      xai: hubData.xai || {}, billing: hubData.billing || {},
    };
    _hubInitDone = true; return true;
  }
  _config = loadConfigLocal();
  _hubInitDone = true; return false;
}

function loadConfig() { if (_config) return _config; _config = loadConfigLocal(); return _config; }

function getAnthropicKey()      { return loadConfig()?.anthropic?.api_key       || process.env.ANTHROPIC_API_KEY       || null; }
function getAnthropicAdminKey() { return loadConfig()?.anthropic?.admin_api_key  || process.env.ANTHROPIC_ADMIN_API_KEY  || null; }
function getOpenAIKey()         { return loadConfig()?.openai?.api_key           || process.env.OPENAI_API_KEY           || null; }
function getOpenAIAdminKey()    { return loadConfig()?.openai?.admin_api_key      || process.env.OPENAI_ADMIN_API_KEY      || null; }
function getGeminiKey()          { return loadConfig()?.gemini?.api_key           || process.env.GEMINI_API_KEY           || null; }
function getGeminiImageKey()    { return loadConfig()?.gemini?.image_api_key     || process.env.GEMINI_IMAGE_KEY         || getGeminiKey(); }
function getGroqAccounts()      { return loadConfig()?.groq?.accounts            || []; }
function getCerebrasKey()       { return loadConfig()?.cerebras?.api_key         || null; }
function getSambaNovaKey()      { return loadConfig()?.sambanova?.api_key        || null; }
function getXAIKey()            { return loadConfig()?.xai?.api_key             || null; }
function getBillingBudget() {
  const b = loadConfig()?.billing || {};
  return {
    anthropic: parseFloat(b.budget_anthropic || process.env.BILLING_BUDGET_ANTHROPIC || '50'),
    openai:    parseFloat(b.budget_openai    || process.env.BILLING_BUDGET_OPENAI    || '30'),
    total:     parseFloat(b.budget_total     || process.env.BILLING_BUDGET_TOTAL     || '80'),
    spike_threshold: parseFloat(b.spike_threshold || process.env.BILLING_SPIKE_THRESHOLD || '3.0'),
  };
}

module.exports = {
  initHubConfig,
  getAnthropicKey, getAnthropicAdminKey, getOpenAIKey, getOpenAIAdminKey,
  getGeminiKey, getGeminiImageKey, getGroqAccounts,
  getCerebrasKey, getSambaNovaKey, getXAIKey, getBillingBudget,
};
```


---

## 작업 4/5: investment/secrets.js Hub 커넥터 (계통 2)

**파일**: `bots/investment/shared/secrets.js` (수정, ESM, 526줄)

32곳에서 loadSecrets() 호출 + 7곳 직접 import. **loadSecrets() 내부와 export만 수정.**

### 4-1. hub-client require 추가 (기존 _require 뒤에)

기존 코드:
```javascript
const _require = createRequire(import.meta.url);
const kst     = _require('../../../packages/core/lib/kst');
const env     = _require('../../../packages/core/lib/env');
```

수정 (아래 1줄 추가):
```javascript
const _require = createRequire(import.meta.url);
const kst     = _require('../../../packages/core/lib/kst');
const env     = _require('../../../packages/core/lib/env');
const _hubClient = _require('../../../packages/core/lib/hub-client');
```

### 4-2. _hubInitDone 변수 추가

기존: `let _secrets = null;`
수정:
```javascript
let _secrets = null;
let _hubInitDone = false;
```

### 4-3. initHubSecrets() 함수 추가 (loadSecrets() 바로 앞에 삽입)

```javascript
/**
 * Hub에서 전체 config를 가져와 시크릿 캐시에 주입.
 * 투자팀 봇 시작 시 1회 호출 (선택적).
 * 실패 시 기존 loadSecrets() 폴백.
 * @returns {Promise<boolean>} Hub 로드 성공 여부
 */
export async function initHubSecrets() {
  if (_hubInitDone) return !!_secrets;

  const hubData = await _hubClient.fetchHubSecrets('config');
  if (hubData) {
    const c = hubData;
    _secrets = {
      telegram_bot_token:   c.telegram?.bot_token  || '',
      telegram_chat_id:     String(c.telegram?.chat_id || process.env.TELEGRAM_CHAT_ID || ''),
      binance_api_key:      c.binance?.api_key     || '',
      binance_api_secret:   c.binance?.api_secret  || '',
      binance_testnet:      c.binance?.testnet     || false,
      binance_symbols:      c.binance?.symbols     || ['BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT'],
      binance_deposit_address_usdt: c.binance?.deposit_address_usdt || '',
      upbit_access_key:     c.upbit?.access_key    || '',
      upbit_secret_key:     c.upbit?.secret_key    || '',
      kis_app_key:          c.kis?.app_key         || '',
      kis_app_secret:       c.kis?.app_secret      || '',
      kis_paper_app_key:    c.kis?.paper_app_key   || '',
      kis_paper_app_secret: c.kis?.paper_app_secret|| '',
      kis_account_number:   c.kis?.account_number  || '',
      kis_paper_account_number: c.kis?.paper_account_number || '',
      kis_paper_trading:    c.kis?.paper_trading   !== false,
      kis_symbols:          c.kis?.symbols         || [],
      kis_overseas_symbols: c.kis?.overseas_symbols || [],
      screening_domestic_core: c.screening?.domestic?.core || [],
      screening_overseas_core: c.screening?.overseas?.core || [],
      screening_crypto_core:   c.screening?.crypto?.core   || [],
      screening_domestic_max_dynamic: Number(c.screening?.domestic?.max_dynamic || 0),
      screening_overseas_max_dynamic: Number(c.screening?.overseas?.max_dynamic || 0),
      screening_crypto_max_dynamic:   Number(c.screening?.crypto?.max_dynamic   || 0),
      anthropic_api_key:    c.anthropic?.api_key   || '',
      groq_api_key:         c.groq?.accounts?.[0]?.api_key || '',
      groq_api_keys:        (c.groq?.accounts || []).map(a => a.api_key).filter(Boolean),
      cerebras_api_key:     c.cerebras?.api_key    || '',
      sambanova_api_key:    c.sambanova?.api_key   || '',
      xai_api_key:          c.xai?.api_key         || '',
      naver_client_id:      c.news?.naver_client_id     || '',
      naver_client_secret:  c.news?.naver_client_secret || '',
      dart_api_key:         c.news?.dart_api_key        || '',
      cryptopanic_api_key:  c.news?.cryptopanic_api_key || '',
      alpha_vantage_api_key:c.news?.alpha_vantage_api_key || '',
      trading_mode: normalizeMode(c.trading_mode) || (c.paper_mode === false ? 'live' : 'paper'),
      binance_mode: normalizeMode(c.binance_mode) || 'inherit',
      kis_mode:     normalizeMode(c.kis_mode)     || 'inherit',
      investment_trade_mode: normalizeInvestmentTradeMode(c.investment_trade_mode) || 'normal',
      paper_mode: c.paper_mode !== false,
    };
    _hubInitDone = true;
    return true;
  }

  // Hub 실패 → 기존 loadSecrets() 폴백
  loadSecrets();
  _hubInitDone = true;
  return false;
}
```

### 4-4. loadSecrets()는 수정 불필요

기존 `if (_secrets) return _secrets;`가 initHubSecrets()에서 주입한 캐시를 자동 반환.

**검증**: `node --check bots/investment/shared/secrets.js`

---

## 작업 5/5: reservation/secrets.js Hub 커넥터 (계통 3)

**파일**: `bots/reservation/lib/secrets.js` (수정, CJS, 123줄)

15곳에서 loadSecrets() 호출. 간단한 수정.

### 5-1. require 추가 (파일 상단, 기존 require 뒤)

```javascript
const { fetchHubSecrets } = require('../../../packages/core/lib/hub-client');
```

### 5-2. 변수 추가 (기존 _cache 뒤)

```javascript
let _cache = null;
let _hubInitDone = false;
```

### 5-3. initHubSecrets() 함수 추가 (loadSecrets() 바로 앞)

```javascript
/**
 * Hub에서 reservation 시크릿을 가져와 캐시에 주입.
 * 예약팀 봇 시작 시 1회 호출 (선택적).
 * @returns {Promise<boolean>} Hub 로드 성공 여부
 */
async function initHubSecrets() {
  if (_hubInitDone) return !!_cache;

  const hubData = await fetchHubSecrets('reservation');
  if (hubData) {
    _cache = hubData;
    _hubInitDone = true;
    return true;
  }

  // Hub 실패 → 기존 loadSecrets() 폴백
  loadSecrets();
  _hubInitDone = true;
  return false;
}
```

### 5-4. exports에 initHubSecrets 추가

기존:
```javascript
module.exports = { loadSecrets, requireSecret, hasSecret, getSecret, ... };
```
수정 (initHubSecrets 추가):
```javascript
module.exports = { loadSecrets, requireSecret, hasSecret, getSecret, ..., initHubSecrets };
```

**검증**: `node --check bots/reservation/lib/secrets.js`

---

## 전체 검증

```bash
echo "=== 1. 문법 검사 ==="
node --check packages/core/lib/env.js && echo "✅ env.js"
node --check packages/core/lib/hub-client.js && echo "✅ hub-client.js"
node --check packages/core/lib/llm-keys.js && echo "✅ llm-keys.js"
node --check bots/investment/shared/secrets.js && echo "✅ investment/secrets.js"
node --check bots/reservation/lib/secrets.js && echo "✅ reservation/secrets.js"

echo ""
echo "=== 2. USE_HUB_SECRETS 확인 ==="
node -e "const env = require('./packages/core/lib/env'); console.log('USE_HUB_SECRETS:', env.USE_HUB_SECRETS)"

echo ""
echo "=== 3. hub-client 단독 테스트 ==="
node -e "const { fetchHubSecrets } = require('./packages/core/lib/hub-client'); fetchHubSecrets('llm').then(d => console.log(d ? '✅ Hub 연결, 키: ' + Object.keys(d).join(',') : '⏭️ Hub 미사용 (정상)'))"

echo ""
echo "=== 4. llm-keys Hub 연동 테스트 ==="
node -e "
const { initHubConfig, getAnthropicKey, getGroqAccounts } = require('./packages/core/lib/llm-keys');
initHubConfig().then(ok => {
  console.log('Hub:', ok ? '✅' : '⏭️ 폴백');
  console.log('Anthropic:', getAnthropicKey() ? '✅ 있음' : '❌ 없음');
  console.log('Groq:', getGroqAccounts().length + '개');
});
"

echo ""
echo "=== 5. 기존 호환성 (Hub 없이 동작) ==="
USE_HUB_SECRETS=false node -e "
const { getAnthropicKey } = require('./packages/core/lib/llm-keys');
console.log('로컬 폴백:', getAnthropicKey() ? '✅ 키 있음' : '파일 없음 (DEV 정상)');
"

echo ""
echo "=== 6. PAPER_MODE 직접 참조 검사 ==="
DIRECT=$(grep -rn "process.env.PAPER_MODE" --include="*.js" bots/investment/ | grep -v "shared/secrets.js" | grep -v node_modules | wc -l)
echo "secrets.js 외 직접 참조: ${DIRECT}건 (0이어야 정상)"

echo ""
echo "=== 7. initHubSecrets export 확인 ==="
grep "initHubSecrets" bots/investment/shared/secrets.js | head -3
grep "initHubSecrets" bots/reservation/lib/secrets.js | head -3
```

---

## 커밋 메시지

```
feat(secrets): Hub 시크릿 커넥터 구현 (P5)

- hub-client.js: Hub API 호출 유틸리티 신규 (fetchHubSecrets)
- env.js: USE_HUB_SECRETS 플래그 추가 (OPS+DEV 모두 지원)
- llm-keys.js: initHubConfig() 추가 (Hub 1순위 → 로컬 폴백)
- investment/secrets.js: initHubSecrets() 추가 (계통 2)
- reservation/secrets.js: initHubSecrets() 추가 (계통 3)
- 진입점 3개 수정 → 하위 54곳 자동 Hub 경유
- 기존 동기 API 100% 하위 호환
```

---

## 주의사항

1. **initHubConfig()/initHubSecrets()는 선택적**. 호출하지 않으면 기존대로 동작.
   향후 각 팀 봇의 시작점에서 `await initHubConfig()`을 추가하면 완성.
2. **Hub 자체(bots/hub/)는 config.yaml을 직접 읽음** — 순환 의존 없음.
3. **fetch()는 Node.js 18+ 내장**. 프로젝트 v25.8.2이므로 패키지 추가 불필요.
4. **ESM/CJS 혼용**: hub-client.js는 CJS. investment/secrets.js(ESM)에서 `_require()`로 로드.
5. **hostname 안전장치**는 getTradingMode()에 이미 구현됨 (P5와 독립, 변경 없음).
6. **Hub 미가동 시**: 타임아웃 3초 후 null 반환 → 로컬 파일 폴백. 봇 동작에 영향 없음.

---

## 수정 파일 요약

| 파일 | 작업 | 변경량 |
|------|------|--------|
| `packages/core/lib/env.js` | USE_HUB_SECRETS 추가 | +3줄 |
| `packages/core/lib/hub-client.js` | **신규 생성** | ~30줄 |
| `packages/core/lib/llm-keys.js` | 전체 교체 (initHubConfig 추가) | 65→85줄 |
| `bots/investment/shared/secrets.js` | initHubSecrets + _hubClient 추가 | +50줄 |
| `bots/reservation/lib/secrets.js` | initHubSecrets 추가 | +20줄 |
