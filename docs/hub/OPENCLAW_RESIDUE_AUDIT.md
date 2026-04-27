# OpenClaw Residue Audit

This generated report classifies retired OpenClaw references. `runtime_blocker` must remain 0. Guard, documentation, ignored log, and archive-pending entries are tracked separately so they do not masquerade as live runtime dependencies.

- generated_at: 2026-04-27T13:11:02.381Z
- ok: true
- runtime_blocker: 0
- retired_gateway_guard: 67
- documentation: 15
- generated_inventory: 0
- ignored_log: 12
- dirty_worktree: 1
- retired_home_archive_pending: 1

## dirty_worktree

- .claude/worktrees/fervent-black (dirty agent worktree retained for manual review) — `60 changed entries`
## documentation

- bots/claude/reports/archer-2026-04-24.md:101 (markdown documentation/report reference) — `- [ARES: Adaptive Red-Teaming and End-to-End Repair of Policy-Reward System](https://arxiv.org/abs/2604.18789) — Thu, 23 Ap`
- docs/design/DESIGN_TEAM_JAY_AUTONOMOUS_ORCHESTRATION.md:124 (markdown documentation/report reference) — `- `packages/core/lib/hub-client.ts`: secret category는 `legacy_gateway`를 우선하고 retired alias는 compatibility only로 남긴다.`
- docs/design/DESIGN_TEAM_JAY_AUTONOMOUS_ORCHESTRATION.md:145 (markdown documentation/report reference) — `- `legacy_gateway_compat`: 0`
- docs/design/DESIGN_TEAM_JAY_AUTONOMOUS_ORCHESTRATION.md:32 (markdown documentation/report reference) — `1. **Retired gateway 분리**: legacy alarm shim, retired workspace path, port `18789`, auth profile store는 모두 compatibility layer로 낮춘다.`
- docs/design/DESIGN_TEAM_JAY_AUTONOMOUS_ORCHESTRATION.md:548 (markdown documentation/report reference) — `- `legacy_gateway_compat` 0으로 compatibility inventory 제거 완료.`
- docs/design/DESIGN_TEAM_JAY_AUTONOMOUS_ORCHESTRATION.md:598 (markdown documentation/report reference) — `- Retired gateway process, port `18789`, auth profile store가 없어도 Hub/Jay/Telegram/LLM smoke가 통과한다.`
- docs/design/DESIGN_TEAM_JAY_AUTONOMOUS_ORCHESTRATION.md:652 (markdown documentation/report reference) — `- retired gateway stopped 또는 port 18789 unavailable 상태에서 Hub health/alarm/control plan smoke 통과.`
- docs/history/CHANGELOG.md:2169 (markdown documentation/report reference) — `- `[::1]:18789` 주소를 `split(':')[0]` → `[` 로 파싱하는 버그 수정`
- docs/history/TEST_RESULTS.md:15 (markdown documentation/report reference) — `| `REPO_ROOT=... PROJECT_ROOT=... node bots/investment/scripts/parallel-ops-report.ts --publish` | ⚠️ alert 경로 호출은 성공했으나 `legacy-gateway`/Telegram fetch 및 `127.0.0.1:18789` 연결 실패 경고 발생 |`
- docs/history/TEST_RESULTS.md:29 (markdown documentation/report reference) — `| `npm run parallel-report -- --publish` | ⚠️ alert 경로 호출은 성공했으나 `legacy-gateway`/Telegram fetch 및 `127.0.0.1:18789` 연결 실패 경고 발생 |`
- docs/history/WORK_HISTORY.md:356 (markdown documentation/report reference) — `- `REPO_ROOT=... PROJECT_ROOT=... node bots/investment/scripts/parallel-ops-report.ts --publish` → legacy-gateway/Telegram fetch 실패 및 `127.0.0.1:18789` 연결 실패`
- docs/history/WORK_HISTORY.md:411 (markdown documentation/report reference) — `- `npm run parallel-report -- --publish` → alert 경로는 호출됐지만 `legacy-gateway`/Telegram fetch 및 `127.0.0.1:18789` 연결 실패 경고 발생`
- docs/hub/OAUTH_REAUTH_GUIDE.md:89 (markdown documentation/report reference) — `### OpenClaw에서 권한 부족이 보이지 않았던 이유`
- docs/hub/OAUTH_REAUTH_GUIDE.md:91 (markdown documentation/report reference) — `OpenClaw 소스 분석 기준으로, OpenClaw는 Codex OAuth를 일반 OpenAI public API 토큰처럼 쓰지 않습니다. `openai-codex` provider와 `openai-codex-responses` API를 별도 모델 경로로 취급하고, 기본 설정도 `https://chatgpt.com/backend-api` 계열 backend를 사용합니다. 사용량/쿨다운 확인`
- docs/hub/OAUTH_REAUTH_GUIDE.md:93 (markdown documentation/report reference) — `따라서 OpenClaw 사용 중 권한 부족이 보이지 않았던 것은 이상 징후가 아니라, 정상 운영 경로가 public `/v1/responses`가 아니었기 때문입니다. Hub도 같은 계약을 따르며, public API 토큰이 비어 있으면 public `/v1/responses`는 사용하지 않습니다. 반대로 public OpenAI API를 반드시 직접 사용해야 하는 배포에서는 `OPENAI_`
## ignored_log

- bots/blog/blog-daily.err.log (ignored historical log contains retired gateway marker)
- bots/blog/neighbor-commenter.err.log (ignored historical log contains retired gateway marker)
- bots/blog/neighbor-sympathy.err.log (ignored historical log contains retired gateway marker)
- bots/claude/archer.err.log (ignored historical log contains retired gateway marker)
- bots/claude/auto-dev.autonomous.err.log (ignored historical log contains retired gateway marker)
- bots/claude/codex-notifier.err.log (ignored historical log contains retired gateway marker)
- bots/claude/dexter-daily.log (ignored historical log contains retired gateway marker)
- bots/claude/dexter-quick.err.log (ignored historical log contains retired gateway marker)
- bots/claude/dexter.err.log (ignored historical log contains retired gateway marker)
- bots/claude/dexter.log (ignored historical log contains retired gateway marker)
- bots/hub/hub.err.log (ignored historical log contains retired gateway marker)
- bots/hub/hub.log (ignored historical log contains retired gateway marker)
## retired_gateway_guard

- bots/hub/lib/alarm/cluster.ts:46 (intentional regression guard) — `if (/openclaw|legacy[_\s-]?gateway|18789/.test(corpus)) return 'retired_gateway_regression';`
- bots/hub/scripts/active-runtime-legacy-gateway-isolation-smoke.ts:81 (intentional smoke/report guard) — `active_runtime_legacy_gateway_isolated: true,`
- bots/hub/scripts/claude-code-oauth-direct-smoke.ts:105 (intentional smoke/report guard) — `legacy_gateway_used: false,`
- bots/hub/scripts/claude-runtime-legacy-gateway-isolation-smoke.ts:81 (intentional smoke/report guard) — `claude_runtime_legacy_gateway_isolated: true,`
- bots/hub/scripts/generate-hub-alarm-inventory.ts:112 (intentional smoke/report guard) — `legacy_gateway_compat: counts.legacy_gateway_compat || 0,`
- bots/hub/scripts/generate-hub-alarm-inventory.ts:157 (intentional smoke/report guard) — `if ((payload.categories.legacy_gateway_compat || 0) > 0) {`
- bots/hub/scripts/generate-hub-alarm-inventory.ts:159 (intentional smoke/report guard) — `.filter((row) => row.category === 'legacy_gateway_compat')`
- bots/hub/scripts/generate-hub-alarm-inventory.ts:179 (intentional smoke/report guard) — `'This inventory tracks the Hub alarm migration surface. `hub_alarm_native` entries are the desired path; `retired_gateway_guard` entries are regression guards; `legacy_gateway_compat` entries are remaining migration targ`
- bots/hub/scripts/generate-hub-alarm-inventory.ts:186 (intentional smoke/report guard) — ``- legacy_gateway_compat: ${payload.categories.legacy_gateway_compat || 0}`,`
- bots/hub/scripts/generate-hub-alarm-inventory.ts:38 (intentional smoke/report guard) — `if (match.includes(LEGACY_ALARM_CLIENT_PATTERN)) return 'legacy_gateway_compat';`
- bots/hub/scripts/generate-hub-alarm-inventory.ts:40 (intentional smoke/report guard) — `return isRetiredGatewayGuard(file) ? 'retired_gateway_guard' : 'legacy_gateway_compat';`
- bots/hub/scripts/generate-hub-alarm-inventory.ts:62 (intentional smoke/report guard) — `'!docs/hub/OPENCLAW_RESIDUE_AUDIT.md',`
- bots/hub/scripts/hub-alarm-import-transition-smoke.ts:120 (intentional smoke/report guard) — `legacy_gateway_runtime_defaults: 0,`
- bots/hub/scripts/hub-transition-completion-gate.ts:43 (intentional smoke/report guard) — `'legacy_gateway',`
- bots/hub/scripts/hub-transition-completion-gate.ts:46 (intentional smoke/report guard) — `'openclaw',`
- bots/hub/scripts/hub-transition-completion-gate.ts:47 (intentional smoke/report guard) — `'openclaw-gateway',`
- bots/hub/scripts/hub-transition-completion-gate.ts:48 (intentional smoke/report guard) — `'OPENCLAW_BIN',`
- bots/hub/scripts/hub-transition-completion-gate.ts:49 (intentional smoke/report guard) — `'18789',`
- bots/hub/scripts/hub-transition-completion-gate.ts:52 (intentional smoke/report guard) — `const RETIRED_GATEWAY_SOURCE_PATTERN = 'openclaw|legacy_gateway|18789|openclaw-gateway|OPENCLAW_BIN|execFile\\([^\\n]*openclaw|spawn\\([^\\n]*openclaw';`
- bots/hub/scripts/legacy-gateway-admin-guard-smoke.ts:59 (intentional smoke/report guard) — `legacy_gateway_admin_permanently_retired: true,`
- bots/hub/scripts/legacy-gateway-independence-smoke.ts:11 (intentional smoke/report guard) — `const RETIRED_GATEWAY_PORT = '18789';`
- bots/hub/scripts/legacy-gateway-independence-smoke.ts:114 (intentional smoke/report guard) — `legacy_gateway_core: false,`
- bots/hub/scripts/legacy-gateway-independence-smoke.ts:115 (intentional smoke/report guard) — `legacy_gateway_hub_label: false,`
- bots/hub/scripts/legacy-gateway-independence-smoke.ts:116 (intentional smoke/report guard) — `legacy_gateway_retired: true,`
- bots/hub/scripts/legacy-gateway-independence-smoke.ts:117 (intentional smoke/report guard) — `legacy_gateway_launchd_templates_removed: true,`
- bots/hub/scripts/legacy-gateway-independence-smoke.ts:118 (intentional smoke/report guard) — `reboot_scripts_legacy_gateway_free: true,`
- bots/hub/scripts/legacy-gateway-independence-smoke.ts:119 (intentional smoke/report guard) — `registry_legacy_gateway_free: true,`
- bots/hub/scripts/legacy-gateway-independence-smoke.ts:120 (intentional smoke/report guard) — `auto_commit_legacy_gateway_free: true,`
- bots/hub/scripts/legacy-gateway-independence-smoke.ts:121 (intentional smoke/report guard) — `legacy_gateway_secret_tokens_retired: true,`
- bots/hub/scripts/legacy-gateway-independence-smoke.ts:97 (intentional smoke/report guard) — `assert(!secretsRoute.includes('legacy_gateway'), 'Hub secrets route must not expose retired gateway category');`
- bots/hub/scripts/llm-control-independence-smoke.ts:76 (intentional smoke/report guard) — `llm_control_legacy_gateway_free_defaults: true,`
- bots/hub/scripts/openai-codex-backend-direct-smoke.ts:92 (intentional smoke/report guard) — `legacy_gateway_used: false,`
- bots/hub/scripts/retired-gateway-cutover-readiness.ts:40 (intentional smoke/report guard) — `runStep('openclaw-runtime-retirement', ['scripts/openclaw-runtime-retirement-smoke.ts']),`
- bots/hub/scripts/retired-gateway-cutover-readiness.ts:44 (intentional smoke/report guard) — `const residueAudit = readJson('bots/hub/output/openclaw-residue-audit.json');`
- bots/hub/scripts/retired-gateway-cutover-readiness.ts:47 (intentional smoke/report guard) — `legacy_gateway_compat: Number(alarmInventory.categories?.legacy_gateway_compat || 0),`
- bots/hub/scripts/retired-gateway-cutover-readiness.ts:56 (intentional smoke/report guard) — `&& blocking.legacy_gateway_compat === 0`
- bots/hub/scripts/retired-gateway-marker-precommit-smoke.ts:19 (intentional smoke/report guard) — `for (const marker of ['openclaw-gateway', 'OPENCLAW_BIN', '18789', 'execFile[^\\n]*openclaw', 'spawn[^\\n]*openclaw']) {`
- bots/hub/scripts/retired-gateway-marker-precommit-smoke.ts:26 (intentional smoke/report guard) — `assert(!checklist.includes('nc -z 127.0.0.1 18789'), 'migration checklist must not accept retired gateway port as Hub health');`
- bots/hub/scripts/retired-gateway-marker-precommit-smoke.ts:28 (intentional smoke/report guard) — `assert(legacySmoke.includes('RETIRED_GATEWAY_BIN_ENV'), 'legacy smoke must guard OPENCLAW_BIN');`
- bots/hub/scripts/retired-gateway-marker-precommit-smoke.ts:29 (intentional smoke/report guard) — `assert(legacySmoke.includes('execFile\\\\([^\\\\n]*'), 'legacy smoke must guard execFile openclaw reintroduction');`
- bots/hub/scripts/retired-gateway-residue-audit.ts:117 (intentional smoke/report guard) — `'!docs/hub/OPENCLAW_RESIDUE_AUDIT.md',`
- bots/hub/scripts/retired-gateway-residue-audit.ts:27 (intentional smoke/report guard) — `const outputJsonPath = path.join(outputDir, 'openclaw-residue-audit.json');`
- bots/hub/scripts/retired-gateway-residue-audit.ts:28 (intentional smoke/report guard) — `const outputMarkdownPath = path.join(repoRoot, 'docs', 'hub', 'OPENCLAW_RESIDUE_AUDIT.md');`
- bots/hub/scripts/retired-gateway-residue-audit.ts:282 (intentional smoke/report guard) — `'# OpenClaw Residue Audit',`
- bots/hub/scripts/retired-gateway-residue-audit.ts:284 (intentional smoke/report guard) — `'This generated report classifies retired OpenClaw references. `runtime_blocker` must remain 0. Guard, documentation, ignored log, and archive-pending entries are tracked separately so they do not masquerade as live runt`
- bots/hub/scripts/retired-gateway-residue-audit.ts:35 (intentional smoke/report guard) — `'OpenClaw',`
- bots/hub/scripts/retired-gateway-residue-audit.ts:38 (intentional smoke/report guard) — `'legacy_gateway',`
- bots/hub/scripts/retired-gateway-residue-audit.ts:39 (intentional smoke/report guard) — `'openclaw-client',`
- bots/hub/scripts/retired-gateway-residue-audit.ts:40 (intentional smoke/report guard) — `'openclaw-gateway',`
- bots/hub/scripts/retired-gateway-residue-audit.ts:50 (intentional smoke/report guard) — `'bots/hub/scripts/openclaw-runtime-retirement-smoke.ts',`
- bots/hub/scripts/retired-gateway-residue-audit.ts:81 (intentional smoke/report guard) — `if (file.startsWith('bots/hub/output/') || file === 'docs/hub/OPENCLAW_RESIDUE_AUDIT.md' || file === 'docs/hub/HUB_ALARM_DEPENDENCY_INVENTORY.md') {`
- bots/hub/scripts/run-tests.ts:160 (intentional regression guard) — `'openclaw-runtime-retirement-smoke.ts',`
- bots/hub/scripts/runtime-env-policy-smoke.ts:22 (intentional smoke/report guard) — `OPENCLAW_BIN: '/tmp/openclaw',`
- bots/hub/scripts/runtime-env-policy-smoke.ts:31 (intentional smoke/report guard) — `assert.equal(filtered.env.OPENCLAW_BIN, undefined);`
- bots/hub/scripts/runtime-env-policy-smoke.ts:43 (intentional smoke/report guard) — `assert.notEqual(childEnv.OPENCLAW_BIN, '/tmp/openclaw');`
- bots/hub/scripts/runtime-profile-settings-smoke.ts:42 (intentional smoke/report guard) — `legacy_gateway_agent_field: false,`
- bots/hub/scripts/runtime-profile-settings-smoke.ts:43 (intentional smoke/report guard) — `legacy_gateway_settings_dependency: false,`
- bots/hub/scripts/runtime-workspace-independence-smoke.ts:128 (intentional smoke/report guard) — `default_workspace_legacy_gateway_free: true,`
- bots/hub/scripts/runtime-workspace-independence-smoke.ts:130 (intentional smoke/report guard) — `legacy_gateway_runtime_aliases_exported: false,`
- bots/hub/scripts/video-hub-transition-smoke.ts:42 (intentional smoke/report guard) — `config_legacy_gateway_free: true,`
- packages/core/lib/runtime-env-policy.ts:9 (intentional regression guard) — `'OPENCLAW_',`
- scripts/pre-commit:139 (intentional regression guard) — `'openclaw-gateway'`
- scripts/pre-commit:140 (intentional regression guard) — `'OPENCLAW_BIN'`
- scripts/pre-commit:141 (intentional regression guard) — `'18789'`
- scripts/pre-commit:142 (intentional regression guard) — `'execFile[^\n]*openclaw'`
- scripts/pre-commit:143 (intentional regression guard) — `'spawn[^\n]*openclaw'`
- scripts/pre-commit:155 (intentional regression guard) — `echo -e "${RED}❌ retired OpenClaw gateway marker 재도입 차단: ${file}${NC}"`
## retired_home_archive_pending

- /Users/alexlee/.openclaw (retired home directory exists; archive/delete requires explicit data-retention decision) — `5517 MB`
