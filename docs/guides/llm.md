# LLM API 개발 문서 참조

> AI Agent System에서 사용하는 모든 LLM API 참조 문서
> 최종 업데이트: 2026-04-17
> 주의: 이 문서는 `현재 배포 모델`과 `공식 최신 모델 계열`을 함께 기록한다. 운영 중인 로컬 MLX 모델은 `qwen2.5-7b / deepseek-r1-32b / qwen3-embed-0.6b / gemma4:latest(alias)`이고, 공식 최신 계열 참고선은 `Qwen3 / Qwen3 Embedding / Gemma 3·3n / DeepSeek V3.x`다.

---

## 목차

1. [Claude API (Anthropic)](#1-claude-api-anthropic)
2. [Gemini API (Google)](#2-gemini-api-google)
3. [Groq API](#3-groq-api)
4. [Cerebras API](#4-cerebras-api)
5. [OpenAI API](#5-openai-api)
6. [SambaNova API](#6-sambanova-api)
7. [xAI Grok API](#7-xai-grok-api)
8. [DeepSeek + Qwen (MLX 로컬)](#8-deepseek--qwen-mlx-로컬)
9. [Telegram Bot API](#9-telegram-bot-api)
10. [Legacy Gateway (Retired)](#10-legacy-gateway-retired)
11. [멀티에이전트 시스템용 모델 선택 가이드](#11-멀티에이전트-시스템용-모델-선택-가이드)

---

## 1. Claude API (Anthropic)

### 1.1 모델 목록 및 스펙

| 모델 ID | 컨텍스트 | 최대 출력 | 용도 |
|---------|---------|---------|------|
| `claude-opus-4-6` | 200K (1M beta) | **128,000** | 최고 성능, 복잡한 추론 |
| `claude-sonnet-4-6` | 200K (1M beta) | 64,000 | 균형형 — 오케스트레이터 권장 |
| `claude-sonnet-4-5` | 200K | 64,000 | 고성능 에이전트·코딩 |
| `claude-haiku-4-5` / `claude-haiku-4-5-20251001` | 200K | 64,000 | 최저 레이턴시 — 고빈도 봇 권장 |

**⚠️ Deprecated**: `claude-3-haiku-20240307` → **2026-04-19 삭제 예정** — `claude-haiku-4-5` 로 마이그레이션 필요

**1M 컨텍스트 (Beta):** `anthropic-beta: context-1m-2025-08-07` 헤더 필요
200K 초과 요청은 long-context 프리미엄 요금 적용 (입력 2배, 출력 1.5배)

### 1.2 가격 (1M 토큰당)

| 모델 | 입력 | 출력 | 캐시 쓰기 | 캐시 읽기 |
|------|------|------|---------|---------|
| Opus 4.6 | $5.00 | $25.00 | $6.25 (+25%) | $0.50 (10%) |
| Sonnet 4.6 / 4.5 | $3.00 | $15.00 | $3.75 (+25%) | $0.30 (10%) |
| Haiku 4.5 | $1.00 | $5.00 | $1.25 (+25%) | $0.10 (10%) |

### 1.3 Tool Use (함수 호출)

```javascript
// 요청 형식
{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 4096,
  "tools": [
    {
      "name": "get_order_book",
      "description": "Fetch current order book for a trading pair",
      "input_schema": {
        "type": "object",
        "properties": {
          "symbol": { "type": "string", "description": "e.g. BTC/USDT" },
          "depth":  { "type": "integer", "default": 10 }
        },
        "required": ["symbol"]
      },
      "strict": true  // 권장: 스키마 강제 적용, 오류 감소
    }
  ],
  "messages": [{ "role": "user", "content": "BTC/USDT 호가창 보여줘" }]
}

// 응답 (stop_reason: "tool_use")
{
  "content": [
    { "type": "text", "text": "주문서를 확인하겠습니다." },
    {
      "type": "tool_use",
      "id": "toolu_01A09q90qw90",
      "name": "get_order_book",
      "input": { "symbol": "BTC/USDT", "depth": 10 }
    }
  ],
  "stop_reason": "tool_use"
}

// 툴 결과 반환
{
  "role": "user",
  "content": [{
    "type": "tool_result",
    "tool_use_id": "toolu_01A09q90qw90",
    "content": "{\"bid\": 65100.5, \"ask\": 65101.2}"
  }]
}
```

**tool_choice 옵션:**
```javascript
"tool_choice": { "type": "auto" }              // 모델 자동 판단 (기본값)
"tool_choice": { "type": "any" }               // 최소 1개 툴 강제 호출
"tool_choice": { "type": "tool", "name": "execute_order" }  // 특정 툴 강제
"tool_choice": { "type": "none" }              // 툴 비활성화
```

**병렬 툴 호출:** content 배열에 여러 `tool_use` 블록이 올 수 있음 → Promise.all로 병렬 실행 후 한 번에 반환

### 1.4 스트리밍

```javascript
// SSE 이벤트 타입
"message_start"       // 초기 메시지 메타데이터
"content_block_start" // 새 블록 시작 (text 또는 tool_use)
"content_block_delta" // text_delta 또는 input_json_delta
"content_block_stop"  // 블록 종료
"message_delta"       // stop_reason 업데이트
"message_stop"        // 스트림 완료
"thinking_delta"      // Extended thinking 내용
```

tool_use 블록: `input_json_delta` 문자열 누적 → `content_block_stop` 시 JSON 파싱

### 1.5 Extended Thinking (심층 추론)

```javascript
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 16000,
  "thinking": { "type": "enabled", "budget_tokens": 10000 },
  "messages": [...]
}

// 도구 호출 사이 생각 (Interleaved):
// Header: anthropic-beta: interleaved-thinking-2025-05-14
```

**"Think" 툴 패턴** (거래 결정 전 강제 추론):
```javascript
{
  "name": "think",
  "description": "중요한 결정 전 반드시 이 툴로 추론 과정을 기록하세요",
  "input_schema": {
    "type": "object",
    "properties": { "thought": { "type": "string" } },
    "required": ["thought"]
  }
}
```

### 1.6 Prompt Caching (비용 최적화 핵심)

> **✅ 2024-12-17 GA** — `prompt-caching-2024-07-31` 베타 헤더 더 이상 불필요

**방법 1: 명시적 캐싱 (content 블록에 cache_control)**
```javascript
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "[대용량 시스템 프롬프트 / 거래 규칙 / 정적 컨텍스트]",
      "cache_control": { "type": "ephemeral" }        // 5분 TTL (기본값)
      // 1시간 TTL: { "type": "ephemeral", "ttl": "1h" }  // 비용 2배, 히트 시 10%
    },
    { "type": "text", "text": "현재 BTC 시세: $65,100" }
  ]
}
```

**방법 2: 자동 캐싱 (2026-02-19 신규, 요청 최상위 cache_control)**
```javascript
// 마지막 캐시 가능 블록에 자동 적용 (멀티턴 대화 히스토리 자동 캐싱)
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "cache_control": { "type": "ephemeral" },   // 5분 TTL
  // "cache_control": { "type": "ephemeral", "ttl": "1h" },  // 1시간 TTL
  "messages": [...]
}
```

- 캐시 쓰기: +25% (5min) / +100% (1h) | 캐시 읽기: 10% (최대 90% 비용 절감)
- **캐시 토큰은 ITPM 한도에 미포함** → 고빈도 봇의 Rate Limit 여유 확보
- 워크스페이스 단위 격리 (2026-02-05, 조직 공유 → 워크스페이스 분리)

### 1.7 Rate Limits

- 토큰 버킷 알고리즘 (순간 버스트 가능, 평균 유지)
- RPM / ITPM / OTPM 동시 적용, 먼저 도달하는 것이 제한
- 응답 헤더: `anthropic-ratelimit-requests-remaining`, `anthropic-ratelimit-tokens-reset`, `retry-after`
- 429 응답 시: `retry-after` 헤더 값으로 지수 백오프

### 1.8 멀티에이전트 패턴

```
Orchestrator (Sonnet 4.6)
  ├── Subagent A: 시장 데이터 수집 (Haiku 4.5)  — 읽기 전용 툴
  ├── Subagent B: 리스크 계산    (Haiku 4.5)  — 읽기 전용 툴
  └── Subagent C: 주문 실행      (Sonnet 4.5) — 실행 툴

각 서브에이전트 = 독립 POST /v1/messages 호출 (컨텍스트 격리)
```

**핵심 원칙:**
- 서브에이전트는 필요한 컨텍스트만 전달 (컨텍스트 소진 방지)
- 구조화된 JSON 보고서로 에이전트 간 핸드오프 (telephone effect 방지)
- 각 `tool_use` id 로깅 필수 (감사 추적)

---

## 2. Gemini API (Google)

### 2.1 모델 목록 및 스펙

| 모델 ID | 컨텍스트 | 최대 출력 | 상태 |
|---------|---------|---------|------|
| `gemini-2.5-pro` | 1,048,576 | 65,536 | GA — 최고 성능 |
| `gemini-2.5-flash` | 1,048,576 | 65,536 | GA ← **현재 권장** (Hub selector 후보) |
| `gemini-3.1-pro-preview` | — | — | Preview — 3세대 최신 |
| `gemini-3-flash-preview` | — | — | Preview — 3세대 Flash |
| `gemini-3.1-flash-lite-preview` | — | — | Preview — 최경량 |
| ~~`gemini-2.0-flash`~~ | — | — | ❌ **지원 중단** (→ 2.5-flash로 교체) |
| ~~`gemini-2.0-flash-lite`~~ | — | — | ❌ **지원 중단** |

> **3세대 (gemini-3.x)**: 아직 Preview 단계 — 프로덕션은 2.5 시리즈 권장
> **gemini-3-pro-preview**: 2026-03-09 종료 예정 → gemini-3.1-pro-preview로 마이그레이션

### 2.2 가격 (1M 토큰당)

| 모델 | 입력 | 출력 |
|------|------|------|
| gemini-2.0-flash | $0.10 | $0.40 |
| gemini-2.5-flash | $0.30 | $2.50 |
| gemini-2.5-pro (≤200K) | ~$1.25 | ~$10.00 |

**멀티모달 토큰 비용:**
- 이미지 (≤384px): 258 토큰
- 이미지 (타일): 258 토큰/타일 (768×768px)
- 오디오: 32 토큰/초
- 비디오: 263 토큰/초

### 2.3 Free Tier Rate Limits

| 모델 | RPM | TPM | RPD |
|------|-----|-----|-----|
| gemini-2.5-flash | 10 | 250,000 | 250 |
| gemini-2.5-flash-lite | 15 | 250,000 | 1,000 |
| gemini-2.5-pro | 5 | 250,000 | 100 |

**⚠️ Rate limit은 Google Cloud 프로젝트 단위 적용** (API 키 여러 개 만들어도 동일)

### 2.4 google-gemini-cli OAuth vs API Key

| 항목 | OAuth (구글 계정) | API Key |
|------|----------------|---------|
| RPM | ~60 | 5–15 |
| RPD | ~1,000 | 100–1,000 |
| 비용 | 무료 (개인계정) | 무료 티어 + 유료 |
| 컨텍스트 캐싱 | **지원 안 함** | 지원 |

현재 Hub selector가 OAuth/API key 경로를 직접 관리한다. OAuth 경로는 캐싱 불가, RPD 상대적으로 유리하다.

### 2.5 Function Calling (Node.js)

```javascript
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: [{ functionDeclarations: [placeOrderDeclaration] }],
    toolConfig: {
        functionCallingConfig: {
            mode: "AUTO"  // AUTO | ANY | NONE
        }
    }
});

const result = await model.generateContent("BTC 0.01 시장가 매수");
const part = result.response.candidates[0].content.parts[0];

if (part.functionCall) {
    const toolResult = await executeFunction(part.functionCall.name, part.functionCall.args);

    // 결과를 대화 히스토리에 추가 후 최종 응답 요청
    const finalResult = await model.generateContent([
        { role: "user", parts: [{ text: "BTC 0.01 시장가 매수" }] },
        { role: "model", parts: [{ functionCall: part.functionCall }] },
        { role: "user", parts: [{ functionResponse: { name: part.functionCall.name, response: { result: toolResult } } }] }
    ]);
}
```

**병렬 툴 호출:**
```javascript
const functionCalls = parts.filter(p => p.functionCall);
const results = await Promise.all(
    functionCalls.map(p => executeFunction(p.functionCall.name, p.functionCall.args))
);
```

### 2.6 gemini-2.0-flash → gemini-2.5-flash 마이그레이션 ✅ 완료

```bash
# Hub/team selector 설정 변경
# 팀별 selector config 또는 Hub LLM route 정책에서 모델을 교체한다.

# 주의사항:
# - 2.5-flash는 thinking 토큰 있음 (thinking_budget 파라미터로 제어)
# - 함수 호출 API 형식 동일 (drop-in 교체)
# - 이전 <execute_tool> 누출 버그 재테스트 권장
```

---

## 3. Groq API

### 3.1 모델 목록 (2026-03-05 실제 API 기준)

#### 주요 채팅 모델

| 모델 ID | 컨텍스트 | RPM | TPM | RPD | TPD | 비고 |
|---------|---------|-----|-----|-----|-----|------|
| `meta-llama/llama-4-scout-17b-16e-instruct` | 128K | 30 | **30,000** | 1,000 | 500K | **루나팀 현재 사용** (Preview) |
| `meta-llama/llama-4-maverick-17b-128e-instruct` | 128K | 30 | 6,000 | 500 | 500K | 400B total MoE (Preview) |
| `llama-3.3-70b-versatile` | 128K | 30 | 12,000 | 1,000 | — | 고품질 분석 (Production) |
| `llama-3.1-8b-instant` | 128K | 30 | 6,000 | 14,400 | — | 최고속 TTFT 216ms (Production) |
| `moonshotai/kimi-k2-instruct` | **262K** | **60** | 10,000 | 1,000 | 300K | 최대 컨텍스트 |
| `moonshotai/kimi-k2-instruct-0905` | **262K** | **60** | 10,000 | 1,000 | 300K | kimi-k2 스냅샷 버전 |
| `qwen/qwen3-32b` | 32K | **60** | 6,000 | 500 | 500K | RPM 높음 |
| `openai/gpt-oss-120b` | — | — | — | — | — | OpenAI 오픈소스 120B |
| `openai/gpt-oss-20b` | — | — | — | — | — | OpenAI 오픈소스 20B |

#### 에이전트/복합 모델

| 모델 ID | 비고 |
|---------|------|
| `groq/compound` | 웹검색 + 코드 실행 내장 에이전트 |
| `groq/compound-mini` | 경량 복합 에이전트 |

#### 음성 인식 모델

| 모델 ID | 비고 |
|---------|------|
| `whisper-large-v3` | 최고 정확도 STT |
| `whisper-large-v3-turbo` | 빠른 STT |

**⚠️ llama-4-scout 상태**: Preview — 모델 ID 변경 가능성 있음, 주기적 확인 필요
**속도**: Gemini보다 약 3배 빠름. 에이전트 루프에 최적.
**Rate limit**: 조직(API 키) 단위 적용. 9키 라운드로빈 = RPD 9,000 / TPD 4.5M 실질 한도.

### 3.2 설치 및 기본 사용 (Node.js)

```bash
npm install groq-sdk
```

```javascript
import Groq from 'groq-sdk';

const client = new Groq({
    apiKey: process.env.GROQ_API_KEY,
    maxRetries: 3,     // 429/5xx 자동 재시도
    timeout: 20_000,
});

// OpenAI SDK 호환 방식 (baseURL만 변경)
import OpenAI from 'openai';
const openaiCompatible = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
});
```

### 3.3 Tool Calling (4단계 패턴)

```javascript
const tools = [{
    type: 'function',
    function: {
        name: 'get_asset_price',
        description: '암호화폐 현재 시세 조회',
        parameters: {
            type: 'object',
            properties: {
                symbol:   { type: 'string', description: 'e.g. BTC, ETH' },
                currency: { type: 'string', enum: ['USD', 'KRW'], default: 'USD' },
            },
            required: ['symbol'],
        },
    },
}];

async function runAgent(query) {
    const messages = [
        { role: 'system', content: '트레이딩 어시스턴트입니다.' },
        { role: 'user', content: query },
    ];

    // Step 1: 초기 요청
    const response = await client.chat.completions.create({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',  // 최고 TPM
        messages, tools,
        tool_choice: 'auto',
        parallel_tool_calls: true,  // 병렬 호출 활성화
        temperature: 0.1,
    });

    const msg = response.choices[0].message;
    messages.push(msg);

    // Step 2: 툴 호출 필요 시
    if (msg.tool_calls) {
        // Step 3: 병렬 실행
        const results = await Promise.all(
            msg.tool_calls.map(async (tc) => {
                const result = await executeToolLocally(tc.function.name, JSON.parse(tc.function.arguments));
                return { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) };
            })
        );

        messages.push(...results);

        // Step 4: 최종 응답
        const final = await client.chat.completions.create({
            model: 'meta-llama/llama-4-scout-17b-16e-instruct',
            messages, temperature: 0.1,
        });
        return final.choices[0].message.content;
    }

    return msg.content;
}
```

### 3.4 스트리밍 + 툴 호출

```javascript
const stream = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages, tools, stream: true,
});

let toolCalls = [];

for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (delta?.content) process.stdout.write(delta.content);

    // 툴 호출 청크 수집 (실제로는 한 청크로 옴)
    if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
            if (!toolCalls[tc.index]) toolCalls[tc.index] = { function: { arguments: '' } };
            toolCalls[tc.index].id ??= tc.id;
            toolCalls[tc.index].function.name ??= tc.function?.name;
            toolCalls[tc.index].function.arguments += tc.function?.arguments ?? '';
        }
    }
}
```

### 3.5 투자팀 Groq 할당량 분석

```
5분 주기 = 288 사이클/일

모델 배정:
- 기술 분석가: llama-3.3-70b  → 288/일 vs 한도 1,000/일 = 71% 여유
- 온체인/뉴스:  llama-3.1-8b  → 576/일 vs 한도 14,400/일 = 96% 여유
- 강세/약세:    claude-haiku   → 576/일 (Groq 불필요)

결론: 단일 계정으로도 충분. 멀티계정은 안전망용.
```

**멀티계정 라운드로빈:**
```javascript
function getNextGroqKey(model) {
    const limit = model.includes('70b') ? 1000 : 14400;
    return groqAccounts
        .filter(a => a.dailyUsed < limit * 0.8)
        .sort((a, b) => a.dailyUsed - b.dailyUsed)[0];
}
```

---

## 4. Cerebras API

### 4.1 모델 목록

| 모델 ID | 컨텍스트 | RPM | TPD | 속도 | 용도 |
|---------|---------|-----|-----|------|------|
| `llama3.1-8b` | 128K | 60 | 1,000,000 | 매우 빠름 | 온체인분석가 — 고빈도 처리 |
| `llama-3.3-70b` | 128K | 30 | 1,000,000 | 빠름 | 고품질 분석 |

**무료 티어 특징:**
- 1M TPD — Groq(500K)보다 2배 이상 넉넉
- Cerebras WSE(웨이퍼 스케일 엔진) 기반 → 70B 모델도 8B와 유사한 지연시간
- 일일 리셋: 00:00 UTC (= 09:00 KST)

### 4.2 설정

```bash
# API 키 발급: https://cloud.cerebras.ai
export CEREBRAS_API_KEY="..."
# Base URL: https://api.cerebras.ai/v1  (OpenAI 호환)
```

secrets.json 등록:
```json
{ "cerebras_api_key": "YOUR_CEREBRAS_API_KEY" }
```

### 4.3 기본 사용 (OpenAI SDK 호환)

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
    apiKey: process.env.CEREBRAS_API_KEY,
    baseURL: 'https://api.cerebras.ai/v1',
});

const response = await client.chat.completions.create({
    model: 'llama3.1-8b',
    messages: [
        { role: 'system', content: '온체인 데이터 분석 전문가입니다.' },
        { role: 'user', content: userMessage },
    ],
    max_tokens: 256,
    temperature: 0.1,
});

const text  = response.choices[0].message.content;
const usage = response.usage; // prompt_tokens, completion_tokens, total_tokens
```

직접 HTTPS 사용 (lib/groq.js 방식):
```javascript
// POST https://api.cerebras.ai/v1/chat/completions
// 헤더: Authorization: Bearer <key>, Content-Type: application/json
// 바디: OpenAI /v1/chat/completions와 동일
```

### 4.4 루나팀 할당량 분석

```
5분 주기 = 288 사이클/일

온체인분석가: llama3.1-8b 1회/사이클
  → 288 calls/일
  → ~500 토큰/호출 × 288 = ~144,000 토큰/일
  → 한도 1,000,000 TPD 대비 14.4% 사용 — 여유 충분

결론: Groq와 분산 배치해도 한도 걱정 없음
```

---

## 5. OpenAI API

### 5.1 모델 목록 (2026-03-05 기준)

#### 표준 챗 모델

| 모델 ID | 컨텍스트 | 입력 $/1M | 출력 $/1M | 특징 |
|---------|---------|---------|---------|------|
| `gpt-4o` | 128K | $2.50 | $10.00 | 고성능 멀티모달 |
| `gpt-4o-mini` | 128K | $0.15 | $0.60 | 최고 가성비 경량모델 — **테스트 716ms** |
| `gpt-4.1` | **1M** | $2.00 | $8.00 | 1M 컨텍스트, 코딩 특화 |
| `gpt-4.1-mini` | **1M** | $0.40 | $1.60 | 균형형 1M 컨텍스트 — **테스트 1078ms** |
| `gpt-4.1-nano` | **1M** | $0.10 | $0.40 | 최저 비용, 분류·추출 |

#### 추론 모델 (o-series)

| 모델 ID | 컨텍스트 | 특징 |
|---------|---------|------|
| `o3` | 200K | 최고 추론 능력, 코딩·수학 |
| `o3-mini` | 200K | 균형형 추론 |
| `o4-mini` | 200K | 고성능 추론 + 속도 균형 — **테스트 1575ms** |

**⚠️ o-series 필수 주의**: `max_tokens` 대신 `max_completion_tokens` 파라미터 사용 (아래 §5.4 참고)

### 5.2 설정

```bash
export OPENAI_API_KEY="sk-..."
# Base URL: https://api.openai.com/v1
# OpenAI SDK: npm install openai
```

secrets.json 등록:
```json
{ "openai_api_key": "YOUR_OPENAI_API_KEY" }
```

### 5.3 기본 사용 (챗 모델)

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
        { role: 'system', content: '트레이딩 어시스턴트입니다.' },
        { role: 'user', content: '현재 BTC 투자 전략을 분석해줘' },
    ],
    max_tokens: 500,
    temperature: 0.1,
});

const text  = response.choices[0].message.content;
const usage = response.usage; // prompt_tokens, completion_tokens, total_tokens
```

HTTPS 직접 사용:
```javascript
// POST https://api.openai.com/v1/chat/completions
// 헤더: Authorization: Bearer <key>, Content-Type: application/json
// 바디: { model, messages, max_tokens, temperature }
```

### 5.4 추론 모델 (o-series) — max_completion_tokens 필수

```javascript
// ⚠️ o-series (o1/o3/o4-mini): max_tokens 불가 → max_completion_tokens 사용
const response = await client.chat.completions.create({
    model: 'o4-mini',
    messages: [
        { role: 'user', content: '이 트레이딩 전략의 리스크를 분석해줘' },
    ],
    max_completion_tokens: 500,  // ← max_tokens 아님! 400 에러 발생
    // temperature 미지원 (추론 모델은 고정)
    // reasoning_effort: 'medium'  // 선택사항: 'low' | 'medium' | 'high'
});

const text = response.choices[0].message.content;
```

### 5.5 테스트 결과 (2026-03-05)

| 모델 | TTFT | 상태 |
|------|------|------|
| `gpt-4o-mini` | 716ms | ✅ |
| `gpt-4.1-mini` | 1078ms | ✅ |
| `o4-mini` | 1575ms | ✅ (max_completion_tokens) |

---

## 6. SambaNova API

### 6.1 모델 목록

| 모델 ID | 컨텍스트 | 용도 |
|---------|---------|------|
| `Meta-Llama-3.3-70B-Instruct` | 128K | 감성분석가 — 고품질 70B |
| `Meta-Llama-3.1-8B-Instruct` | 128K | 경량 처리 |
| `Qwen2.5-72B-Instruct` | 128K | 고급 추론 |

**무료 티어 특징:**
- 영구 무료 티어 (daily limit 있음)
- 공식 TPD 수치 미공개 — 보수적으로 10,000 토큰/일로 추정
- 일일 리셋: 00:00 UTC (= 09:00 KST)
- 70B 고성능 모델 무료 제공이 핵심 장점

### 6.2 설정

```bash
# API 키 발급: https://cloud.sambanova.ai
export SAMBANOVA_API_KEY="..."
# Base URL: https://api.sambanova.ai/v1  (OpenAI 호환)
```

secrets.json 등록:
```json
{ "sambanova_api_key": "YOUR_SAMBANOVA_API_KEY" }
```

### 6.3 기본 사용 (OpenAI SDK 호환)

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
    apiKey: process.env.SAMBANOVA_API_KEY,
    baseURL: 'https://api.sambanova.ai/v1',
});

const response = await client.chat.completions.create({
    model: 'Meta-Llama-3.3-70B-Instruct',
    messages: [
        { role: 'system', content: '암호화폐 커뮤니티 감성분석 전문가입니다.' },
        { role: 'user', content: userMessage },
    ],
    max_tokens: 256,
    temperature: 0.1,
});

const text  = response.choices[0].message.content;
const usage = response.usage;
```

### 6.4 루나팀 할당량 주의사항

```
⚠️ 공식 TPD 수치 미확인 — 보수적으로 10,000 TPD 추정

5분 주기 = 288 사이클/일

감성분석가: Meta-Llama-3.3-70B-Instruct 1회/사이클
  → 288 calls/일
  → ~800 토큰/호출 × 288 = ~230,400 토큰/일
  → 추정 10K TPD 대비 초과 위험

대응: 감성 분석은 10~20분 주기로 완화, 또는 Groq fallback 활용
TODO: SambaNova 실제 한도 확인 후 llm-candidates.json 및 이 문서 갱신
```

---

## 7. xAI Grok API

### 7.1 모델 목록 및 가격

| 모델 ID | 컨텍스트 | 입력 $/1M | 출력 $/1M | 특징 |
|---------|---------|---------|---------|------|
| `grok-4-0709` | 256K | $3.00 | $15.00 | 최강 추론, 이미지 입력 |
| `grok-4-fast-reasoning` | 2M | $0.20 | $0.50 | 추론 + 함수호출, 대형 컨텍스트 |
| `grok-3-mini` | 131K | $0.30 | $0.50 | **최고 가성비** — 에이전트 루프 |
| `grok-3` | 131K | $3.00 | $15.00 | 함수호출, 구조화 출력 |

**서버사이드 툴 비용:**
- Web Search: $5/1K calls
- X (Twitter) Search: $5/1K calls
- Code Execution: $5/1K calls

**무료 크레딧:** 가입 시 $25 + 데이터 공유 시 $150/월 = 최대 $175/월

### 7.2 설정

```bash
export XAI_API_KEY="xai-..."
# Base URL: https://api.x.ai/v1
# OpenAI SDK 완전 호환
```

### 7.3 Function Calling (커스텀 툴)

OpenAI SDK 방식과 동일:
```javascript
import OpenAI from 'openai';

const client = new OpenAI({
    apiKey: process.env.XAI_API_KEY,
    baseURL: 'https://api.x.ai/v1',
});

const response = await client.chat.completions.create({
    model: 'grok-3-mini',
    messages,
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: true,  // 기본 활성화
    temperature: 0.1,
});
```

### 7.4 Live Search — X 실시간 데이터 (핵심 차별점)

```javascript
// Responses API 사용 (구 Live Search API는 2026-01-12 종료)
const response = await client.responses.create({
    model: 'grok-3-mini',
    input: [
        { role: 'system', content: '암호화폐 트레이딩 어시스턴트' },
        { role: 'user', content: 'BTC X(트위터) 최신 반응 분석해줘' },
    ],
    tools: [
        { type: 'web_search' },   // 실시간 웹 뉴스
        { type: 'x_search' },     // X/Twitter 라이브 포스트
        // 커스텀 툴 혼합 가능:
        {
            type: 'function',
            function: {
                name: 'get_btc_price',
                description: '거래소 BTC 현재가 조회',
                parameters: { type: 'object', properties: {}, required: [] },
            },
        },
    ],
});
```

**감성 분석봇에 활용**: X 실시간 데이터는 Reddit보다 선행 지표 → `grok-3-mini` + `x_search`로 감성 분석가 구현 가능

---

## 8. DeepSeek + Qwen (MLX 로컬)

현재 OPS 로컬 서버는 Ollama가 아니라 `MLX OpenAI 호환 서버(:11434)`를 사용한다.

- 현재 배포 fast: `qwen2.5-7b`
- 현재 배포 deep: `deepseek-r1-32b`
- 현재 배포 embedding: `qwen3-embed-0.6b`
- 현재 배포 Gemma 파일럿: `gemma4:latest` (`gemma-4-e2b-it-4bit` 로컬 alias)

최신 공식 계열 관점에서는 다음 라인이 더 최신이다.

- Qwen: `Qwen3`
- 임베딩: `Qwen3 Embedding`
- Gemma: `Gemma 3 / 3n`
- DeepSeek: `DeepSeek V3.x`

### 8.1 DeepSeek R1 모델 변형 및 요구 RAM

| 변형 | Pull 명령 | 파일 크기 | 최소 RAM |
|------|----------|---------|---------|
| 7B | `ollama pull deepseek-r1:7b` | 4.7 GB | 8 GB |
| 14B | `ollama pull deepseek-r1:14b` | 9.0 GB | 16 GB |
| 32B | `ollama pull deepseek-r1:32b` | 20 GB | 32 GB |
| 70B | `ollama pull deepseek-r1:70b` | 43 GB | 64 GB |

**M4 Pro 64GB 성능 (Q4 양자화, Ollama):**
| 모델 | 토큰/초 | 권장도 |
|------|--------|-------|
| 14B | ~20–28 t/s | ⭐ 최적 (학술봇, 백테스팅) |
| 32B | ~11–14 t/s | 사용 가능 |

### 8.2 Thinking 모드 (CoT 추론)

```javascript
import ollama from 'ollama';

const response = await ollama.chat({
    model: 'deepseek-r1:14b',
    think: true,       // CoT 추론 활성화
    messages: [{ role: 'user', content: '이 트레이딩 전략의 리스크를 분석해줘' }]
});

console.log('추론 과정:', response.message.thinking);  // <think>...</think>
console.log('최종 답변:', response.message.content);

// 빠른 응답이 필요할 때 (think: false로 CoT 비활성화)
```

REST API:
```bash
curl http://127.0.0.1:11434/api/chat -d '{
  "model": "deepseek-r1:14b",
  "think": true,
  "messages": [{ "role": "user", "content": "..." }],
  "stream": false
}'
```

### 8.3 Tool Calling 현황

**⚠️ 중요**: 표준 Ollama 레지스트리의 deepseek-r1은 tools API 미지원 (pre-0528 버전)

**해결책 A** (커뮤니티 모델):
```bash
ollama pull MFDoom/deepseek-r1-tool-calling:14b
```

**해결책 B** (권장, 아키텍처 분리):
```
deepseek-r1:14b   → 추론 전담 (think=true)
qwen2.5:7b       → 툴 호출 전담
```

### 8.4 Qwen 2.5 모델 변형

| 변형 | Pull 명령 | RAM |
|------|----------|-----|
| 7B (현재 스카봇 RAG) | `ollama pull qwen2.5:7b` | ~8 GB |
| 14B | `ollama pull qwen2.5:14b` | ~16 GB |
| 72B | `ollama pull qwen2.5:72b` | ~64 GB |

- **한국어 지원**: 29개 언어 포함 (한국어 사전학습)
- **Tool Calling**: 네이티브 지원 (qwen2.5:7b 이상 안정적)

### 8.5 Qwen 2.5 Tool Calling (Node.js)

```javascript
import ollama from 'ollama';

const tools = [{
    type: 'function',
    function: {
        name: 'check_availability',
        description: '예약 가능 시간대 조회',
        parameters: {
            type: 'object',
            properties: {
                date: { type: 'string', description: 'YYYY-MM-DD' },
                room: { type: 'string', description: '룸명 (A, B, C)' }
            },
            required: ['date']
        }
    }
}];

let messages = [{ role: 'user', content: '내일 A룸 예약 가능해?' }];
const response = await ollama.chat({ model: 'qwen2.5:7b', messages, tools });

if (response.message.tool_calls) {
    const call = response.message.tool_calls[0].function;
    const result = await executeToolLocally(call.name, call.arguments);

    messages.push(response.message);
    messages.push({ role: 'tool', content: JSON.stringify(result) });

    const finalResponse = await ollama.chat({ model: 'qwen2.5:7b', messages });
    console.log(finalResponse.message.content);
}
```

### 8.6 Ollama 환경 변수 (Mac Mini 서버 설정)

```bash
export OLLAMA_MAX_LOADED_MODELS=3   # 동시 로드 모델 수
export OLLAMA_KEEP_ALIVE=30m        # 유휴 후 언로드 대기 시간
export OLLAMA_NUM_PARALLEL=2        # 모델당 병렬 요청 수
export OLLAMA_HOST=0.0.0.0:11434   # 네트워크 접근 허용

ollama serve
```

**M4 Pro 64GB 메모리 계획:**
```
qwen2.5:7b     → ~6 GB
deepseek-r1:14b → ~10 GB
deepseek-r1:32b → ~22 GB
OS + 여유      → ~8 GB
────────────────────────
합계 (3개 모델): ~46 GB ← 64GB에 적합
```

### 8.7 Ollama API 레퍼런스

**Base URL:** `http://127.0.0.1:11434`

| 엔드포인트 | 용도 |
|-----------|------|
| `POST /api/chat` | 네이티브 (think, keep_alive 지원) |
| `POST /v1/chat/completions` | OpenAI 호환 |

**주요 파라미터:**
```json
{
  "model": "qwen2.5:7b",
  "messages": [...],
  "stream": false,
  "think": true,
  "tools": [...],
  "format": "json",
  "keep_alive": "30m",
  "options": { "temperature": 0.1, "num_ctx": 8192 }
}
```

---

## 9. Telegram Bot API

> **최신 버전: Bot API 9.5** (2026-03-01 릴리스)

### 9.1 parse_mode 옵션

| parse_mode | 상태 | 사용 |
|-----------|------|------|
| `HTML` | ✅ 현재 권장 | 특수문자 이스케이프 불필요 (단, `<>&` → `&lt;&gt;&amp;`) |
| `MarkdownV2` | ✅ 권장 | 특수문자 `\` 이스케이프 필수 (복잡) |
| `Markdown` (legacy) | ⚠️ 사실상 deprecated | blockquote, spoiler 등 신규 엔티티 미지원 |

**중요**: parse_mode 없이 발송하면 `*bold*`, `_italic_` 등이 그대로 출력됨.

**HTML 지원 태그:**
```html
<b>굵게</b>  <i>이탤릭</i>  <u>밑줄</u>  <s>취소선</s>
<code>인라인코드</code>  <pre>코드블록</pre>
<a href="https://...">링크</a>
<blockquote>인용문 (2025 신규)</blockquote>
<blockquote expandable>접이식 인용문 (2025 신규)</blockquote>
<span class="tg-spoiler">스포일러</span>
```

### 9.2 sendMessage 핵심 파라미터

```javascript
// 기본 메시지 발송
const body = JSON.stringify({
  chat_id: chatId,
  text: '메시지 내용\n<b>굵게</b>',
  parse_mode: 'HTML',              // ← 반드시 지정
  disable_web_page_preview: true,  // 링크 미리보기 비활성화
  // reply_to_message_id: 123,     // 특정 메시지에 답장
});
```

### 9.3 메시지 제한 및 Rate Limit

| 항목 | 제한 |
|------|------|
| 텍스트 메시지 | **4,096자** (초과 시 분할 전송) |
| 미디어 캡션 | 1,024자 |
| 글로벌 발송 속도 | **30 메시지/초** |
| 단일 채팅 | **1 메시지/초** 권장 |
| 그룹 채팅 | **20 메시지/분** |
| 한도 초과 응답 | HTTP 429 + `retry_after` 필드 (초 단위 대기 시간) |

### 9.4 sendMessageDraft (Bot API 9.5 신메서드)

AI 응답을 생성하면서 실시간으로 텍스트를 사용자에게 스트리밍 전송.
2026-03-01부터 모든 봇에 전면 개방 (이전에는 일부 봇만 가능).

### 9.5 시스템 적용 현황

| 파일 | parse_mode | 분할 로직 | 상태 |
|------|-----------|---------|------|
| `bots/reservation/lib/telegram.ts` | ✅ `HTML` (2026-03-04) | ❌ (스카팀 메시지 짧음) | 적용 완료 |
| `bots/orchestrator/src/mainbot.js` | ✅ `HTML` (2026-03-04) | ✅ 4096자 분할 | 적용 완료 |

---

## 10. Legacy Gateway (Retired)

> 과거 운영 기록이다. 현재 LLM 호출 표준 경로는 `Hub -> team selector -> agent`이며, 새 운영 절차는 Hub/selector 문서를 따른다.

### 10.1 주요 변경사항

| 버전 | 주요 변경 |
|------|---------|
| 2026.3.3 (최신) | Telegram 스트리밍 기본값 `"partial"` 모드 (sendMessageDraft 활용) |
| 2026.3.x | 신규 설치 시 `tools.profile` 기본값 `"messaging"` |
| **2026.2.26** | **"ClawJacked" 치명 취약점 패치** (WebSocket 인증 강화) ← 현재 버전 |
| 2026.2.23 | SSRF, XSS, 프롬프트 인젝션, API 키 유출 수정 |

### 10.2 현재 운영 설정

```bash
# 운영 모델은 Hub/team selector에서 관리한다.

# Fallback 1: anthropic/claude-haiku-4-5
# Fallback 2: ollama/qwen2.5:7b

# streamMode 유효 옵션: "partial" | "block" | "off"
# 2026.3.3 업그레이드 시 Telegram 스트리밍 "partial" 모드로 전환됨 (테스트 필요)
```

### 10.3 업그레이드 시 주의사항

```bash
# 은퇴 경로: 새 설치/업그레이드하지 않는다.

# 2026.3.x breaking changes:
# - tools.profile 기본값 변경 (coding → messaging)
# - ACP dispatch 기본 활성화 (비활성화: acp.dispatch.enabled=false)
# - Plugin SDK: api.registerHttpHandler() 제거됨
```

---

## 11. 멀티에이전트 시스템용 모델 선택 가이드

### 11.1 봇별 권장 모델

| 봇 | Primary | Fallback | 이유 |
|----|---------|---------|------|
| 메인봇 (오케스트레이터) | `claude-sonnet-4-6` | `qwen/qwen3-32b` | 최고 에이전트 조율 능력 + 최신 무료 Groq fallback |
| 스카봇 (예약관리) | `gemini-2.5-flash` | `qwen2.5-7b` | 현재 로컬 fast 배포 모델 기준 |
| 투자 메인봇 | `claude-sonnet-4-6` | `gemini-2.5-flash` | 복잡한 멀티에이전트 결정 |
| 기술 분석가 | `meta-llama/llama-4-scout-17b-16e-instruct` (Groq) | `claude-haiku-4-5` | 속도 + 무료 |
| 감성 분석가 | `grok-3-mini` + X검색 | `gemini-2.5-flash` | 실시간 X 데이터 필수 |
| 온체인/뉴스 | `openai/gpt-oss-20b` (Groq) | `claude-haiku-4-5` | 대용량 처리, 무료 |
| 강세/약세 리서처 | `claude-haiku-4-5` | `meta-llama/llama-4-scout-17b-16e-instruct` | 토론 품질 |
| 학술봇/판례봇 | `deepseek-r1-32b` (로컬 배포) | `claude-opus-4-6` | 논문 추론, 비용 무료 |
| 백테스팅 | `deepseek-r1-32b` (로컬 배포) | — | 수학적 추론, 로컬 |
| 일반 태스크 (외부 API) | `gpt-4o-mini` | `gpt-4.1-mini` | OpenAI 호환성 필요 시 |

### 11.2 투자팀 5분 사이클 타임라인

```
T+0s   :  tick 수신
T+0~5s :  [병렬] 기술(Groq Scout) + 감성(Grok X검색) + 온체인(Groq GPT-OSS) + 뉴스(Groq GPT-OSS)
T+5~10s:  [토론] 강세 리서처 ↔ 약세 리서처 (claude-haiku)
T+10~13s: 리스크 매니저 최종 검토 (claude-haiku)
T+13~14s: 투자 메인봇 결정 → 실행봇 명령 (sonnet-4-6)
T+14~15s: 바이낸스/업비트 실행봇 주문 실행 (LLM 없음)
```

### 11.3 비용 최적화 원칙

1. **Groq 무료 모델** → 고빈도 신호 처리 (투자 분석가 4명)
2. **Haiku 4.5** → 에이전트 루프, 툴 호출 (~1/3 Sonnet 비용)
3. **Prompt Caching** → 정적 컨텍스트(거래 규칙, 전략 정의) 캐싱
4. **로컬 MLX** → 장기 분석, 배치 작업 (학술봇, 백테스팅)
5. **수익 기반 업그레이드 로드맵:**
   - $0→$100/월: 현재 (Groq 무료 + Haiku + 로컬)
   - $100→$500/월: 리서처팀 Sonnet으로 업그레이드
   - $500→$2000/월: 분석가팀 Haiku 적용
   - $2000+/월: Opus 투입 검토

### 11.4 에이전트 간 통신 패턴

```
❌ 금지: 메시지 히스토리 전체 전달 (telephone effect - 정보 왜곡)
✅ 권장: 구조화된 JSON 보고서 공유 상태로 저장

예시:
{
  "agent": "technical_analyst",
  "timestamp": "2026-02-27T12:00:00Z",
  "signal": "bullish",
  "confidence": 0.73,
  "indicators": { "rsi": 58, "macd": "cross_up", "bb": "mid_upper" },
  "reasoning": "RSI 58에서 상승 모멘텀..."
}
```

---

*이 문서는 공식 API 문서 웹 서치 기반으로 작성됨. 가격/Rate limit은 변경될 수 있음.*
*갱신 주기: 분기별 또는 주요 API 변경 시.*
