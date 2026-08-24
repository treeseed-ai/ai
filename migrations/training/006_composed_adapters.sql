ALTER TABLE library_runs ADD COLUMN IF NOT EXISTS composition_phase_job_id uuid;
ALTER TABLE library_runs ADD COLUMN IF NOT EXISTS composed_adapter_manifest_uri text;
ALTER TABLE library_runs ADD COLUMN IF NOT EXISTS composition_configuration_digest text;
