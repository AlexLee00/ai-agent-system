-- 011: agent memory bootstrap

CREATE SCHEMA IF NOT EXISTS rag;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS rag.agent_memory (
  id SERIAL PRIMARY KEY,
  agent_id VARCHAR(50) NOT NULL,
  team VARCHAR(20) NOT NULL,
  memory_type VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  keywords TEXT[] DEFAULT '{}',
  embedding vector(1024),
  importance DOUBLE PRECISION DEFAULT 0.5,
  access_count INTEGER DEFAULT 0,
  last_accessed TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_agent
  ON rag.agent_memory (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_team
  ON rag.agent_memory (team);
CREATE INDEX IF NOT EXISTS idx_agent_memory_type
  ON rag.agent_memory (memory_type);
CREATE INDEX IF NOT EXISTS idx_agent_memory_importance
  ON rag.agent_memory (importance DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memory_expires_at
  ON rag.agent_memory (expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_memory_keywords
  ON rag.agent_memory USING gin (keywords);
CREATE INDEX IF NOT EXISTS idx_agent_memory_metadata
  ON rag.agent_memory USING gin (metadata);
CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding
  ON rag.agent_memory USING hnsw (embedding vector_cosine_ops);
