# CODEX_CHRONOS_PHASE_A_OPS — Ollama 서버 설정 + 모델 다운로드

> 실행 대상: 코덱스 (코드 구현)
> 환경: **맥 스튜디오 (OPS)** — 인프라 설정, Git 커밋 없음
> 작성일: 2026-03-30
> 작성자: 메티 (전략+설계)

---

## 배경

Chronos(백테스팅) 구축을 위해 OPS에 로컬 LLM 인프라 필요.
API LLM 비용 비현실적 (1회 백테스트 ~$35) → 로컬 LLM(Ollama) 필수.

### 현재 상태

```
Ollama 바이너리: ✅ 설치됨 (v0.19.0, /opt/homebrew/bin/ollama)
Ollama 서버: ❌ 미실행
모델: ❌ 미다운로드
하드웨어: Mac Studio M4 Max 14코어 36GB RAM
디스크: 291GB 여유
```

---

## 작업 1: Ollama 서버 시작 + 동작 확인

```bash
# 서버 시작 (백그라운드)
ollama serve &

# 서버 동작 확인
curl -s http://localhost:11434/api/version
# 기대: { "version": "0.19.0" }
```

---

## 작업 2: 모델 다운로드

M4 Max 36GB 기준 권장 모델:

```bash
# Layer 2: 감성/뉴스 시뮬레이션 (가벼운 모델, 빠른 추론)
ollama pull qwen2.5:7b
# 약 4.7GB, M4 Max에서 ~40 tok/s

# Layer 3: 종합 판단 시뮬레이션 (무거운 모델, 정밀 추론)
ollama pull deepseek-r1:32b
# 약 19GB, M4 Max에서 ~15 tok/s
```

---

## 작업 3: 모델 동작 확인

```bash
# qwen2.5:7b 테스트
ollama run qwen2.5:7b "BTC 현재 RSI가 72일 때 단기 전망을 한 문장으로."
# 기대: 한국어 or 영어 답변 (동작 확인)

# deepseek-r1:32b 테스트
ollama run deepseek-r1:32b "당신은 트레이딩 팀장. BUY/SELL/HOLD 중 하나만."
# 기대: BUY/SELL/HOLD 중 하나
```

---

## 작업 4: launchd로 자동 실행 등록

OPS 재부팅 시 자동 시작:

새 파일: `~/Library/LaunchAgents/ai.ollama.serve.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.ollama.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/ollama</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/ollama.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/ollama.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OLLAMA_HOST</key>
    <string>127.0.0.1:11434</string>
  </dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/ai.ollama.serve.plist
launchctl list | grep ollama
# 기대: PID  0  ai.ollama.serve
```

---

## 작업 5: Hub에 Ollama 프록시 라우트 추가

DEV에서 Ollama 직접 접근 대신 Hub 경유 (기존 아키텍처 일관성 유지):

```
DEV → Hub :7788/hub/ollama/generate → localhost:11434/api/generate
DEV → Hub :7788/hub/ollama/version  → localhost:11434/api/version

기존 패턴과 동일:
  시크릿: Hub → config.yaml
  DB:     Hub → PostgreSQL :5432
  에러:   Hub → /tmp/*.err.log
  Ollama: Hub → Ollama :11434  ← 신규
```

### 새 파일: `bots/hub/lib/routes/ollama.js`

```javascript
'use strict';

const OLLAMA_BASE = 'http://127.0.0.1:11434';

/**
 * POST /hub/ollama/generate — Ollama 추론 프록시
 * body: { model, prompt, options }
 */
async function ollamaGenerateRoute(req, res) {
  const { model, prompt, options = {} } = req.body || {};
  if (!model || !prompt) {
    return res.status(400).json({ ok: false, error: 'model and prompt required' });
  }

  try {
    const r = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, options }),
      signal: AbortSignal.timeout(120_000),  // deepseek-r1:32b 최대 2분
    });

    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: `ollama ${r.status}` });
    }

    const data = await r.json();
    return res.json({ ok: true, response: data.response, model: data.model });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
}

/**
 * GET /hub/ollama/version — Ollama 서버 상태 확인
 */
async function ollamaVersionRoute(req, res) {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/version`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = await r.json();
    return res.json({ ok: true, ...data });
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
}

/**
 * GET /hub/ollama/models — 설치된 모델 목록
 */
async function ollamaModelsRoute(req, res) {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await r.json();
    return res.json({ ok: true, models: data.models || [] });
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
}

module.exports = { ollamaGenerateRoute, ollamaVersionRoute, ollamaModelsRoute };
```

### hub.js 수정 — Ollama 라우트 등록

기존 에러 라우트 등록 이후에 추가:

```javascript
const { ollamaGenerateRoute, ollamaVersionRoute, ollamaModelsRoute } = require('./lib/routes/ollama');
app.post('/hub/ollama/generate', generalLimiter, ollamaGenerateRoute);
app.get('/hub/ollama/version', generalLimiter, ollamaVersionRoute);
app.get('/hub/ollama/models', generalLimiter, ollamaModelsRoute);
```

인증: `/hub` 하위이므로 기존 `authMiddleware` 자동 적용.
hub.js를 읽고 기존 라우트 등록 패턴을 따를 것.

---

## 완료 기준

```bash
# 1. Ollama 서버 동작
curl -s http://localhost:11434/api/version
# 기대: { "version": "..." }

# 2. 모델 목록
ollama list
# 기대: qwen2.5:7b, deepseek-r1:32b 2개

# 3. launchd 등록
launchctl list | grep ollama
# 기대: PID  0  ai.ollama.serve

# 4. Hub Ollama 라우트 문법 검사
node --check bots/hub/src/hub.js
node --check bots/hub/lib/routes/ollama.js

# 5. Hub 재시작
launchctl kickstart -kp gui/$(id -u)/ai.hub.resource-api

# 6. Hub 경유 Ollama 테스트
source ~/.zprofile
curl -s http://localhost:7788/hub/ollama/version \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" | python3 -m json.tool
# 기대: { "ok": true, "version": "..." }

curl -s http://localhost:7788/hub/ollama/models \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" | python3 -m json.tool
# 기대: { "ok": true, "models": [...] }

curl -s -X POST http://localhost:7788/hub/ollama/generate \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5:7b","prompt":"Say hello"}' | python3 -m json.tool
# 기대: { "ok": true, "response": "...", "model": "qwen2.5:7b" }

# 7. 인증 차단 확인 (토큰 없이)
curl -s http://localhost:7788/hub/ollama/version
# 기대: { "error": "missing_bearer_token" }
```

## 커밋

```
feat(ops): Hub Ollama 프록시 라우트 + Ollama launchd 서비스

- bots/hub/lib/routes/ollama.js: generate/version/models 프록시
- hub.js: Ollama 라우트 등록
- ai.ollama.serve.plist: launchd 자동 실행
- Ollama는 127.0.0.1만 바인딩, Hub 경유로 DEV 접근
```

⚠️ launchd plist는 Git에 포함하지 않음 (시스템 인프라).
Hub 라우트 코드(ollama.js + hub.js 수정)는 Git 커밋.
