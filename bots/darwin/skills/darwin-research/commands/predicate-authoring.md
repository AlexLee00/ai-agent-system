# Predicate Authoring

`successPredicate` must be executable in a lab worktree without external mutation.

Required shape:

```json
{
  "assertions": [
    { "name": "syntax", "command": "node --check path/file.js", "expect": { "exitCode": 0 } }
  ],
  "budget": { "maxWallMs": 300000, "maxLlmCalls": 20 }
}
```

Rules:

- Use 3 to 6 assertions.
- Prefer syntax, smoke, fixture, and read-only report commands.
- Allowed expects: `exitCode: 0` or `stdoutIncludes`.
- Do not use `launchctl`, `git push`, `gh pr`, `psql`, `rm -rf`, or shell redirection.
- Commands run from lab cwd, not OPS root.

If predicate generation fails, leave the proposal in review and record `predicate_error`.
