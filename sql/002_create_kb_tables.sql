-- 002_create_kb_tables.sql

-- KB document types
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'kb_document_type') THEN
    CREATE TYPE kb_document_type AS ENUM (
      'past_performance',
      'resumes',
      'capabilities',
      'compliance',
      'templates',
      'other'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'kb_extraction_status') THEN
    CREATE TYPE kb_extraction_status AS ENUM ('pending', 'extracted', 'failed');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'kb_review_status') THEN
    CREATE TYPE kb_review_status AS ENUM ('pending', 'approved', 'rejected');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'kb_index_status') THEN
    CREATE TYPE kb_index_status AS ENUM ('not_indexed', 'indexing', 'indexed', 'failed');
  END IF;
END$$;

-- KB documents
CREATE TABLE IF NOT EXISTS kb_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kb_type kb_document_type NOT NULL,
  source_filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  created_by_user_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  extraction_status kb_extraction_status NOT NULL DEFAULT 'pending',
  review_status kb_review_status NOT NULL DEFAULT 'pending',
  index_status kb_index_status NOT NULL DEFAULT 'not_indexed',
  error_message TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_documents_tenant_type ON kb_documents(tenant_id, kb_type);
CREATE INDEX IF NOT EXISTS idx_kb_documents_tenant_created ON kb_documents(tenant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_documents_tenant_sha256 ON kb_documents(tenant_id, sha256);

-- KB chunks
CREATE TABLE IF NOT EXISTS kb_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  kb_document_id UUID NOT NULL,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  content_tokens INT NULL,
  page_number INT NULL,
  section TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_kb_chunks_document FOREIGN KEY (kb_document_id) REFERENCES kb_documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc_idx ON kb_chunks(kb_document_id, chunk_index);

-- KB extractions
CREATE TABLE IF NOT EXISTS kb_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  kb_document_id UUID NOT NULL,
  extracted_json JSONB NOT NULL,
  extracted_text_preview TEXT NULL,
  extractor_version TEXT NOT NULL DEFAULT 'v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_kb_extractions_document FOREIGN KEY (kb_document_id) REFERENCES kb_documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kb_extractions_doc ON kb_extractions(kb_document_id);

-- KB index runs (optional)
CREATE TABLE IF NOT EXISTS kb_index_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  kb_document_id UUID NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dim INT NOT NULL,
  qdrant_collection TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL DEFAULT 'running',
  error_message TEXT NULL,
  CONSTRAINT fk_kb_index_runs_document FOREIGN KEY (kb_document_id) REFERENCES kb_documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kb_index_runs_doc ON kb_index_runs(kb_document_id);
