// @ts-nocheck
'use strict';

const kst = require('../kst');

const MCP_DIR_PATTERN = 'bots/<team>/mcp/<name>';

function serverTsTemplate(name, description) {
  return [
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
    '',
    `const server = new McpServer({`,
    `  name: '${name}',`,
    `  version: '1.0.0',`,
    `  description: '${description}',`,
    `});`,
    '',
    '// TODO: register tools',
    '// server.tool("tool-name", schema, handler);',
    '',
    'async function main() {',
    '  const transport = new StdioServerTransport();',
    '  await server.connect(transport);',
    `  process.stderr.write('[${name}] MCP server started\\n');`,
    '}',
    '',
    'main().catch((err) => {',
    `  process.stderr.write('[${name}] FATAL: ' + err.message + '\\n');`,
    '  process.exit(1);',
    '});',
  ].join('\n');
}

function toolTsTemplate(toolName, apiUrl) {
  return [
    "import { z } from 'zod';",
    '',
    `export const ${toolName}Schema = z.object({`,
    '  query: z.string().describe("검색어"),',
    '});',
    '',
    `export async function ${toolName}(input) {`,
    `  const apiKey = process.env.${toolName.toUpperCase()}_API_KEY;`,
    '  if (!apiKey) throw new Error("API key not configured");',
    `  const url = new URL('${apiUrl || ""}');`,
    '  url.searchParams.set("serviceKey", apiKey);',
    '  url.searchParams.set("q", input.query);',
    '  const resp = await fetch(url.toString());',
    '  if (!resp.ok) throw new Error(`API error: ${resp.status}`);',
    '  return resp.json();',
    '}',
  ].join('\n');
}

function createMcpScaffold(team, name, description, tools) {
  const dir = MCP_DIR_PATTERN.replace('<team>', team || '').replace('<name>', name || '');
  return {
    team: team || '',
    name: name || '',
    description: description || '',
    tools: Array.isArray(tools) ? tools : [],
    dirPattern: dir,
    files: {
      'src/server.ts': serverTsTemplate(name, description),
      'src/types.ts': '// shared types\nexport {};\n',
      'package.json': JSON.stringify({ name, version: '1.0.0', private: true, type: 'module' }, null, 2),
    },
    createdAt: kst.datetimeStr(),
  };
}

function addTool(scaffold, toolName, apiUrl) {
  const target = scaffold || {};
  if (!target.files) target.files = {};
  target.files[`src/tools/${toolName}.ts`] = toolTsTemplate(toolName, apiUrl || '');
  if (!Array.isArray(target.tools)) target.tools = [];
  target.tools.push(toolName);
  return target;
}

function buildSettingsEntry(scaffold) {
  const s = scaffold || {};
  return {
    [s.name]: {
      command: 'node',
      args: ['--experimental-strip-types', `${s.dirPattern}/src/server.ts`],
      env: {},
    },
  };
}

module.exports = { createMcpScaffold, addTool, buildSettingsEntry };