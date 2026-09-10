FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
COPY containers/migrations/run.ts ./containers/migrations/run.ts
RUN pnpm exec esbuild containers/migrations/run.ts --bundle --platform=node --format=esm --external:pg-native --outfile=/out/run.mjs --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
LABEL org.opencontainers.image.base.name="node:24.19.0-bookworm-slim" org.opencontainers.image.base.digest="sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03"
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /out/run.mjs /usr/local/lib/treeai-run-migrations.mjs
COPY migrations/inference /migrations
ENV TREEAI_MIGRATION_PRODUCT=inference
USER 1000:1000
ENTRYPOINT ["node", "/usr/local/lib/treeai-run-migrations.mjs"]
