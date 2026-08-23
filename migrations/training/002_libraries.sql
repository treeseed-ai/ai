CREATE TABLE IF NOT EXISTS libraries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL CHECK (source_kind IN ('open-webui','api')),
  external_id text NOT NULL,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_kind, external_id)
);

CREATE TABLE IF NOT EXISTS library_directories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id),
  external_id text NOT NULL,
  parent_external_id text,
  name text NOT NULL,
  relative_path text NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(library_id, external_id)
);

CREATE TABLE IF NOT EXISTS document_objects (
  sha256 char(64) PRIMARY KEY,
  object_uri text NOT NULL UNIQUE,
  size bigint NOT NULL CHECK (size >= 0),
  detected_mime_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS library_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL REFERENCES libraries(id),
  external_id text NOT NULL,
  current_revision_id uuid,
  state text NOT NULL DEFAULT 'received' CHECK (state IN ('received','classified','pending_processing','processing','ready','quarantined','deleted')),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(library_id, external_id)
);

CREATE TABLE IF NOT EXISTS document_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES library_documents(id),
  object_sha256 char(64) NOT NULL REFERENCES document_objects(sha256),
  revision integer NOT NULL,
  filename text NOT NULL,
  relative_path text NOT NULL,
  directory_external_id text,
  declared_mime_type text NOT NULL,
  detected_mime_type text NOT NULL,
  state text NOT NULL DEFAULT 'received' CHECK (state IN ('received','classified','pending_processing','processing','ready','quarantined')),
  provenance jsonb NOT NULL DEFAULT '{}',
  diagnostics jsonb NOT NULL DEFAULT '{}',
  normalized_manifest_uri text,
  token_count bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id, revision)
);

DO $$ BEGIN
  ALTER TABLE library_documents
    ADD CONSTRAINT library_documents_current_revision_fk
    FOREIGN KEY (current_revision_id) REFERENCES document_revisions(id)
    DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS library_documents_library_state_idx ON library_documents(library_id,state);
CREATE INDEX IF NOT EXISTS document_revisions_object_idx ON document_revisions(object_sha256);
