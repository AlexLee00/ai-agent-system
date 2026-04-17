/**
 * Sigma Daily — v2 Thin Adapter (Phase 5)
 *
 * v1 로직은 docs/archive/sigma-legacy/ 로 이관됨.
 * Elixir v2 Commander를 HTTP로 호출하는 adapter.
 */

import axios from 'axios';

const SIGMA_V2_ENDPOINT =
  process.env.SIGMA_V2_ENDPOINT || 'http://localhost:4000/sigma/v2';

export async function runDaily(options: { test?: boolean } = {}): Promise<any> {
  const response = await axios.post(
    `${SIGMA_V2_ENDPOINT}/run-daily`,
    { test: options.test || false },
    { timeout: 120_000 },
  );
  return response.data;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  runDaily({ test: args.includes('--test') })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    })
    .catch((e: Error) => {
      console.error(`[sigma-daily] 실행 실패: ${e.message}`);
      process.exit(1);
    });
}
