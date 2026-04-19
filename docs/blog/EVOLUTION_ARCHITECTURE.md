# 블로팀 자율진화 마케팅 아키텍처 (7 Layer)

> 최종 업데이트: 2026-04-19 | Phase 1~7 전체 완료

## 전체 구조

```
Layer 0: Hub LLM Routing (V2)
Layer 1: Strategy Brain — 진화하는 마스터 전략
Layer 2: Content Factory — 12 페르소나 + 이미지 + 숏폼
Layer 3: Multi-Platform Publisher — 3 플랫폼 통합 + 실시간 보고
Layer 4: Signal Collector — 트렌드/경쟁사/멘션/스카매출
Layer 5: Analytics Brain — Content-Market Fit + AARRR + ROI
Layer 6: Self-Rewarding + Agentic RAG
```

## 핵심 파이프라인

```
[일일 23:00] ai.blog.daily → 주제선택 → 작성 → 발행(3플랫폼) → 보고
[일일 23:00] ai.blog.evolution-cycle → 5단계 루프 실행
[매일 05:30] ai.blog.compute-attribution → 포스팅-매출 귀속 계산
[주 1회 월요일 03:00] ai.blog.dpo-learning → DPO 선호 쌍 학습
[4시간마다] ai.blog.collect-signals → 트렌드/경쟁사/멘션
```

## DB 테이블 (주요)

| 테이블 | 설명 | 마이그레이션 |
|--------|------|-------------|
| blog.posts | 발행 포스팅 | 001 |
| blog.publish_log | 3 플랫폼 발행 이력 | 019 |
| blog.post_revenue_attribution | 포스팅-매출 귀속 | 015 |
| blog.roi_daily_summary | ROI 일일 요약 MView | 015 |
| blog.evolution_cycles | 자율진화 사이클 이력 | 016 |
| blog.strategy_versions | 전략 버전 관리 | 016 |
| blog.ab_tests | A/B 테스트 | 017 |
| blog.platform_schedules | 플랫폼별 발행 스케줄 | 017 |
| blog.keyword_trends | 네이버/구글 트렌드 | 018 |
| blog.brand_mentions | 브랜드 멘션 감성 분석 | 018 |
| blog.dpo_preference_pairs | DPO 선호 쌍 | 020 |
| blog.success_pattern_library | 성공 패턴 라이브러리 | 020 |
| blog.failure_taxonomy | 실패 분류 | 020 |

## Kill Switch 목록

| 환경변수 | 기본값 | 설명 |
|---------|--------|------|
| BLOG_IMAGE_FALLBACK_ENABLED | false | 이미지 실패 시 Fallback 썸네일 |
| BLOG_PUBLISH_REPORTER_ENABLED | false | 3 플랫폼 발행 보고 |
| BLOG_REVENUE_CORRELATION_ENABLED | false | 스카팀 매출 연동 |
| BLOG_EVOLUTION_CYCLE_ENABLED | false | 자율진화 루프 |
| BLOG_MULTI_PLATFORM_ENABLED | false | 멀티 플랫폼 오케스트레이션 |
| BLOG_SIGNAL_COLLECTOR_ENABLED | false | Signal Collector |
| BLOG_DPO_ENABLED | false | DPO Self-Rewarding |
| BLOG_MARKETING_RAG_ENABLED | false | Agentic RAG |

## 7주 활성화 로드맵

```
Week 1: BLOG_PUBLISH_REPORTER_ENABLED=true + Meta 수동 등록
Week 2: BLOG_REVENUE_CORRELATION_ENABLED=true + 스카팀 UTM 협업
Week 3: BLOG_EVOLUTION_CYCLE_ENABLED=true
Week 4: BLOG_MULTI_PLATFORM_ENABLED=true
Week 5: BLOG_SIGNAL_COLLECTOR_ENABLED=true
Week 6: BLOG_DPO_ENABLED=true + BLOG_MARKETING_RAG_ENABLED=true
Week 7: 전체 검증 → Production 완전 전환
```

## 비상 롤백

```bash
# 네이버 블로그는 절대 멈추지 않음 (ai.blog.daily 유지)
launchctl unload bots/blog/launchd/ai.blog.instagram-publish.plist
launchctl unload bots/blog/launchd/ai.blog.facebook-publish.plist
launchctl unload bots/blog/launchd/ai.blog.evolution-cycle.plist

# Git 롤백
git reset --hard pre-phase-N-blog-evolution
```
