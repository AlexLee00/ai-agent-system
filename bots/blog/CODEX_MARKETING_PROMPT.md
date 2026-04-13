# 자율 마케팅 시스템 — Codex 구현 프롬프트

## 컨텍스트
블로팀의 자율 마케팅 피드백 루프 시스템 구축.
핵심 모듈 5개는 이미 스캐폴딩 완료 (`bots/blog/lib/`):
- sense-engine.ts (181줄) ✅
- autonomy-gate.ts (134줄) ✅
- feedback-learner.ts (139줄) ✅
- autonomy-tracker.ts (61줄) ✅
- marketing-revenue-correlation.ts (83줄) ✅

스킬 + DB 마이그레이션도 완료:
- skills/marketing-ops-playbook/SKILL.md ✅
- migrations/008-marketing-metrics.sql ✅
- migrations/009-feedback-autonomy-revenue.sql ✅

## 남은 구현 태스크

### Task 1: blo.ts에 autonomy-gate 연동
파일: `bots/blog/lib/blo.ts`
- 기존 파이프라인: maestro → writer → richer → publ
- 변경: maestro → writer → richer → **autonomy-gate.decideAutonomy()** → publ or 마스터 대기
- decideAutonomy가 'master_review' 반환 시 텔레그램으로 초안 전달

### Task 2: strategy-evolver.ts 확장
파일: `bots/blog/lib/strategy-evolver.ts`
- 기존 createStrategyPlan()에 추가 입력:
  - sense-engine.ts의 skaRevenue 데이터
  - marketing-revenue-correlation.ts의 상관분석 결과
  - 어그로 유형별 CTR (blog.posts.aggro_type 기준)
- 출력 확장: preferredAggroType, optimalPublishHours, channelBudget

### Task 3: weekly-evolution.ts 확장
파일: `bots/blog/scripts/weekly-evolution.ts`
- autonomy-tracker.trackWeeklyAutonomy() 호출 추가
- marketing-revenue-correlation.analyzeMarketingToRevenue() 호출 추가
- 주간 리포트에 매출 상관 + Phase 상태 포함
- feedback-learner.aggregatePatterns() → 마스터 피드백 요약 포함

### Task 4: collect-all-channels.ts 신규
파일: `bots/blog/scripts/collect-all-channels.ts`
- 기존 collect-performance.ts 확장
- 추가: Instagram Insights API (reach, saves, shares)
- 추가: Facebook Insights API (reach, clicks)
- 추가: blog.channel_performance 테이블에 기록
- launchd: ai.blog.collect-all-channels.plist (매일 18:00)

### Task 5: pos-writer/gems-writer에 피드백 프롬프트 주입
파일: `bots/blog/lib/pos-writer.ts`, `gems-writer.ts`
- feedback-learner.buildFeedbackPromptInsert() 호출
- 시스템 프롬프트 끝에 마스터 선호 패턴 자동 삽입
- 예: "[마스터 선호: ~해보세요 종결, FAQ 3개+, 코드 예시 필수]"

### Task 6: DB 마이그레이션 실행
```bash
cd bots/blog && npx ts-node scripts/run-migrations.ts
```

## 테스트 체크리스트
- [ ] sense-engine: getSkaRevenue() → 스카 DB 조회 성공
- [ ] autonomy-gate: decideAutonomy() → Phase 1에서 거의 모든 포스트 'master_review'
- [ ] feedback-learner: recordFeedback() → DB 기록 + LLM 분석 성공
- [ ] autonomy-tracker: trackWeeklyAutonomy() → 정확도 계산 + Phase 판단
- [ ] revenue-correlation: analyzeMarketingToRevenue() → 상관분석 결과 반환
- [ ] blo.ts: autonomy-gate 삽입 후 기존 파이프라인 정상 동작
- [ ] weekly-evolution: 매출 상관 + Phase 상태 리포트 포함
