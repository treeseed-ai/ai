CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL, request jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','claimed','running','succeeded','failed','cancelling','cancelled')),
  priority integer NOT NULL DEFAULT 0, progress double precision NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 1),
  attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3, idempotency_key text NOT NULL UNIQUE,
  cancellation_requested boolean NOT NULL DEFAULT false, lease_owner text, lease_expires_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(), error jsonb, result_manifest text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS job_events (id bigserial PRIMARY KEY,job_id uuid NOT NULL REFERENCES jobs(id),type text NOT NULL,payload jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS api_keys (id text PRIMARY KEY,hash text NOT NULL,scopes text[] NOT NULL,revoked boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS candidates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),manifest_uri text NOT NULL UNIQUE,manifest jsonb NOT NULL,status text NOT NULL DEFAULT 'inactive',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS deployments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),candidate_id uuid NOT NULL REFERENCES candidates(id),active boolean NOT NULL DEFAULT false,previous_id uuid,source_job_id uuid UNIQUE,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS source_job_id uuid UNIQUE;
