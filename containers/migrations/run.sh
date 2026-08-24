#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${TREEAI_MIGRATION_PRODUCT:?TREEAI_MIGRATION_PRODUCT is required}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS treeai_schema_migrations (
  product text NOT NULL,
  version text NOT NULL,
  checksum char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product, version)
);
SQL

for migration in /migrations/*.sql; do
	version="$(basename "$migration" .sql)"
	checksum="$(sha256sum "$migration" | cut -d ' ' -f 1)"
	case "$version" in
		*[!A-Za-z0-9_.-]*) echo "Invalid migration filename: $version" >&2; exit 1 ;;
	esac
	existing="$(psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -v product="$TREEAI_MIGRATION_PRODUCT" -v version="$version" <<'SQL'
SELECT checksum FROM treeai_schema_migrations WHERE product=:'product' AND version=:'version';
SQL
)"
	if [ -n "$existing" ]; then
		[ "$existing" = "$checksum" ] || { echo "Applied migration checksum changed: $TREEAI_MIGRATION_PRODUCT/$version" >&2; exit 1; }
		continue
	fi
	# Every shipped migration is idempotent. Use the proven file execution path so
	# existing installations can adopt history even when their schema predates it.
	psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
	psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v product="$TREEAI_MIGRATION_PRODUCT" -v version="$version" -v checksum="$checksum" <<'SQL'
INSERT INTO treeai_schema_migrations(product,version,checksum)
VALUES(:'product',:'version',:'checksum')
ON CONFLICT(product,version) DO NOTHING;
SQL
done
