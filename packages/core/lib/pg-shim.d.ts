declare module 'pg' {
  export class Pool {
    constructor(config?: Record<string, unknown>);
    options?: { options?: string };
    totalCount: number;
    idleCount: number;
    waitingCount: number;
    query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
    connect(): Promise<{
      query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
      release(): void;
    }>;
    end(): Promise<void>;
    on(event: string, listener: (...args: any[]) => void): this;
  }
}
