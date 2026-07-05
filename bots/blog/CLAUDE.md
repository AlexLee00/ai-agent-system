# 블로팀 운영 컨텍스트

## 비전
- 블로팀은 **스스로 성장하는 포스팅 작가 에이전트**다.
- 목표는 매일 안정적으로 글을 만들고, 실제 반응을 회수해 다음 글의 주제·구성·검증 품질을 개선하는 것이다.
- 현재 우선순위는 네이버 블로그 본문 품질, 댓글·공감 루프, Edu-X 연계이며 소셜 확장은 보류한다.

## 활동 3축
- 포스팅: `blo.ts`가 매일 06:00 KST 강의 1편 + 일반 1편을 생성한다.
- 댓글·공감: `commenter`, `neighbor-commenter`, `neighbor-sympathy`가 반응 회수와 관계 형성을 담당한다.
- Edu-X: 교육형 콘텐츠와 시장/학습 슬롯은 별도 Edu-X 런타임과 리포트 기준을 따른다.

## 성장 루프
- 관찰: 성과, 댓글, 검색 반응, 운영 실패를 수집한다.
- 판단: 품질 게이트와 dry-run/smoke 결과로 다음 행동을 고른다.
- 작성: POS/GEMS 작가가 주제별 글을 만들고, 품질 보정 1회를 수행한다.
- 회수: 발행 후 조회·댓글·공감·운영 리포트를 다시 저장한다.
- 학습: 성공/실패 패턴은 다음 주제 선정과 프롬프트에 반영하되, 현재 마케팅 자동 확장은 기본 off다.

## 에이전트 입문 48강
- 현재 강의 시리즈의 운영명은 `에이전트 입문`이다.
- 기존 발행 1~4강은 이력 보존 대상이며, 새 발행본 제목으로 되돌리거나 수정하지 않는다.
- 5~48강은 `docs/design/BLO_AGENT_WRITER_REDESIGN_2026-06.md` §8 목차를 따른다.
- 신규 강의 제목 프리픽스는 `[에이전트 입문 N강] ...` 형식이다.
- 강의 본문 기본 형식은 `오늘 배울 것 1줄 -> 따라하기 -> 꿀팁 박스 -> 자주 묻는 질문 -> 다음 강 예고` 방향을 따른다.
- 최신정보는 Node.js 릴리스 고정이 아니라 당일 강의의 `curriculum.keywords`와 `claude code`, `codex`, `AI 에이전트` 키워드로 찾는다.
- 관련 최신정보가 없으면 `이번 주 소식` 코너는 만들지 않는다.

## 소셜·마케팅 상태
- 인스타그램/페이스북 자동 발행 launchd 트리거는 repo에서 제거 대상이다.
- `bots/social-media` 코드는 삭제하지 않는다. MCP·이미지·숏폼·소셜 모듈은 차후 확장용으로 보존한다.
- 실제 `~/Library/LaunchAgents` bootout/delete는 마스터가 수행한다.
- `BLOG_SOCIAL_MEDIA_ENABLED` 기본값은 false다.
- `BLOG_IMAGE_GEN_ENABLED` 기본값은 false다.
- `BLOG_MARKETING_ENABLED` 기본값은 false다.
- 2026년 4월 Phase 1~7 자율 마케팅 로드맵은 공식 보류 상태다.

## 핵심 파일
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/blo.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/pos-writer.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/gems-writer.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/richer.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/curriculum-planner.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/category-rotation.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/schedule.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/commenter.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/lib/runtime-config.ts`

## 실행 원칙
- 실제 게시, launchd 등록/해제, secret 변경, DB migration 적용은 명시 승인 없이는 하지 않는다.
- 운영 반영 전에는 dry-run/smoke로 검증한다.
- 소비 경로는 `blo.ts -> curriculum-planner.ts/category-rotation.ts -> blog.curriculum` 흐름을 유지한다.
- daily 2편 흐름을 끊지 않는다.
- `.ts` 파일이 진실 원본인 경우가 많으므로 변경 판단은 `.ts` 우선이다.
- 기존 사용자 변경이나 운영 로그는 임의로 되돌리지 않는다.

## launchd 운영 파일
- `/Users/alexlee/projects/ai-agent-system/bots/blog/launchd/ai.blog.daily.plist`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/launchd/ai.blog.node-server.plist`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/launchd/ai.blog.commenter.plist`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/launchd/ai.blog.neighbor-commenter.plist`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/launchd/ai.blog.neighbor-sympathy.plist`
- `/Users/alexlee/projects/ai-agent-system/bots/blog/launchd/ai.blog.collect-views.plist`

## 문서 우선순위
- `/Users/alexlee/projects/ai-agent-system/docs/design/BLO_AGENT_WRITER_REDESIGN_2026-06.md`
- `/Users/alexlee/projects/ai-agent-system/docs/design/BLO_REDESIGN_TRACKER.md`
- `/Users/alexlee/projects/ai-agent-system/docs/codex/CODEX_BLO_B1_CURRICULUM_2026-06-13.md`
- `/Users/alexlee/projects/ai-agent-system/docs/codex/CODEX_BLOG_MASTER.md`

## 다음 작업 대기
- B2: 대도서관·피드백 루프.
- B3: 본문 형식 전면 리디자인.
- B4: 댓글 동적 대응과 댓글/공감 성장 루프.
- B5: 루나 패턴+gate.
- B6: Edu-X 성장 루프.

## 페르소나

→ **AGENTS.md 참조**(팀 정신·에이전트 정체성 — 정본은 설계서 § 부록).
