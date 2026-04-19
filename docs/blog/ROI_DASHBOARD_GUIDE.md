# ROI 대시보드 가이드 (스카팀 매출 연동)

> Phase 2: 블로그 포스팅 → 스카팀 매출 귀속 분석

## 개요

블로팀 포스팅이 스터디카페 실물 매출에 얼마나 기여했는지 측정합니다.

## API 엔드포인트

```
GET /roi/summary?days=30        — ROI 전체 요약
GET /roi/top-posts?days=30      — 매출 기여도 상위 포스팅
GET /roi/category-weights       — 카테고리별 매출 가중치
```

## 귀속 방법론

```
1. UTM 추적 (가장 정확)
   포스팅 발행 시 고유 UTM 링크 생성
   → 스카팀 예약 시 utm_campaign 기록
   → 직접 귀속 가능

2. 시간적 상관관계 (간접)
   발행 후 7일 매출 vs 이전 7일 baseline 비교
   uplift_krw = after - before
   attribution_confidence: 0.3 (낮음)
```

## 주간 ROI 리포트 (매주 월요일 Telegram)

```
📊 주간 ROI 리포트
기간: 2026-04-13 ~ 2026-04-19

블로그 활동:
  발행: 7편 (네이버 5, 인스타 1, 페북 1)
  총 조회수: 12,345
  LLM 비용: $3.20

스카팀 매출:
  총 매출: 1,850,000원
  신규 방문: 28명
  재방문: 143명

귀속 분석:
  네이버 유래: 85,000원
  인스타 유래: 12,000원
  직접 유입: 58,000원
  ROI: 3,850% (비용 대비)

Top 3 포스팅:
  1. "스터디카페 집중력 5가지 방법" +45,000원
  2. "공부 환경 만들기" +28,000원
  3. "자격증 공부 루틴" +12,000원
```

## 스카팀 협업 요구사항

```sql
-- reservation.bookings에 UTM 컬럼 추가 필요 (마스터 승인)
ALTER TABLE reservation.bookings
  ADD COLUMN IF NOT EXISTS utm_source TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
```

## Kill Switch

```bash
launchctl setenv BLOG_REVENUE_CORRELATION_ENABLED true
```

## 주의사항

- attribution_confidence < 0.5: 참고 수준 (직접 귀속 아님)
- UTM 컬럼이 없으면 시간적 상관관계만 사용
- 스카팀 비즈니스 데이터는 절대 블로팀이 직접 수정 불가
