# Blog Hooks

세션 시작 시 블로그 운영 현황을 자동으로 브리핑합니다.

## hooks.json에 수동 추가 필요

`.claude/hooks/hooks.json`의 SessionStart 배열에 추가:
```json
{ "hooks": [{ "type": "command", "command": "./bots/blog/hooks/sessionstart.sh" }] }
```
