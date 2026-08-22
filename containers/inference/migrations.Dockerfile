FROM postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94
LABEL org.opencontainers.image.base.name="postgres:17.6-alpine" org.opencontainers.image.base.digest="sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"
COPY migrations/inference /migrations
ENTRYPOINT ["sh","-c","psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f /migrations/001_initial.sql"]
