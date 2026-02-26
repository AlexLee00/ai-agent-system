# DEV_SUMMARY.md — [봇 이름] 개발 요약

## 개요

[봇의 목적과 주요 기능 설명]

## 아키텍처

```
bots/[bot-name]/
├── lib/
│   ├── utils.js      ← @ai-agent/core re-export
│   └── browser.js    ← @ai-agent/playwright-utils re-export
├── src/
│   └── example-cmd.js
└── context/
    ├── IDENTITY.md
    ├── HANDOFF.md
    ├── DEV_SUMMARY.md
    └── CLAUDE_NOTES.md
```

## 주요 파일

| 파일 | 역할 |
|------|------|
| `src/example-cmd.js` | CLI 명령 예시 |

## 의존성

- `@ai-agent/core`: CLI 헬퍼, 유틸리티 (루트 monorepo)
- `@ai-agent/playwright-utils`: Puppeteer 브라우저 헬퍼 (루트 monorepo)
