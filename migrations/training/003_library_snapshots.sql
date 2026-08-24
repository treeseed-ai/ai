CREATE TABLE IF NOT EXISTS document_processing_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES document_revisions(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  processor text NOT NULL,
  state text NOT NULL,
  diagnostics jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(revision_id,job_id)
);

CREATE TABLE IF NOT EXISTS library_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id),
  mode text NOT NULL CHECK (mode IN ('smoke','standard')),
  state text NOT NULL DEFAULT 'frozen' CHECK (state IN ('frozen','processing','ready','failed')),
  manifest_uri text,
  document_count integer NOT NULL DEFAULT 0,
  token_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS library_snapshot_documents (
  snapshot_id uuid NOT NULL REFERENCES library_snapshots(id),
  document_revision_id uuid NOT NULL REFERENCES document_revisions(id),
  relationship jsonb NOT NULL DEFAULT '{}',
  held_out boolean NOT NULL DEFAULT false,
  PRIMARY KEY(snapshot_id,document_revision_id)
);

CREATE TABLE IF NOT EXISTS library_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL UNIQUE REFERENCES library_snapshots(id),
  manifest_uri text NOT NULL UNIQUE,
  train_uri text NOT NULL,
  evaluation_uri text,
  token_count bigint NOT NULL,
  evaluation_token_count bigint NOT NULL DEFAULT 0,
  digest char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
