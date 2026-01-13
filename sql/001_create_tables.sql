-- 001_create_tables.sql

-- Enable UUID generation (Postgres 13+ typically supports this)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rfp_solicitation_status') THEN
    CREATE TYPE rfp_solicitation_status AS ENUM (
      'draft',
      'released',
      'amendment',
      'closed',
      'awarded',
      'cancelled',
      'archived'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rfp_extraction_status') THEN
    CREATE TYPE rfp_extraction_status AS ENUM (
      'pending',
      'extracted',
      'confirmed',
      'failed'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'storage_provider') THEN
    CREATE TYPE storage_provider AS ENUM (
      'local',
      's3',
      'r2',
      'azureblob'
    );
  END IF;
END$$;

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  email TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,

  password_hash TEXT,
  auth_provider TEXT NOT NULL DEFAULT 'local',

  is_approved BOOLEAN NOT NULL DEFAULT false,
  last_login_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_approved ON users(is_approved);
CREATE INDEX IF NOT EXISTS idx_users_last_login ON users(last_login_at);

-- RFPS
CREATE TABLE IF NOT EXISTS rfps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  rfp_number TEXT NOT NULL,
  title TEXT,
  agency TEXT NOT NULL,
  sub_agency TEXT,
  naics_code TEXT,
  set_aside TEXT,

  solicitation_status rfp_solicitation_status NOT NULL DEFAULT 'draft',
  due_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,

  storage_provider storage_provider NOT NULL DEFAULT 'local',
  storage_path TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  file_sha256 TEXT UNIQUE,
  mime_type TEXT,
  file_size_bytes BIGINT,

  extraction_status rfp_extraction_status NOT NULL DEFAULT 'pending',
  extracted_fields_json JSONB,

  solicitation_url TEXT,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID NOT NULL,
  updated_at TIMESTAMPTZ,
  updated_by_user_id UUID,

  CONSTRAINT fk_rfps_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users(id),

  CONSTRAINT fk_rfps_updated_by
    FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_rfps_rfp_number ON rfps(rfp_number);
CREATE INDEX IF NOT EXISTS idx_rfps_agency ON rfps(agency);
CREATE INDEX IF NOT EXISTS idx_rfps_due_at ON rfps(due_at);
CREATE INDEX IF NOT EXISTS idx_rfps_status ON rfps(solicitation_status);
CREATE INDEX IF NOT EXISTS idx_rfps_created_by ON rfps(created_by_user_id);

-- RFP_ANALYSES (no analysis_type)
CREATE TABLE IF NOT EXISTS rfp_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfp_id UUID NOT NULL,

  analysis_json JSONB NOT NULL,

  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  rag_corpus_version TEXT,
  source_files_hash TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID NOT NULL,
  notes TEXT,

  CONSTRAINT fk_rfp_analyses_rfp
    FOREIGN KEY (rfp_id) REFERENCES rfps(id) ON DELETE CASCADE,

  CONSTRAINT fk_rfp_analyses_user
    FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_rfp_analyses_rfp_id ON rfp_analyses(rfp_id);
CREATE INDEX IF NOT EXISTS idx_rfp_analyses_created_at ON rfp_analyses(created_at);
