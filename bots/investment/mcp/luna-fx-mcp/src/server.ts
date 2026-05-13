import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fxRateSchema, getFxRate } from './tools/fx-rate.ts';

const server = new McpServer({
  name: 'luna-fx-mcp',
  version: '1.0.0',
  description: '한국은행 환율 API — 루나팀 FX 데이터',
});

server.tool(
  'get_fx_rate',
  '한국은행 경제통계시스템(ECOS)에서 환율 데이터 조회',
  fxRateSchema.shape,
  async (input) => {
    const data = await getFxRate(input);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[luna-fx-mcp] MCP server started\n');
}

main().catch((err) => {
  process.stderr.write('[luna-fx-mcp] FATAL: ' + err.message + '\n');
  process.exit(1);
});
