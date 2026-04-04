# CODEX_BLOG_COMMENTER 테스트 체크리스트

작성일: 2026-04-03
대상:
- `bots/blog/lib/commenter.js`
- `bots/blog/scripts/run-commenter.js`
- `bots/blog/lib/runtime-config.js`
- `bots/blog/migrations/006-comments.sql`
- `bots/blog/launchd/ai.blog.commenter.plist`

## 코드 점검

- [x] 댓글러 설정이 `bots/blog/config.json` + `runtime-config.js`로 연결됨
- [x] 일일 상한 / 시간대 제한 / 테스트 모드 가드 존재
- [x] 댓글 감지 / 답글 생성 / 품질 검증 / 작성 / 상태 업데이트 흐름 존재
- [x] `blog.comments`, `blog.comment_actions` 스키마 정의 존재
- [x] launchd plist 존재

## 소프트 테스트

- [x] `node --check bots/blog/lib/commenter.js`
- [x] `node --check bots/blog/scripts/run-commenter.js`
- [x] `node --check bots/blog/lib/runtime-config.js`
- [x] `plutil -lint bots/blog/launchd/ai.blog.commenter.plist`
- [x] `bots/blog/config.json` JSON 파싱 통과
- [x] commenter export 확인
- [x] `getBlogCommenterConfig()` 값 로드 확인
- [x] `resolveBlogId()` 결과 확인 (`cafe_library`)
- [x] `validateReply()` 기본 품질 검증 동작 확인
- [x] DEV에서 `runCommentReply({ testMode: true })` → `ops_only` 스킵 확인

## 하드 테스트

- [ ] OPS에서 `006-comments.sql` 적용
- [ ] OPS에서 `BLOG_COMMENTER_TEST=true node bots/blog/scripts/run-commenter.js`
- [ ] 실제 네이버 관리 페이지 댓글 감지 확인
- [ ] 실제 답글 작성 성공 확인
- [ ] `blog.comments` 상태 업데이트 확인
- [ ] launchd 등록 후 주기 실행 확인

## 남은 리스크

- 브라우저 연결이 현재 `http://127.0.0.1:18791/json/version` 또는 직접 `puppeteer.launch(userDataDir=naver-profile)` 폴백에 의존함
- 네이버 관리자 페이지 DOM 구조가 다르면 감지/작성 셀렉터 보정 필요
- 품질 검증 최소 길이(30자)와 생성 프롬프트(50자) 기준이 다름
