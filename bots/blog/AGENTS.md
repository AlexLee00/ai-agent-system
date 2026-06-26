# AGENTS.md — 블로팀 (블로그 성장·콘텐츠 자동화)

> 이 파일은 OpenAI Codex·Claude Code가 블로팀(bots/blog) 작업 시 읽는 가이드다.
> 상위 규칙 상속: 루트 AGENTS.md(세션 규칙) + ~/.codex/AGENTS.md(Lean Mode). 본 파일은 블로팀 특화 컨텍스트만 추가한다.

## 역할 경계 (불변)
- **메티(Claude app)** = 전략·설계·코드점검·독립검증. 코드 직접 수정 금지.
- **코덱스(OpenAI Codex)** = 명세 기반 구현과 검증.
- **마스터(제이)** = 승인·git commit·launchd·DB write·실게시 토글. 마스터 전용.
- 절차: 메티 설계 → 코덱스 구현 → 메티 검증 → 마스터 승인.

## ★ 절대 무중단 (PROTECTED)
- 실제 네이버 블로그 게시, 댓글/공감 전송, launchd 등록/해제, secret 변경, DB migration 적용은 명시 승인 없이는 하지 않는다.
- 운영 반영 전에는 반드시 dry-run/smoke/shadow로 검증한다.
- daily 2편 흐름(06:00 KST 강의 1편 + 일반 1편)을 끊지 않는다.

## 비전과 활동 3축
- 블로팀은 **스스로 성장하는 포스팅 작가 에이전트**다.
- 목표는 매일 안정적으로 글을 만들고, 실제 반응을 회수해 다음 글의 주제·구성·검증 품질을 개선하는 것이다.
- 포스팅: `blo.ts`가 매일 강의 1편 + 일반 1편을 생성한다.
- 댓글·공감: `commenter`, `neighbor-commenter`, `neighbor-sympathy`가 반응 회수와 관계 형성을 담당한다.
- Edu-X: 교육형 콘텐츠와 시장/학습 슬롯은 별도 Edu-X 런타임과 리포트 기준을 따른다.

## 에이전트 입문 48강
- 현재 강의 시리즈 운영명은 `에이전트 입문`이다.
- 기존 발행 1~4강은 이력 보존 대상이며, 새 발행본 제목으로 되돌리거나 수정하지 않는다.
- 5~48강은 `docs/design/BLO_AGENT_WRITER_REDESIGN_2026-06.md` §8 목차를 따른다.
- 신규 강의 제목 프리픽스는 `[에이전트 입문 N강] ...` 형식이다.
- 강의 본문 기본 형식은 `오늘 배울 것 1줄 -> 따라하기 -> 꿀팁 박스 -> 자주 묻는 질문 -> 다음 강 예고` 방향을 따른다.
- 최신정보는 당일 강의의 `curriculum.keywords`, `claude code`, `codex`, `AI 에이전트` 키워드로 찾고, 관련 최신정보가 없으면 `이번 주 소식` 코너는 만들지 않는다.

## 핵심 파일
- **생성 흐름**: `lib/blo.ts`, `lib/pos-writer.ts`, `lib/gems-writer.ts`, `lib/richer.ts`
- **커리큘럼**: `lib/curriculum-planner.ts`, `lib/category-rotation.ts`, `lib/schedule.ts`
- **품질/형식**: `lib/quality-checker.ts`, `lib/blog-format-rules.ts`, `lib/runtime-config.ts`
- **반응 회수**: `lib/commenter.ts`, `scripts/collect-views.ts`, `scripts/collect-final-content.ts`
- **운영 설정**: `config.json`, `package.json`, `launchd/ai.blog.*.plist`

## 현재 상태
- 소셜/마케팅 자동 확장은 공식 보류 상태다.
- `BLOG_SOCIAL_MEDIA_ENABLED`, `BLOG_IMAGE_GEN_ENABLED`, `BLOG_MARKETING_ENABLED` 기본값은 false다.
- `bots/social-media` 코드는 삭제하지 않고 차후 확장용으로 보존한다.
- B1/B2/B2b/B2c/B3 계열로 커리큘럼, Vault RAG, 최종본 diff, analyzer, 본문 형식 규칙이 연결되어 있다.

## 운영 주의
- 소비 경로는 `blo.ts -> curriculum-planner.ts/category-rotation.ts -> blog.curriculum` 흐름을 유지한다.
- `.ts` 파일이 진실 원본인 경우가 많으므로 변경 판단은 `.ts` 우선이다.
- 허위 매장명/프로모션, 제목 방향 이탈, 안전 문구 누락, G-E-RG reject는 기존 차단 규칙을 보존한다.
- Vault RAG, masterStyleHint, 최종본 diff 수집은 실패해도 작성 흐름을 막지 않는 fallback 구조를 유지한다.
- 기존 사용자 변경이나 운영 로그는 임의로 되돌리지 않는다.

## 공용 유틸 강제 (신규 코드 필수)
- 시간: packages/core/lib/kst.js
- DB: packages/core/lib/pg-pool.js 또는 Hub 경유
- LLM: packages/core/lib/llm-fallback.js + llm-model-selector.js
- RAG: packages/core/lib/rag.js
- launchd: StartCalendarInterval은 KST 기준

## 구현 하네스
1. Karpathy 4원칙 (Lean Mode 상속): 최소 변경, 기존 패턴 우선, surgical, 검증 가능 성공기준.
2. 검증 루프: `node --check [변경파일]` → 관련 smoke/unit → dry-run. 실패 시 최대 3회 자동수정, 3회 실패 시 마스터 보고.
3. 미검증 "완료" 금지. 실제 게시 없이 dry-run/shadow 산출물로 먼저 검증한다.

## 참조 문서
- `docs/design/BLO_AGENT_WRITER_REDESIGN_2026-06.md`
- `docs/design/BLO_REDESIGN_TRACKER.md`
- `docs/design/BLO_B3_FORMAT_RESEARCH_2026-06.md`
