# 워커 참조 문서

## 역할

- 대화형 업무 운영 시스템
- 승인형 AI 제안, 권한 기반 화면, 문서 파싱/OCR 테스트 포함

## 핵심 기능

- 대시보드/승인/근태/일정/직원/급여/매출/프로젝트/업무일지 운영
- `PromptAdvisor` 기반 자연어 입력
- 메뉴 권한/AI 정책/승인 흐름
- 문서 업로드 파싱과 OCR 테스트
- 문서 목록/상세에서 재사용 전환율과 품질 신호 동시 확인
- 문서 목록에서 품질 상태/전환율 기준 정렬과 필터 지원
- 문서 상세에서 무수정 확정률과 평균 수정 필드 수 확인
- 문서 목록/상세에서 종합 효율 점수 확인
  - 품질 상태
  - 전환율
  - 무수정 확정률
  - 평균 수정 필드 수
  - 재사용 표본 수
- 워커 모니터링과 기본 LLM API 선택
- 최근 24시간 LLM 호출 통계와 기본 API 변경 이력 확인
- provider별/경로별 성공률과 평균 응답시간 확인
- provider 변경 사유(note)와 최근 설정 판단 맥락 확인
- 최근 변경 전후 12시간 기준 성공률/응답시간 비교 확인

## 핵심 진입점

- 서버/API
  - [bots/worker/web/server.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/server.js)
  - [bots/worker/src/worker-lead.js](/Users/alexlee/projects/ai-agent-system/bots/worker/src/worker-lead.js)
- 화면
  - [bots/worker/web/app/dashboard/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/dashboard/page.js)
  - [bots/worker/web/app/attendance/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/attendance/page.js)
  - [bots/worker/web/app/approvals/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/approvals/page.js)
  - [bots/worker/web/app/admin/ocr-test/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/admin/ocr-test/page.js)
  - [bots/worker/web/app/admin/monitoring/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/admin/monitoring/page.js)

## 공용 정책/구조

- [bots/worker/lib/ai-policy.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/ai-policy.js)
- [bots/worker/lib/menu-policy.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/menu-policy.js)
- [bots/worker/web/lib/menu-access.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/lib/menu-access.js)
- [bots/worker/web/components/PromptAdvisor.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/components/PromptAdvisor.js)
- [bots/worker/web/lib/document-attachment.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/lib/document-attachment.js)
- [bots/worker/lib/llm-api-monitoring.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/llm-api-monitoring.js)
- [bots/worker/migrations/018-monitoring-history.sql](/Users/alexlee/projects/ai-agent-system/bots/worker/migrations/018-monitoring-history.sql)
- [bots/worker/migrations/019-monitoring-change-notes.sql](/Users/alexlee/projects/ai-agent-system/bots/worker/migrations/019-monitoring-change-notes.sql)

## 운영 스크립트

- [bots/worker/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/worker/scripts/health-report.js)
- [bots/worker/scripts/health-check.js](/Users/alexlee/projects/ai-agent-system/bots/worker/scripts/health-check.js)
- [bots/worker/scripts/check-n8n-intake-path.js](/Users/alexlee/projects/ai-agent-system/bots/worker/scripts/check-n8n-intake-path.js)
- [bots/worker/scripts/document-efficiency-review.js](/Users/alexlee/projects/ai-agent-system/bots/worker/scripts/document-efficiency-review.js)

## 운영 설정

- [bots/worker/config.json](/Users/alexlee/projects/ai-agent-system/bots/worker/config.json)
- [bots/worker/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/runtime-config.js)
- [bots/worker/web/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/lib/runtime-config.js)
- [bots/worker/migrations/017-system-preferences.sql](/Users/alexlee/projects/ai-agent-system/bots/worker/migrations/017-system-preferences.sql)
- [bots/worker/migrations/018-monitoring-history.sql](/Users/alexlee/projects/ai-agent-system/bots/worker/migrations/018-monitoring-history.sql)
- [bots/worker/migrations/019-monitoring-change-notes.sql](/Users/alexlee/projects/ai-agent-system/bots/worker/migrations/019-monitoring-change-notes.sql)

## 자주 쓰는 명령어

```bash
node /Users/alexlee/projects/ai-agent-system/bots/worker/scripts/health-report.js --json
node /Users/alexlee/projects/ai-agent-system/bots/worker/scripts/check-n8n-intake-path.js
node /Users/alexlee/projects/ai-agent-system/bots/worker/scripts/document-efficiency-review.js --company-id=1 --limit=5
node /Users/alexlee/projects/ai-agent-system/bots/worker/migrations/017-system-preferences.js
node /Users/alexlee/projects/ai-agent-system/bots/worker/migrations/018-monitoring-history.js
node /Users/alexlee/projects/ai-agent-system/bots/worker/migrations/019-monitoring-change-notes.js
cd /Users/alexlee/projects/ai-agent-system/bots/worker/web && npm run build
```

## 관련 문서

- [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
- [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
