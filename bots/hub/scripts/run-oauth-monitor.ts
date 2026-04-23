// @ts-nocheck
import { checkTokenHealth, checkOpenAIOAuthHealth, checkGroqAccounts } from '../lib/llm/oauth-monitor.js';

async function main() {
  const claudeOauth = await checkTokenHealth();
  if (!claudeOauth.healthy) {
    console.error('[oauth-monitor] Claude OAuth 오류:', claudeOauth.error);
  } else if (claudeOauth.needs_refresh) {
    console.warn(`[oauth-monitor] Claude OAuth 갱신 필요: ${claudeOauth.expires_in_hours.toFixed(1)}h 후 만료`);
  } else {
    console.log(`[oauth-monitor] Claude OAuth 정상: ${claudeOauth.expires_in_hours.toFixed(1)}h 남음 (${claudeOauth.account || 'unknown'})`);
  }

  const openaiOauth = await checkOpenAIOAuthHealth();
  if (!openaiOauth.healthy) {
    console.error('[oauth-monitor] OpenAI OAuth 오류:', openaiOauth.error);
  } else {
    console.log(`[oauth-monitor] OpenAI OAuth 정상: source=${openaiOauth.source || 'unknown'} model=${openaiOauth.model || 'unknown'}`);
  }

  const groq = await checkGroqAccounts();
  console.log(`[oauth-monitor] Groq 계정: ${groq.available_accounts}/${groq.total_accounts} 정상`);
}

main().catch(e => { console.error(e); process.exit(1); });
