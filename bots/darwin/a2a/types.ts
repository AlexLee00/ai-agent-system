// A2A Protocol (Google 2025) — 타입 정의
// https://google.github.io/A2A/

export interface A2ASkillRef {
  id: string;
  version?: string;
}

export interface A2ATask {
  id: string;
  skill: A2ASkillRef;
  params?: unknown;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface A2ATaskResult {
  id: string;
  status: 'completed' | 'failed' | 'in_progress';
  output?: unknown;
  error?: { code: number; message: string };
  metadata?: Record<string, unknown>;
}

export interface A2AMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  payload: unknown;
  timestamp?: string;
}

export interface A2AMessageResult {
  id: string;
  status: 'received' | 'rejected';
}

export interface A2ANotification {
  type: string;
  payload: unknown;
  timestamp?: string;
  source?: string;
}

export interface A2AStreamChunk {
  taskId: string;
  chunk: unknown;
  done: boolean;
}
