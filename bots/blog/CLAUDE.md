# 블로팀 — Claude/Codex 운영 컨텍스트

## 목적
- 네이버 블로그 자동 발행 파이프라인 운영
- 주제 다양화, 페르소나 작가 분리, RAG 강화, 이미지/댓글/조회수 자동화
- Draw Things 기반 로컬 이미지 생성으로 일관된 운영

## 현재 운영 상태
- Draw Things 전환 완료
- ComfyUI 운영 기본 경로 해제
- 블로그 자동 작업 launchd 반영 완료
- 댓글, 공감, 조회수 수집 경로 실운영 검증 완료
- 텔레그램 카운트 분리 반영 완료

## 핵심 결정 사항
- Draw Things 전용 운영
- 32GB 환경에서는 양자화 모델 우선
- 썸네일 1장 중심
- 인스타 카드보다 숏폼 릴스 우선
- Qwen Image 한글 고품질 운영은 상위 메모리 환경 이후 검토

## 실패한 접근
- 128GB 기준 모델 추천을 그대로 적용
  - 32GB 환경에서는 OOM 위험이 큼
  - 양자화 모델 우선 원칙 유지
- `.legacy.js` 기준만 보고 상태를 판단
  - 현재는 `.ts`가 진실 원본인 경우가 많음
  - 블로그팀 변경 판단은 `.ts` 우선
- 이미 수정된 P1/P2를 미수정으로 재판단
  - 마스터 문서와 실파일을 함께 확인해야 함

## 팀 구조
- 블로/마에스트로: 전체 오케스트레이션
- 포스/POS 작가: 실전형 글 생성
- 젬스/GEMS 작가: 대체 페르소나/변형 톤
- 리처: RAG, 내부 링크, 보강
- 퍼블: 발행, 중복 방지, 발행 후 처리
- 이미지: Draw Things 기반 이미지 생성
- commenter: 답글, 이웃 댓글, 공감, 조회수 수집

## 핵심 파일
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/blo.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/maestro.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/richer.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/publ.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/img-gen.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/commenter.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/runtime-config.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/config.json`

## 이미지 운영
- 공급자: Draw Things
- 기본 주소: `http://127.0.0.1:7860`
- 런타임 환경값:
  - `BLOG_IMAGE_PROVIDER=drawthings`
  - `BLOG_IMAGE_BASE_URL=http://127.0.0.1:7860`
- Draw Things 앱이 켜져 있어야 API도 살아 있음
- 로그인 시 자동 실행되도록 운영 반영됨

## 댓글/공감/조회수 운영
- 답글: `ai.blog.commenter`
- 이웃 댓글: `ai.blog.neighbor-commenter`
- 공감 전용: `ai.blog.neighbor-sympathy`
- 조회수 수집: `ai.blog.collect-views`

### 집계 규칙
- `reply`: 답글
- `neighbor_comment`: 이웃 댓글
- `neighbor_sympathy`: 공감 전용
- `neighbor_comment_sympathy`: 댓글 진행 중 함께 눌린 공감
- 댓글과 공감은 각각 별도 카운트
- 댓글 중 같이 눌린 공감도 별도 카운트

### 최근 안정화 내용
- 이웃 댓글 후보별 타임아웃 추가
- DB pool `allowExitOnIdle` 반영
- 댓글/공감 액션 중복 기록 방지
- 텔레그램 알림 카운트 분리

## TS 전환 원칙
- `__dirname` 상대경로에 의존하지 않음
- `env.PROJECT_ROOT` 기준 절대 경로 사용
- 블로그 루트는 보통 다음으로 계산:
  - `path.join(env.PROJECT_ROOT, 'bots', 'blog')`

## launchd 운영 파일
- `/Users/alexlee/projects/ai-agent-system/bots/blog/launchd/ai.blog.daily.plist`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/launchd/ai.blog.node-server.plist`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/launchd/ai.blog.commenter.plist`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/launchd/ai.blog.neighbor-commenter.plist`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/launchd/ai.blog.neighbor-sympathy.plist`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/launchd/ai.blog.collect-views.plist`

## 데이터/로그 확인 포인트
- 댓글 로그:
  - `/tmp/blog-commenter.log`
  - `/tmp/blog-commenter.err.log`
- 이웃 댓글 로그:
  - `/Users/alexlee/projects/ai-agent-system/bots/blog/neighbor-commenter.log`
- 공감 로그:
  - `/Users/alexlee/projects/ai-agent-system/bots/blog/neighbor-sympathy.log`
- 일간 로그:
  - `/Users/alexlee/projects/ai-agent-system/bots/blog/blog-daily.log`
- 액션/후보 상태는 DB 테이블에서 함께 확인

## 문서 우선순위
- 마스터 계획:
  - `/Users/alexlee/projects/ai-agent-system/docs/codex/CODEX_BLOG_MASTER.md`
- 이미지 리디자인:
  - `/Users/alexlee/projects/ai-agent-system/docs/codex/CODEX_BLOG_IMAGE_REDESIGN.md`
- ECC 적용 가이드:
  - `/Users/alexlee/projects/ai-agent-system/docs/strategy/ECC_APPLICATION_GUIDE.md`
- 최종 핸드오프:
  - `/Users/alexlee/projects/ai-agent-system/docs/OPUS_FINAL_HANDOFF.md`

## 아직 대기 중인 큰 작업
- Phase 1~7 순차 구현
- Phase 9:
  - `ffmpeg` 설치
  - Meta Developer 등록
- `.claude/hooks/hooks.json` 실제 훅 동작 연결
- 세션 저장/학습 자동화 체계 강화

## 다음 세션 시작 체크리스트
- Draw Things 앱 실행 여부 확인
- `http://127.0.0.1:7860` 응답 확인
- 블로그 launchd 상태 확인
- 댓글/공감/조회수 최근 로그 확인
- 마스터 문서의 완료/대기 상태 재확인

## 변경 작업 원칙
- 블로그팀 판단은 `.ts` 원본 우선
- launchd 변경 후 실제 로드 상태 확인
- 수동 테스트 결과와 운영 스케줄 결과를 분리해서 기록
- 댓글/공감 카운트는 액션 로그와 후보 상태를 함께 확인

## 참고
- 이 문서는 블로그팀 로컬 운영 기준 요약이다
- 세부 구현과 단계 계획은 마스터 문서를 우선한다


## 자율 마케팅 시스템 — 신규 모듈 (2026.04.13 추가)

### 피드백 루프 아키텍처
```
SENSE → PLAN → ACT → OBSERVE → LEARN → (반복)
```

### 신규 파일
- `lib/sense-engine.ts` — 스카팀 매출 + 트렌드 + 채널 상태 감지
- `lib/autonomy-gate.ts` — 자동 게시 vs 마스터 검토 판단 (Phase별 임계값)
- `lib/feedback-learner.ts` — 마스터 수정 diff → LLM 분석 → 선호 패턴 학습
- `lib/autonomy-tracker.ts` — Phase 추적 (1→2→3), 정확도 4주 연속 기준
- `lib/marketing-revenue-correlation.ts` — 마케팅→스카팀 매출 상관분석

### 신규 스킬
- `skills/marketing-ops-playbook/SKILL.md` — 자율 마케팅 운영 가이드

### DB 마이그레이션
- `migrations/008-marketing-metrics.sql` — channel_performance 테이블, 어그로 컬럼
- `migrations/009-feedback-autonomy-revenue.sql` — master_feedback, autonomy_log, revenue_correlation

### Phase 전환 규칙
- Phase 1→2: accuracy >= 0.80, 4주 연속
- Phase 2→3: accuracy >= 0.95, 4주 연속
- Phase 역전환: accuracy < 0.60 → Phase -1

### 스카팀 데이터 접근
- `pgPool.query('ska', ...)` — revenue_daily, environment_factors 조회
- 마케팅 활동일 vs 비활동일 매출 비교
- 환경 변수(공휴일/날씨/시험) 보정
