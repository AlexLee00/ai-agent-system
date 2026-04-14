-- 010: RAG library 1st/2nd layer bootstrap

CREATE SCHEMA IF NOT EXISTS rag;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS rag.schema_index (
  id SERIAL PRIMARY KEY,
  collection VARCHAR(50) NOT NULL,
  title TEXT NOT NULL,
  category VARCHAR(50),
  tags TEXT[] DEFAULT '{}',
  agent VARCHAR(50),
  doc_count INTEGER DEFAULT 0,
  chunk_count INTEGER DEFAULT 0,
  date_range_start DATE,
  date_range_end DATE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_schema_index_collection_title
  ON rag.schema_index (collection, title);
CREATE INDEX IF NOT EXISTS idx_rag_schema_index_collection
  ON rag.schema_index (collection);
CREATE INDEX IF NOT EXISTS idx_rag_schema_index_agent
  ON rag.schema_index (agent);
CREATE INDEX IF NOT EXISTS idx_rag_schema_index_category
  ON rag.schema_index (category);
CREATE INDEX IF NOT EXISTS idx_rag_schema_index_tags
  ON rag.schema_index USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_rag_schema_index_metadata
  ON rag.schema_index USING gin (metadata);

CREATE TABLE IF NOT EXISTS rag.summary (
  id SERIAL PRIMARY KEY,
  doc_id BIGINT NOT NULL,
  source_collection VARCHAR(50) NOT NULL,
  summary TEXT NOT NULL,
  keywords TEXT[] DEFAULT '{}',
  agent VARCHAR(50),
  embedding vector(1024),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_summary_collection_doc
  ON rag.summary (source_collection, doc_id);
CREATE INDEX IF NOT EXISTS idx_rag_summary_embedding
  ON rag.summary USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_rag_summary_collection
  ON rag.summary (source_collection);
CREATE INDEX IF NOT EXISTS idx_rag_summary_agent
  ON rag.summary (agent);
CREATE INDEX IF NOT EXISTS idx_rag_summary_keywords
  ON rag.summary USING gin (keywords);
CREATE INDEX IF NOT EXISTS idx_rag_summary_metadata
  ON rag.summary USING gin (metadata);
