# Darwin Hooks

세션 시작/종료 시 R&D 현황을 자동으로 브리핑합니다.

## hooks.json에 수동 추가 필요

`.claude/hooks/hooks.json`의 SessionStart 배열에 추가:
```json
{ "hooks": [{ "type": "command", "command": "./bots/darwin/hooks/sessionstart.sh" }] }
```

Stop 배열에 추가:
```json
{ "hooks": [{ "type": "command", "command": "./bots/darwin/hooks/stop.sh" }] }
```
