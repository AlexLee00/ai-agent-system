# refactorer-skill

## Purpose
Refactorer analyzes technical debt and performs safe, incremental code restructuring.
Triggered by Dexter findings, Reviewer comments, or explicit master requests.

## Capabilities
- Technical debt quantification (@ts-nocheck count, file size, duplication)
- Refactoring priority ranking (impact × risk)
- Safe file splitting (Scoped — one at a time)
- TypeScript type recovery (@ts-nocheck → strict)
- plugin-eval 3-layer verification (Static / LLM Judge / Monte Carlo)

## Workflow
1. Analyze target (MCP: analyze_tech_debt)
2. Suggest strategy (MCP: suggest_refactoring)
3. Create git rollback tag
4. Execute (Codex — code changes only)
5. Verify (plugin-eval harness)

## Outputs
- Tech debt score and priority list
- Refactoring plan per file
- Verification report (3-layer pass/fail)

## Safety
- Never modifies PROTECTED launchd services
- Requires test green before marking complete
- All actions rollback-able via git tag
