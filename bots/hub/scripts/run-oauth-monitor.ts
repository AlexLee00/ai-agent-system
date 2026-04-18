// @ts-nocheck
import { checkTokenHealth, checkGroqAccounts } from '../lib/llm/oauth-monitor.js';

async function main() {
  const oauth = await checkTokenHealth();
  if (!oauth.healthy) {
    console.error('[oauth-monitor] 토큰 만료/오류:', oauth.error);
  } else if (oauth.needs_refresh) {
    console.warn(`[oauth-monitor] 토큰 갱신 필요: ${oauth.expires_in_hours.toFixed(1)}h 후 만료`);
  } else {
    console.log(`[oauth-monitor] OAuth 정상: ${oauth.expires_in_hours.toFixed(1)}h 남음`);
  }

  const groq = await checkGroqAccounts();
  const healthy = groq.filter(a => a.healthy).length;
  console.log(`[oauth-monitor] Groq 계정: ${healthy}/${groq.length} 정상`);
}

main().catch(e => { console.error(e); process.exit(1); });
