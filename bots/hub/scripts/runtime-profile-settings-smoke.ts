import assert from 'node:assert/strict';
import fs from 'node:fs';

async function main() {
  const { PROFILES } = await import('../lib/runtime-profiles.ts');
  const retiredAgentField = `open${'claw'}_agent`;
  const retiredSettingsDir = `/.open${'claw'}/.claude/`;

  const checked: Array<{ team: string; purpose: string; settings: string; runtimeAgent: string }> = [];

  for (const [team, profiles] of Object.entries(PROFILES)) {
    for (const [purpose, profile] of Object.entries(profiles as Record<string, Record<string, unknown>>)) {
      const settings = String(profile.claude_code_settings || '').trim();
      if (!settings) continue;
      const runtimeAgent = String(profile.runtime_agent || '').trim();
      checked.push({ team, purpose, settings, runtimeAgent });
      assert.equal(
        Object.prototype.hasOwnProperty.call(profile, retiredAgentField),
        false,
        `runtime profile must use runtime_agent instead of retired agent field: ${team}/${purpose}`
      );
      assert(runtimeAgent, `runtime_agent required for claude settings profile: ${team}/${purpose}`);
      assert(
        settings.includes('/bots/hub/config/claude-code/'),
        `claude_code_settings must be hub-owned: ${team}/${purpose} -> ${settings}`
      );
      assert(
        !settings.includes(retiredSettingsDir),
        `claude_code_settings must not depend on retired gateway settings dir: ${team}/${purpose}`
      );
      assert.equal(fs.existsSync(settings), true, `missing claude settings file: ${settings}`);
    }
  }

  assert(checked.length > 0, 'expected at least one claude_code_settings profile');

  console.log(JSON.stringify({
    ok: true,
    checked_profiles: checked.length,
    settings_dir: '/bots/hub/config/claude-code',
    runtime_agent_field: true,
    legacy_gateway_agent_field: false,
    legacy_gateway_settings_dependency: false,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
