# [봇 이름] — 신규 봇 스캐폴딩

## 이 디렉토리 사용법

1. `bots/_template/`을 복사하여 `bots/[새 봇 이름]/`으로 이름 변경
2. `package.json`의 `name` 수정
3. `context/*.md` 파일 내용 채우기
4. 루트에서 `npm install` 1회 실행 (workspace symlink 생성)
5. `src/example-cmd.js`를 참고해서 실제 명령 작성

## 공유 패키지 사용

```js
const { outputResult, fail, log, delay, parseArgs } = require('@ai-agent/core');
const { getPickkoLaunchOptions, setupDialogHandler } = require('@ai-agent/playwright-utils');
```

## 디렉토리 구조

```
bots/[bot-name]/
├── package.json          ← @ai-agent/core + @ai-agent/playwright-utils
├── lib/
│   ├── utils.js          ← @ai-agent/core re-export
│   └── browser.js        ← @ai-agent/playwright-utils re-export
├── src/
│   └── example-cmd.js    ← CLI 명령 예시 (복사해서 수정)
└── context/
    ├── HANDOFF.md        ← 작업 이력
    ├── DEV_SUMMARY.md    ← 개발 요약
    └── CLAUDE_NOTES.md   ← 봇 행동 지침
```
