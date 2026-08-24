CREATE TABLE IF NOT EXISTS library_training_profiles (
  fingerprint text PRIMARY KEY,
  sequence_length integer NOT NULL CHECK(sequence_length IN (1024,2048,3072,4096)),
  qualified_at timestamptz NOT NULL DEFAULT now(), diagnostics jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS library_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), library_id uuid NOT NULL REFERENCES libraries(id),
  snapshot_id uuid NOT NULL REFERENCES library_snapshots(id), dataset_id uuid REFERENCES library_datasets(id),
  mode text NOT NULL CHECK(mode IN ('smoke','standard')),
  state text NOT NULL DEFAULT 'frozen' CHECK(state IN ('frozen','draining','sleeping','processing','dataset','training','waking','importing','evaluating','promoting','rejected','succeeded','failed','cancelled','postponed')),
  phase_job_id uuid, adapter_manifest_uri text, candidate_id text, evaluation_manifest_uri text,
  promotion_eligible boolean NOT NULL DEFAULT false, error jsonb, idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_runs_library_created_idx ON library_runs(library_id,created_at DESC);
CREATE TABLE IF NOT EXISTS library_adapter_lineage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL UNIQUE REFERENCES library_runs(id),
  purpose text NOT NULL CHECK(purpose='continual-pretraining'), base_model text NOT NULL,
  base_revision text NOT NULL, target_modules text[] NOT NULL, rank integer NOT NULL,
  alpha integer NOT NULL, configuration_digest text NOT NULL, manifest_uri text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION sync_library_run_job_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type='library.training.qlora' AND NEW.request ? 'runId' THEN
    IF NEW.state='succeeded' THEN UPDATE library_runs SET state='waking',updated_at=now() WHERE id=(NEW.request->>'runId')::uuid;
    ELSIF NEW.state='failed' THEN UPDATE library_runs SET state='failed',error=NEW.error,updated_at=now() WHERE id=(NEW.request->>'runId')::uuid;
    ELSIF NEW.state='cancelled' THEN UPDATE library_runs SET state='cancelled',updated_at=now() WHERE id=(NEW.request->>'runId')::uuid;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sync_library_run_job_state_trigger ON jobs;
CREATE TRIGGER sync_library_run_job_state_trigger AFTER UPDATE OF state ON jobs FOR EACH ROW EXECUTE FUNCTION sync_library_run_job_state();
