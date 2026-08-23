ALTER TABLE candidates ADD COLUMN IF NOT EXISTS purpose text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS library_id text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS library_slug text;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS deployment_key text NOT NULL DEFAULT 'local-model';
UPDATE deployments SET deployment_key='local-model' WHERE deployment_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS deployments_one_active_key_idx ON deployments(deployment_key) WHERE active=true;
CREATE INDEX IF NOT EXISTS deployments_key_created_idx ON deployments(deployment_key,created_at DESC);
