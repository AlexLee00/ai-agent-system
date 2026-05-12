# bots/social-media — 소셜미디어 별도 고도화 영역

> 분리일: 2026-05-12
> 분리 이유: 블로팀을 블로그 포스팅 + 댓글/공감에 집중시키기 위해
> 마스터 요청: CODEX_BLOG_NEURAL_QUALITY_BOOST_V2.md G영역

## 현재 상태: 준비 중 (별도 고도화 예정)

소셜미디어 자동화(인스타그램, 페이스북, 이미지 생성, 숏폼)를
블로팀에서 분리한 후 여기서 독립적으로 고도화 예정.

## 디렉토리 구조

```
bots/social-media/
├── instagram/         — 인스타그램 발행, 토큰 관리
│   ├── lib/           — 핵심 모듈 (이동 예정)
│   └── scripts/       — 실행 스크립트 (이동 예정)
├── facebook/          — 페이스북 발행
│   ├── lib/
│   └── scripts/
├── image-gen/         — 이미지 생성 (Draw Things, ComfyUI)
└── shortform/         — 숏폼 릴스 생성/렌더링
```

## 현재 소스 파일 위치 (bots/blog/lib/ — 이동 예정)

파일 이동은 import 경로 20+ 업데이트가 필요해 별도 세션에서 진행.
현재는 `BLOG_SOCIAL_MEDIA_ENABLED=true` 환경변수로 활성화 가능.

| 파일 | 이동 예정 위치 |
|------|---------------|
| bots/blog/lib/instagram-story.ts | instagram/lib/ |
| bots/blog/lib/instagram-token-automation.ts | instagram/lib/ |
| bots/blog/lib/insta-crosspost.ts | instagram/lib/ |
| bots/blog/lib/star.ts | instagram/lib/ |
| bots/blog/lib/facebook-publisher.ts | facebook/lib/ |
| bots/blog/lib/img-gen.ts | image-gen/ |
| bots/blog/lib/img-gen-doctor.ts | image-gen/ |
| bots/blog/lib/shortform-files.ts | shortform/ |
| bots/blog/lib/shortform-planner.ts | shortform/ |
| bots/blog/lib/shortform-renderer.ts | shortform/ |
| bots/blog/scripts/auto-instagram-publish.ts | instagram/scripts/ |
| bots/blog/scripts/auto-refresh-instagram-token.ts | instagram/scripts/ |
| bots/blog/scripts/auto-facebook-publish.ts | facebook/scripts/ |

## OFF 스위치

```bash
# ON (기본값: OFF)
BLOG_SOCIAL_MEDIA_ENABLED=true node bots/blog/lib/blo.ts

# OFF (기본값 — 환경변수 없으면 자동)
BLOG_SOCIAL_MEDIA_ENABLED=false  # 또는 미설정
```

## launchd 서비스 (현재 비활성화됨)

- ~~ai.blog.instagram-publish~~ (비활성)
- ~~ai.blog.facebook-publish~~ (비활성)
- ~~ai.blog.instagram-token-refresh~~ (비활성)

재활성화: `launchctl load ~/Library/LaunchAgents/ai.blog.instagram-publish.plist`
