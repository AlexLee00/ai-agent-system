declare module '@modelcontextprotocol/sdk/server/mcp.js' {
  export class McpServer {
    constructor(options: Record<string, unknown>);
    tool(
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: (input: unknown) => Promise<unknown> | unknown,
    ): void;
    connect(transport: unknown): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/server/stdio.js' {
  export class StdioServerTransport {
    constructor(...args: unknown[]);
  }
}
