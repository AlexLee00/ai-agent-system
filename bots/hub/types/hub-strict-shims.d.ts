declare module 'express' {
  export interface Request {
    headers: Record<string, string | string[] | undefined>;
    body?: any;
    query?: any;
    params?: any;
    path: string;
    method: string;
    protocol?: string;
    once(event: string, listener: (...args: any[]) => void): this;
    get?(name: string): string | undefined;
  }

  export interface Response {
    locals: Record<string, any>;
    set(name: string, value: string): this;
    status(code: number): this;
    json(body: any): this;
  }

  export type NextFunction = (error?: any) => void;
  export type RequestHandler = (req: Request, res: Response, next: NextFunction) => any;

  export interface Express {
    use(...handlers: any[]): this;
    get(path: string, ...handlers: any[]): this;
    post(path: string, ...handlers: any[]): this;
    delete(path: string, ...handlers: any[]): this;
    listen(port: number, host: string, callback: () => void): any;
  }
}
