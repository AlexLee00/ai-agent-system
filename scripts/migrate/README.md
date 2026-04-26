# Retired Migration Scripts

The old Mac mini migration scripts are intentionally disabled.

Current setup and verification should use the Hub-native path:

```bash
bash scripts/setup-dev.sh
npm --prefix bots/hub run test:unit
npm --prefix bots/hub run check:runtime
```

The three shell entrypoints in this folder now fail closed so stale runbooks do
not reinstall or validate retired gateway services.
