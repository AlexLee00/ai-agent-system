# Intent Engine Plan

## Goal

Extract Jay's natural-language intent stack into a reusable core module so that:

- Jay keeps its current direct-routing speed and observability
- Worker can reuse the same intent learning / promotion flow later
- team bots can share a consistent policy for:
  - slash commands
  - keyword rules
  - learned patterns
  - auto-promotion
  - rollback
  - audit history
  - model escalation

## Why Now

Jay now contains enough generic logic that keeping everything inside:

- [intent-parser.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/intent-parser.js)
- [router.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.js)

is no longer ideal.

The current system already includes:

- deterministic slash routing
- keyword routing
- learned pattern loading
- unknown phrase capture
- auto-promotion
- rollback
- audit events
- family-based thresholds
- safe-intent policy

Those are intent-engine concerns, not Jay-only concerns.

## Proposed Package Shape

Create a new reusable layer inside `packages/core`, ideally as:

- `packages/core/lib/intent-core/parse.js`
- `packages/core/lib/intent-core/learned-store.js`
- `packages/core/lib/intent-core/promotion-policy.js`
- `packages/core/lib/intent-core/promotion-store.js`
- `packages/core/lib/intent-core/reporting.js`
- `packages/core/lib/intent-core/types.js`

## Boundary Split

### Move To Core

The following logic is generic enough to extract:

1. Slash parsing helpers
2. Keyword pattern evaluation engine
3. Learned pattern loading / reload
4. Unknown phrase normalization
5. Auto-promotion threshold policy
6. Safe auto-promotion gating
7. Promotion candidate persistence
8. Promotion event persistence
9. Reporting helpers for:
   - unrecognized
   - promotion candidates
   - promotion history
   - thresholds
10. Rollback helpers for learned patterns and candidate state

### Keep In Jay

The following should remain Jay-specific:

1. Actual slash map values
2. Jay keyword inventory
3. Jay handler registry
4. Jay-specific summaries:
   - mainbot logs
   - gateway logs
   - Luna/Ska/Claude logs
   - speed-test execution
5. Jay bot command execution
6. Jay operational wording in Telegram responses

## Interfaces

### Intent Parser Core

Suggested API:

```js
const result = await parseIntentWithCore({
  text,
  slashMap,
  keywordPatterns,
  learnedPatterns,
  llmFallback,
});
```

Returns:

```js
{
  intent,
  args,
  source,      // slash | keyword | learned | llm | failed
  confidence,
  metadata,
}
```

### Promotion Policy

Suggested API:

```js
const decision = evaluatePromotionPolicy({
  suggestedIntent,
  occurrenceCount,
  confidence,
  thresholds,
  safeIntents,
  safePrefixes,
});
```

Returns:

```js
{
  allowed,
  reason,      // threshold | unsafe_intent | ok
  threshold,
}
```

### Reporting

Suggested API:

```js
await buildUnrecognizedReport({ mode, store });
await buildPromotionReport({ mode, filters, store });
```

## Storage Split

Keep the storage contract generic:

- `unrecognized_intents`
- `intent_promotion_candidates`
- `intent_promotion_events`

But remove Jay naming from helper code.

The core should accept a storage adapter:

```js
{
  logUnrecognized(),
  listUnrecognized(),
  upsertCandidate(),
  listCandidates(),
  logPromotionEvent(),
  rollbackCandidate(),
}
```

That makes future migration easier if another bot uses a different schema.

## Reuse Targets

### Jay

First adopter. Replace internal helper blocks with `intent-core`.

### Worker

Later candidate:

- natural-language task intake
- repeated operator phrases
- safe promotion of workflow queries

Important reminder:

- Worker `n8n/RAG` common-layer review is planned after Monday unit tests.

### Future Team Bots

Potential reuse:

- Ska operator chat
- Claude ops shortcuts
- Blog admin control surface

## Migration Plan

### Phase 1

Extract pure helpers only:

- normalize / regex / threshold / safety helpers

Low risk because these are stateless.

### Phase 2

Extract learned-pattern and promotion-store helpers.

Keep Jay as caller.

### Phase 3

Extract reporting builders.

Jay still owns wording, but data assembly comes from core.

### Phase 4

Extract parsing engine and wire Jay to use it.

### Phase 5

Adopt in Worker or another bot if needed.

## Non-Goals

Do not move these yet:

- Jay handler switchboard
- log file path ownership
- speed-test execution
- launchd/service control
- Telegram response formatting

Those remain app-level concerns.

## Immediate Next Step

When starting extraction, begin with:

1. `normalizeIntentText`
2. `escapeRegex`
3. `buildAutoLearnPattern`
4. `summarizeIntentFamily`
5. `isSafeAutoPromoteIntent`
6. `getAutoPromoteThreshold`

These are the cleanest first slice and have minimal integration risk.
