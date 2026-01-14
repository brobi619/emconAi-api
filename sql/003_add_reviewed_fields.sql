-- 003_add_reviewed_fields.sql

ALTER TABLE kb_documents
  ADD COLUMN IF NOT EXISTS reviewed_fields JSONB NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ NULL;
