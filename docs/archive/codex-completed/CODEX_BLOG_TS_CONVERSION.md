# CODEX_BLOG_TS_CONVERSION.md — 블로팀 JS→TS 실전환

> 메티 | 2026-04-10 | 코덱스 구현 프롬프트
> 환경: Mac Studio M4 Max 32GB / DEV(맥북) 또는 OPS
> 주의: __dirname 금지 → env.PROJECT_ROOT! / .legacy.js 수정 금지!
>
> **[2026-04-17 상태] Phase 1+2A 완료 — @ts-nocheck 전수 제거 완료**
> - __dirname 전수 제거 완료 (Phase 1 완료)
> - @ts-nocheck 전수 제거 완료 (2026-04-17): lib/ 40개 + scripts/ 34개 파일
>   - blo.ts, commenter.ts, gems-writer.ts, publ.ts 포함 전체 제거
>   - npx tsc --noEmit 에러 없음 확인 (pre-existing trade-journal-db 에러 제외)
> - 남은 작업: require() → import 전환 + 타입 어노테이션 추가 (Phase 2B 장기)

---

## 개요

블로팀 .ts 파일 35개가 전부 @ts-nocheck 복사본 상태.
실질적 타입 검증 0%. 이것을 실제 TypeScript로 전환한다.

## 현재 상태

```
파일 구조 (3중!):
  lib/blo.ts          ← @ts-nocheck 복사본 (타입 검증 0!)
  lib/blo.js          ← 래퍼 (dist → .legacy.js 폴백)
  lib/blo.legacy.js   ← 원본 로직 (수정 금지!)

35개 .ts 파일 전부 @ts-nocheck:
  lib/ 20개: ai-feedback, blo, bonus-insights, category-rotation,
    commenter, curriculum-planner, daily-config, gems-writer,
    img-gen, maestro, pipeline-store, pos-writer, publ,
    quality-checker, richer, runtime-config, schedule,
    section-ratio, social, star
  scripts/ 15개: analyze-blog-performance, check-n8n-pipeline-path,
    collect-competition-results, collect-performance, collect-views,
    health-check, health-report, mark-published-url, post-comment-test,
    record-performance, run-commenter, run-daily,
    run-neighbor-commenter, run-neighbor-sympathy, seed-curriculum

__dirname 잔존 7곳:
  lib/ai-feedback.ts:6      — require(path.join(__dirname, ...))
  lib/gems-writer.ts:52     — BLOG_OUTPUT_DIR
  lib/img-gen.ts:25          — OUTPUT_DIR
  lib/social.ts:23           — INSTA_DIR
  lib/star.ts:24             — INSTA_DIR
  scripts/analyze-blog-performance.ts:6~9
  scripts/collect-views.ts:11
  scripts/mark-published-url.ts:6~7
  scripts/record-performance.ts:6

require(path.join(__dirname...)) 패턴 5파일 11곳
```

## 전환 원칙

```
1. @ts-nocheck 제거!
2. require() → import 전환!
3. __dirname → env.PROJECT_ROOT!
4. 함수 파라미터/리턴 타입 명시!
5. any → 구체적 타입 (최소 unknown!)
6. .legacy.js 파일 절대 수정 금지!
7. .js 래퍼 파일은 유지! (dist 폴백 필요!)
8. 파일당 개별 커밋 또는 그룹 커밋!
```

---

## Phase 1: __dirname 제거 + import 전환 (우선순위 높음!)

### 대상: __dirname 잔존 7개 파일

#### 공통 패턴

```typescript
// 변경 전 (모든 파일 공통!)
// @ts-nocheck
'use strict';
const path = require('path');
const something = require(path.join(__dirname, '../../../packages/core/lib/something'));
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// 변경 후
import path from 'path';
import env from '../../../packages/core/lib/env';
import something from '../../../packages/core/lib/something';
const OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots/blog/output');
```

#### 파일별 작업

**1) lib/img-gen.ts (345줄)**
```
- @ts-nocheck 제거
- require → import 전환 (kst, selectRuntime, generateWithComfyUI, fs, path)
- 25줄: path.join(__dirname, '..', 'output') → path.join(env.PROJECT_ROOT, 'bots/blog/output')
- generateImage, generatePostImages 등 함수 타입 추가
```

**2) lib/star.ts (246줄)**
```
- @ts-nocheck 제거
- require → import 전환 (kst, selectLLMChain, getBlogLLMSelectorOverrides, callWithFallback, generateInstaCard, fs, path)
- 24줄: path.join(__dirname, '..', 'output', 'images', 'insta') → path.join(env.PROJECT_ROOT, 'bots/blog/output/images/insta')
- summarizeForInsta, generateInstaCaption, createInstaContent 타입 추가
```

**3) lib/social.ts**
```
- @ts-nocheck 제거
- 23줄: __dirname → env.PROJECT_ROOT
- import 전환
```

**4) lib/gems-writer.ts**
```
- @ts-nocheck 제거
- 52줄: path.join(__dirname, '..', 'output') → env.PROJECT_ROOT 기반
- import 전환
```

**5) lib/ai-feedback.ts**
```
- @ts-nocheck 제거
- 6줄, 12줄, 17줄: require(path.join(__dirname, ...)) → import
```

**6) scripts/analyze-blog-performance.ts**
```
- @ts-nocheck 제거
- 6~9줄: require(path.join(__dirname, ...)) → import
```

**7) scripts/collect-views.ts, mark-published-url.ts, record-performance.ts**
```
- @ts-nocheck 제거
- require(path.join(__dirname, ...)) → import
```

### 검증 Phase 1

```bash
# 1. tsc 타입 체크 (에러 0 목표!)
cd /Users/alexlee/projects/ai-agent-system
npx tsc --noEmit --project bots/blog/tsconfig.json 2>&1 | head -30

# 2. __dirname 잔존 확인
grep -rn "__dirname" bots/blog/lib/*.ts bots/blog/scripts/*.ts

# 3. @ts-nocheck 잔존 확인 (Phase 1 대상만!)
grep -l "@ts-nocheck" bots/blog/lib/img-gen.ts bots/blog/lib/star.ts bots/blog/lib/social.ts bots/blog/lib/gems-writer.ts bots/blog/lib/ai-feedback.ts

# 4. 실행 테스트
node bots/blog/scripts/health-check.js
```

---

## Phase 2: 나머지 @ts-nocheck 제거 (점진적!)

### 대상: Phase 1 이후 남은 @ts-nocheck 파일들

#### 우선순위 A: 핵심 파이프라인 (blo.ts 의존 체인!)

```
1. lib/runtime-config.ts   — 설정 로드 (다른 모든 파일이 의존!)
2. lib/daily-config.ts     — 일일 설정
3. lib/schedule.ts         — 스케줄
4. lib/blo.ts              — 메인 오케스트레이터
5. lib/publ.ts             — 발행
```

#### 우선순위 B: 작가/품질 체인

```
6. lib/pos-writer.ts       — POS 작가
7. lib/gems-writer.ts      — GEMS 작가 (Phase 1에서 __dirname 수정!)
8. lib/quality-checker.ts  — 품질 검증
9. lib/richer.ts           — RAG 강화
10. lib/bonus-insights.ts  — 보너스 인사이트
```

#### 우선순위 C: 보조 모듈

```
11. lib/maestro.ts
12. lib/curriculum-planner.ts
13. lib/category-rotation.ts
14. lib/section-ratio.ts
15. lib/pipeline-store.ts
16. lib/commenter.ts
```

#### 우선순위 D: 스크립트

```
17~28. scripts/*.ts (나머지 전부!)
```

### 각 파일 전환 패턴

```typescript
// 1. @ts-nocheck 제거!
// 2. require → import
// 3. 함수 파라미터 타입 추가
// 4. 반환 타입 추가
// 5. 인터페이스/타입 정의 (파일 상단!)

// 예시: runtime-config.ts
interface BlogConfig {
  postType: string;
  category: string;
  competition_enabled: boolean;
  // ...
}

export function loadConfig(): BlogConfig {
  // ...
}
```

### 검증 Phase 2 (파일마다!)

```bash
# 파일별 tsc 체크
npx tsc --noEmit bots/blog/lib/runtime-config.ts

# 전체 health check
node bots/blog/scripts/health-check.js

# 실제 실행 테스트 (dry run!)
MODE=test node bots/blog/scripts/run-daily.js
```

---

## Phase 3: .legacy.js 정리 (안정화 후!)

```
Phase 2 완료 + 1주 안정 운영 후:
  .legacy.js 32개 파일 삭제!
  .js 래퍼 → 직접 dist/ts-runtime 참조로 단순화!
  또는 tsx 런타임으로 .ts 직접 실행!
```

---

## 구현 순서

```
Phase 1 (즉시!): __dirname 7곳 + import 전환!
  img-gen.ts, star.ts, social.ts, gems-writer.ts, ai-feedback.ts
  + scripts 3개
  → 커밋: "fix(blog): __dirname → PROJECT_ROOT + import 전환"

Phase 2A (다음!): 핵심 파이프라인 5파일!
  runtime-config → daily-config → schedule → blo → publ
  → 커밋: "feat(blog): 핵심 파이프라인 TS 실전환"

Phase 2B: 작가/품질 5파일!
  pos-writer → gems-writer → quality-checker → richer → bonus-insights
  → 커밋: "feat(blog): 작가/품질 체인 TS 실전환"

Phase 2C: 보조 모듈 6파일!
Phase 2D: 스크립트 12파일!
Phase 3: .legacy.js 정리 (1주 안정 후!)
```

## 수정 파일 목록

```
Phase 1 (8파일):
  bots/blog/lib/img-gen.ts
  bots/blog/lib/star.ts
  bots/blog/lib/social.ts
  bots/blog/lib/gems-writer.ts
  bots/blog/lib/ai-feedback.ts
  bots/blog/scripts/analyze-blog-performance.ts
  bots/blog/scripts/collect-views.ts
  bots/blog/scripts/mark-published-url.ts
  bots/blog/scripts/record-performance.ts

Phase 2 (나머지 26파일):
  lib/ 15파일 + scripts/ 11파일
```

## ⚠️ 주의사항

```
1. .legacy.js 절대 수정 금지! (폴백용!)
2. .js 래퍼 파일 유지! (dist 경로 참조!)
3. env.PROJECT_ROOT import: require('../../../packages/core/lib/env')
4. 32GB 메모리: tsc --noEmit 실행 시 메모리 주의!
5. 한 번에 전부 하지 말고 Phase별 커밋!
6. 각 Phase 후 health-check.js 실행!
7. tsconfig.json 존재 여부 확인 후 시작!
8. import 전환 시 default export 확인! (module.exports = vs export default!)
```
