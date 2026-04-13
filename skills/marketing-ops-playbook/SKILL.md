---
name: marketing-ops-playbook
description: Use when operating, debugging, or improving the autonomous marketing system — feedback loop, channel orchestration, revenue correlation, strategy evolution, autonomy gate, and master feedback learning.
---

# Marketing Ops Playbook

이 스킬은 자율 마케팅 시스템의 운영/고도화를 다룰 때 사용한다.

## 핵심 원칙
- 마케팅의 기본은 **리소스 관리**
- 리소스 활용 → 결과 수집 → 분석 → 반영: **피드백 루프**
- 스카팀 매출 데이터로 **마케팅→매출 상관분석**
- Phase 1(마스터 검토) → Phase 2(샘플링) → Phase 3(완전 자율)

## 피드백 루프

```
SENSE(감지) → PLAN(계획) → ACT(실행) → OBSERVE(관찰) → LEARN(학습)
     ↑                                                    │
     └──────────── 스카팀 매출 + 채널 성과 ──────────────────┘
```

## 핵심 파일

### 피드백 루프 모듈 (bots/blog/lib/)
- `sense-engine.ts` — 트렌드 감지 + 스카 매출 감지 + 채널 상태
- `autonomy-gate.ts` — 자동 게시 vs 마스터 검토 판단
- `feedback-learner.ts` — 마스터 수정 diff 학습
- `autonomy-tracker.ts` — Phase 추적 + 정확도 기록
- `channel-orchestrator.ts` — 채널별 ROI 기반 자율 배분
- `marketing-revenue-correlation.ts` — 스카팀 매출 상관분석

### 기존 모듈 (확장 대상)
- `strategy-evolver.ts` — 전략 진화 (+ 어그로/매출/채널 확장)
- `performance-diagnostician.ts` — 성과 분석 (+ CTR/어그로 확장)
- `topic-selector.ts` — 주제 선정 (+ 트렌드 풀 확장)
- `shortform-planner.ts` — 숏폼 (+ 어그로 7종 확장)
- `img-gen.ts` — 이미지 (+ 어그로 썸네일 A/B)
- `social.ts` — 인스타 카드 (+ 어그로 1장 추가)

### 코어 모듈 (packages/core/lib/)
- `facebook-graph.ts` — 페이스북 Graph API (instagram-graph.ts 패턴)
- `marketing-metrics.ts` — 전 채널 성과 수집 통합

### 스크립트 (bots/blog/scripts/)
- `collect-all-channels.ts` — 전 채널 + 스카 매출 수집
- `weekly-marketing-report.ts` — 주간 마케팅 리포트 (매출 상관 포함)
- `run-feedback-loop.ts` — 피드백 루프 1사이클 실행

### DB 마이그레이션 (bots/blog/migrations/)
- `008-marketing-metrics.sql` — 채널 성과 + 어그로 유형 컬럼
- `009-master-feedback.sql` — 마스터 피드백 기록
- `010-autonomy-log.sql` — Phase 추적 로그
- `011-revenue-correlation.sql` — 매출 상관 분석 결과

## 브랜드 정보
- 커피랑도서관: 스터디카페 120개+, 24시간 찬양
- 승호아빠: AI 에이전트 디자이너, 친근형 톤, IT 쉽게 풀어줌
- 콘텐츠 비중: 커피랑도서관 > 승호아빠

## 채널 리소스
- 네이버 블로그: 1일 2포스팅, 마스터 검토 후 등록
- 인스타: 비즈니스 계정, API 보유, 에이전트 사용중
- 페북 + 페이지: API 보유, 에이전트 사용중
- 이미지: Draw Things (로컬, http://127.0.0.1:7860)

## 자율 운영 Phase
- Phase 1: 에이전트 초안 → 마스터 검토 → 게시
- Phase 2 (accuracy >= 0.80, 4주): 자동 게시 + 마스터 샘플링
- Phase 3 (accuracy >= 0.95, 4주): 완전 자율 + 주간 리포트만

## 변경 작업 원칙
- 피드백 루프 모듈은 `bots/blog/lib/` 하위에 배치
- 스카팀 DB 접근은 `pgPool.query('ska', ...)` 사용
- 블로그 DB 접근은 `pgPool.query('blog', ...)` 사용
- LLM 호출은 `callWithFallback()` + `selectLLMChain()` 사용
- config.json에 설정 추가 시 기존 패턴 따르기
