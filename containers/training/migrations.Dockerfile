FROM alpine:3.23.5@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40
LABEL org.opencontainers.image.base.name="alpine:3.23.5" org.opencontainers.image.base.digest="sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40"
RUN apk add --no-cache postgresql17-client=17.11-r0
COPY migrations/training /migrations
ENTRYPOINT ["sh","-c","psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f /migrations/001_initial.sql"]
