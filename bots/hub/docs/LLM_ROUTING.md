# Hub LLM 내부 연동 가이드

> 최종 업데이트: 2026-07-18
>
> 대상: `ai-agent-system` 내부 Node.js/TypeScript, Investment/Luna, Elixir 에이전트

내부 에이전트는 provider SDK나 Hub의 provider 직접 endpoint를 호출하지 않는다. 모든 모델 선택, fallback, timeout, admission, 비용 제한, circuit, 관측은 Hub가 소유한다.

외부 프로젝트는 이 문서가 아니라 `docs/hub/EXTERNAL_LLM_INTEGRATION_GUIDE.md`를 따른다.

현재 `HUB_AUTH_TOKEN` legacy root 호출자는 신뢰된 내부 서비스 경계로 취급한다. `X-Hub-Team`은 라우팅·목록 가시성 가드이며 독립 tenant 인증 수단이 아니다. 신뢰하지 않는 tenant와 root token을 공유하지 않는다.

## 1. 표준 진입점

| 런타임 | 표준 진입점 | 금지 경로 |
| --- | --- | --- |
| Node.js/TypeScript | `packages/core/lib/hub-client.ts`의 `callHubLlm`, `callHubVision`, `callHubEmbedding` | provider SDK, `/hub/llm/oauth`, `/hub/llm/groq` 직접 호출 |
| Investment/Luna | `bots/investment/shared/hub-llm-client.ts` | 팀 코드의 OpenAI/Groq/Claude 직접 fallback |
| Elixir | `Jay.Core.LLM.Selector`와 `Jay.Core.LLM.HubClient` | Hub 실패 후 provider 직접 fallback |

Hub endpoint:

- 짧은 텍스트 호출: `POST /hub/llm/call`
- 장시간 비동기 작업: `POST /hub/llm/jobs`
- 비동기 작업 목록: `GET /hub/llm/jobs?limit=<1..100>`
- 이미지/차트: `POST /hub/llm/vision`
- RAG embedding: `POST /hub/llm/embeddings`
- selector 조회: `GET /hub/llm/selector`
- 기계 판독 연동 계약: `GET /hub/llm/gateway-contract`

새 내부 연동도 구현 전에 현재 계약을 조회한다. `contractVersion` 호환 여부와 `contractRevision`을 기록하고, `contextSources` 및 endpoint별 `requestSchemas.requiredBody`, `requiredContext`, `oneOfBody`를 확인한다. 최상위 `requiredBody`는 구형 소비자 호환용이므로 신규 코드의 기준으로 사용하지 않는다.

```bash
curl -fsS -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "$HUB_BASE_URL/hub/llm/gateway-contract" | \
  jq '{ok, contractVersion, contractRevision, contextSources, requestSchemas, selectorPolicy, providerPolicy, timeoutPolicy, backpressurePolicy}'
```

## 2. 연동 전 등록

새 호출 경로를 추가할 때 아래 두 정본을 먼저 확인한다.

1. `packages/core/lib/llm-model-selector.ts`
   - `selectorKey`와 primary/fallback chain의 정본이다.
   - 호출 코드가 임의 `chain` 또는 raw provider/model을 지정하지 않는다.
2. `bots/hub/lib/runtime-profiles.ts`
   - `callerTeam + runtimePurpose`를 selector와 실행 특성에 연결한다.
   - 새 purpose는 호출 코드보다 먼저 등록한다.

필수 식별 필드:

| 필드 | 규칙 |
| --- | --- |
| `callerTeam` | Hub canonical team 이름을 사용한다. `luna`는 내부적으로 `investment`와 동일 limiter 범위로 정규화된다. |
| `agent` | 실제 호출 주체를 고정된 이름으로 보낸다. |
| `selectorKey` | 승인된 selector 정식 키를 사용한다. 팀 prefix를 생략하지 않는다. |
| `runtimePurpose` | runtime profile로 라우팅할 때는 `runtime-profiles.ts`에 등록된 purpose를 사용한다. 명시적 selector 호출도 안정적인 purpose 문자열을 유지한다. |
| `taskType` | 관측과 호환을 위해 `runtimePurpose`와 같은 값을 권장한다. |
| `requestId` | 재현 가능한 호출 ID를 사용한다. |

`selectorKey`를 생략하려면 `callerTeam + runtimePurpose` 등록이 선행되어야 한다. 등록되지 않은 purpose/selector를 임시 문자열로 계속 호출하지 않는다. 정적 검증의 `static_unregistered_purpose_selectors`가 반드시 `0`이어야 한다.

## 3. Node.js/TypeScript 표준 예제

아래 import 경로는 `bots/<team>/lib` 기준이며 파일 위치에 맞게 상대 경로만 조정한다.

```ts
import {
  HubCallError,
  callHubLlm,
  isHubNoDirectFallbackFailure,
} from '../../../packages/core/lib/hub-client.ts';

export async function classifyComment(text: string): Promise<string> {
  try {
    const response = await callHubLlm({
      callerTeam: 'blog',
      agent: 'commenter',
      selectorKey: 'blog.commenter.classify',
      runtimePurpose: 'comment_classification',
      taskType: 'comment_classification',
      requestId: `blog-comment-${Date.now()}`,
      abstractModel: 'anthropic_haiku',
      systemPrompt: '댓글 의도를 하나의 짧은 라벨로 분류한다.',
      prompt: text,
      maxTokens: 120,
      maxBudgetUsd: 0.01,
    });
    return response.text;
  } catch (error) {
    if (error instanceof HubCallError && isHubNoDirectFallbackFailure(error)) {
      // retryAfterMs 이후 같은 Hub 요청을 재시도하거나 상위 큐로 넘긴다.
      // provider SDK를 직접 호출하면 중앙 admission/circuit을 우회하므로 금지한다.
      throw error;
    }
    throw error;
  }
}
```

`callHubLlm()`은 Hub transport timeout, JSON 오류, `Retry-After`, provider/admission backpressure를 `HubCallError`로 보존한다. 호출부는 문자열에서 `429`나 `503`을 다시 파싱하지 않는다.

### Vision

```ts
import { callHubVision } from '../../../packages/core/lib/hub-client.ts';

const result = await callHubVision({
  callerTeam: 'investment',
  agent: 'luna',
  selectorKey: 'investment.agent_policy',
  runtimePurpose: 'chart_vision',
  taskType: 'chart_vision',
  prompt: '차트의 추세와 위험 신호를 JSON으로 요약한다.',
  imageBase64,
  mimeType: 'image/png',
  maxTokens: 512,
  maxBudgetUsd: 0.05,
});
```

### Embedding

```ts
import { callHubEmbedding } from '../../../packages/core/lib/hub-client.ts';

const result = await callHubEmbedding({
  callerTeam: 'darwin',
  agent: 'research-indexer',
  selectorKey: 'hub._default',
  runtimePurpose: 'rag_embedding',
  taskType: 'rag_embedding',
  input: ['첫 번째 문서', '두 번째 문서'],
  expectedDimensions: 1024,
});
```

`expectedDimensions`는 실제 vector column과 일치할 때만 지정한다.

### 장시간 비동기 Job

core client에는 비동기 job helper가 아직 없으므로 승인된 Hub endpoint를 사용한다. provider endpoint를 직접 호출하지 않는다. 직접 생성에는 body `callerTeam` 또는 `X-Hub-Team`이 필수다.

```bash
JOB_ID="$(
  curl -fsS "$HUB_BASE_URL/hub/llm/jobs" \
    -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-Hub-Team: darwin" \
    -d '{
      "callerTeam": "darwin",
      "agent": "synthesis",
      "selectorKey": "darwin.agent_policy",
      "runtimePurpose": "synthesis",
      "taskType": "synthesis",
      "abstractModel": "anthropic_sonnet",
      "prompt": "긴 리서치 자료를 한국어로 종합한다.",
      "timeoutMs": 180000,
      "maxBudgetUsd": 0.25
    }' | jq -r .jobId
)"

curl -fsS -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  -H "X-Hub-Team: darwin" \
  "$HUB_BASE_URL/hub/llm/jobs/$JOB_ID"
curl -fsS -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  -H "X-Hub-Team: darwin" \
  "$HUB_BASE_URL/hub/llm/jobs/$JOB_ID/result"
```

Job 생성과 목록·상태·결과 조회에는 같은 canonical `X-Hub-Team`을 사용한다. 생성 요청의 header와 body가 서로 다른 팀이면 `400 callerTeam_mismatch`, 조회 헤더가 없으면 `400 callerTeam_required`, 다른 팀 Job이면 존재 여부를 노출하지 않고 `404 llm_job_not_found`를 반환한다. `luna`와 `investment`, `jay`와 `orchestrator`는 각각 같은 팀으로 정규화된다.

admission backpressure로 `status=queued`와 `retryAfterMs`가 반환되면 같은 job ID를 계속 조회한다. 새 job을 제출하면 동일 작업이 중복 실행될 수 있다.

## 4. Timeout 계약

`timeoutMs`는 호출자가 허용하는 전체 상한이다. 실제 timeout은 다음 순서로 더 보수적인 값을 적용한다.

1. token-budget profile의 전체 timeout
2. `callerTeam + runtimePurpose` runtime profile
3. selector/purpose timeout profile
4. 요청의 `timeoutMs`
5. 남은 전체 deadline

각 provider 시도는 `perAttemptTimeoutMs`와 남은 전체 deadline 중 작은 값을 사용한다. 첫 provider가 timeout을 모두 소비해 후속 fallback이 무제한으로 늘어나는 구조가 아니다.

- 일반 호출 최대: 180초
- Claude Archer 최대: 300초
- Blog writer 전체 최대: 600초
- Blog writer provider별 시도 최대: 420초

등록된 기본값을 쓰려면 `timeoutMs`를 생략한다. 더 짧게 중단해야 하는 호출만 명시적으로 낮춘다. writer 호출에 `timeoutMs: 180000`을 넣으면 420초 profile을 사용하지 못한다.

## 5. Admission과 fallback 계약

각 실제 provider 시도 직전에 Hub가 `global + team + provider` lease를 획득한다.

- 같은 요청에서 HTTP middleware와 provider limiter가 이중 차감되지 않는다.
- provider 범위만 가득 차면 다른 provider fallback을 시도할 수 있다.
- global/team 범위 거절, lease 손실, release 불확실, 종료 미확인은 fail-closed 처리한다.
- timeout 또는 abort 시 Claude/Gemini CLI 자식 프로세스 그룹을 종료한다.
- 종료가 확인되지 않으면 lease를 격리하고 provider 작업이 실제로 끝난 뒤 해제한다.
- 비동기 job은 admission backpressure에서 `failed`가 아니라 `queued`로 돌아가며 같은 job ID로 재시도한다.

실제 provider 오류 뒤에 다음 provider의 admission 거절이 발생해도 마지막 실제 provider의 `upstreamStatus`와 `retryAfterMs`가 최종 원인으로 유지된다. admission 거절은 `admissionRejections`에 별도로 기록된다.

## 6. 오류 처리

| 신호 | 의미 | 내부 호출부 처리 |
| --- | --- | --- |
| HTTP `429` 또는 `providerBackpressure.kind=provider_rate_limit` | provider rate limit 또는 provider-scope capacity | `Retry-After`/`retryAfterMs` 이후 Hub로 재시도 |
| HTTP `503` + `provider_unavailable` | upstream 과부하/일시 장애 | 짧은 backoff 후 Hub로 재시도 |
| HTTP `503` + `limiterBackpressure=true` | global/team admission 또는 lease 안전 실패 | 직접 fallback 금지, 큐/상위 스케줄러로 넘김 |
| HTTP `504` + `llm_total_deadline_exceeded` | 전체 deadline 소진 | 요청 축소 또는 비동기 job으로 전환 |
| `provider_termination_unconfirmed` | provider 프로세스 종료 미확인 | 자동 직접 재호출 금지, incident 대상 |
| `token_budget_exceeded`, `budget_exceeded`, `cycle_budget_exceeded` | 중앙 비용 정책 차단 | 요청/예산 정책 수정, provider 우회 금지 |

항상 body의 구조화 필드를 먼저 사용한다.

```ts
if (error instanceof HubCallError) {
  console.warn({
    code: error.code,
    httpStatus: error.httpStatus,
    retryAfterMs: error.retryAfterMs,
    backpressureKind: error.backpressureKind,
    admissionScope: error.admissionScope,
    noDirectFallback: error.noDirectFallback,
  });
}
```

## 7. 관측 확인

정본 view는 `hub.llm_request_log`다.

```sql
SELECT
  created_at,
  caller_team,
  agent,
  selector_key,
  runtime_purpose,
  selected_route,
  success,
  fallback_count,
  admission_fallback_count,
  admission_rejections,
  error
FROM hub.llm_request_log
WHERE caller_team = 'blog'
ORDER BY created_at DESC
LIMIT 20;
```

원문 prompt는 로그에 저장하지 않고 hash와 길이만 기록한다.

## 8. 연동 검증

운영 provider 호출 없이 다음 순서로 검증한다.

```bash
npm run -s typecheck
npm run -s typecheck:strict
npm run -s test:hub-readonly-contract
node bots/claude/__tests__/refactor-cycle-runner.test.ts
npx tsx bots/investment/scripts/luna-openai-force-audit-smoke.ts --json
```

통과 기준:

- Hub read-only contract 전체 통과
- `static_unregistered_purpose_selectors: 0`
- direct provider fallback 기본값 `false`
- selector가 raw `openai`를 `openai-oauth`로 정규화
- PROTECTED launchd, env, DB migration에 변경 없음

## 9. 금지 사항

- 내부 팀 코드에 provider API key/OAuth token을 복사하지 않는다.
- `/hub/llm/oauth`, `/hub/llm/groq`를 일반 에이전트가 호출하지 않는다.
- `chain`, raw provider, raw model을 호출부가 하드코딩하지 않는다.
- Hub `429/503/504`를 받고 provider SDK로 직접 fallback하지 않는다.
- 문자열 오류만 보고 status를 추정하지 않는다.
- 테스트를 위해 PROTECTED Hub를 임의 재시작하거나 DB migration을 적용하지 않는다.
