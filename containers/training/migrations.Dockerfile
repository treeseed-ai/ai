FROM alpine:3.23.5@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40
LABEL org.opencontainers.image.base.name="alpine:3.23.5" org.opencontainers.image.base.digest="sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40"
RUN apk add --no-cache postgresql17-client=17.11-r0
COPY migrations/training /migrations
COPY containers/migrations/run.sh /usr/local/bin/treeai-run-migrations
RUN chmod 0555 /usr/local/bin/treeai-run-migrations
ENV TREEAI_MIGRATION_PRODUCT=training
ENTRYPOINT ["/usr/local/bin/treeai-run-migrations"]
