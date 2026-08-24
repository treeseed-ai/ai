ALTER TABLE library_datasets ADD COLUMN IF NOT EXISTS multimodal_train_uri text;
ALTER TABLE library_datasets ADD COLUMN IF NOT EXISTS multimodal_evaluation_uri text;
ALTER TABLE library_datasets ADD COLUMN IF NOT EXISTS multimodal_example_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS library_multimodal_training_profiles (
  fingerprint text PRIMARY KEY,
  sequence_length integer NOT NULL CHECK(sequence_length IN (1024,2048,3072,4096)),
  max_pixels integer NOT NULL CHECK(max_pixels IN (262144,524288,786432)),
  qualified_at timestamptz NOT NULL DEFAULT now(),
  diagnostics jsonb NOT NULL DEFAULT '{}'
);

ALTER TABLE library_runs ADD COLUMN IF NOT EXISTS vision_phase_job_id uuid;
ALTER TABLE library_runs ADD COLUMN IF NOT EXISTS vision_adapter_manifest_uri text;
ALTER TABLE library_runs ADD COLUMN IF NOT EXISTS vision_configuration_digest text;

ALTER TABLE library_adapter_lineage DROP CONSTRAINT IF EXISTS library_adapter_lineage_run_id_key;
ALTER TABLE library_adapter_lineage ADD COLUMN IF NOT EXISTS modality text NOT NULL DEFAULT 'language' CHECK(modality IN ('language','vision','composed'));
CREATE UNIQUE INDEX IF NOT EXISTS library_adapter_lineage_run_modality_idx ON library_adapter_lineage(run_id,modality);
