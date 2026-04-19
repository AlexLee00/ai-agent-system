# DPO 학습 가이드 (Marketing Self-Rewarding)

> Phase 6: DPO 선호 쌍 학습 + LLM-as-a-Judge + 성공 패턴 축적

## 개요

DPO(Direct Preference Optimization)는 성공/실패 포스팅 쌍을 분석하여
성공 패턴을 topic-selector에 자동 반영하는 자가 학습 시스템입니다.

## 파일 구조

```
bots/blog/lib/self-rewarding/
  marketing-dpo.ts          — DPO 선호 쌍 생성 + LLM 분석
  cross-platform-transfer.ts — 플랫폼 간 성공 패턴 전이

bots/blog/lib/agentic-rag/
  marketing-rag.ts          — 4 모듈 Agentic RAG

bots/blog/scripts/
  run-dpo-learning.ts       — 주간 실행 스크립트

bots/blog/launchd/
  ai.blog.dpo-learning.plist — 매주 월요일 03:00 KST
```

## 학습 사이클 (주간)

```
1. fetchPostsWithMetrics(30) — 최근 30일 포스팅 + 성과 수집
2. calcPostScore() — views_7d(40%) + engagement(40%) + revenue(20%)
3. 카테고리별 top20% vs bottom20% 매칭
4. analyzePairWithLlm() — LLM-as-a-Judge 원인 분석 (최대 10쌍)
5. saveDpoPairs() — DB 저장
6. updateFailureTaxonomy() — 실패 분류 업데이트
7. Telegram 보고
```

## topic-selector 통합

```typescript
// BLOG_DPO_ENABLED=true일 때만 활성
const { patterns, failures } = await _loadDpoHints();
dbCandidates = _applyDpoScore(dbCandidates, patterns, failures);
```

## DB 테이블

| 테이블 | 설명 |
|--------|------|
| blog.dpo_preference_pairs | 선호 쌍 (preferred vs rejected) |
| blog.success_pattern_library | 성공 패턴 (hook/title/structure) |
| blog.failure_taxonomy | 실패 분류 + 회피 힌트 |

## Kill Switch 활성화

```bash
# OPS에서 실행
launchctl setenv BLOG_DPO_ENABLED true
```

## Hook 스타일 분류

| 스타일 | 예시 | 특성 |
|--------|------|------|
| list | "5가지 방법" | 조회수 높음, 구조적 |
| why | "왜 중요한가" | 감성적 참여 높음 |
| how | "집중하는 법" | 실용적, CTA 효과 |
| comparison | "A vs B" | 검색 의도 높음 |
| question | "어떤 것이 좋을까" | 참여율 높음 |

## 주의사항

- LLM 비용: 주당 최대 10쌍 분석 (BLOG_LLM_DAILY_BUDGET_USD=5 내)
- DPO 점수는 기존 점수에 ±0.5 보정 (과도한 쏠림 방지)
- 최소 4개 포스팅이 있어야 학습 시작
