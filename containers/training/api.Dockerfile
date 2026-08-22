FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99
LABEL org.opencontainers.image.base.name="node:24.12.0-bookworm-slim" org.opencontainers.image.base.digest="sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99"
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm --filter @ai-platform/common build && pnpm --filter @ai-platform/training-api build
USER node
CMD ["node","packages/training-api/dist/main.js"]
