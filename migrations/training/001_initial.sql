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
CREATE TABLE IF NOT EXISTS artifacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text NOT NULL,manifest_uri text NOT NULL UNIQUE,manifest jsonb NOT NULL,archived boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS signing_keys (id text PRIMARY KEY,public_key text NOT NULL,active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now());
