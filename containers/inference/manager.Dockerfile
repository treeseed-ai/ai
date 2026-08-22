FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
LABEL org.opencontainers.image.base.name="node:24.19.0-bookworm-slim" org.opencontainers.image.base.digest="sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03"
WORKDIR /app
RUN npm install --global npm@12.0.2 && npm cache clean --force && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm --filter @ai-platform/common build && pnpm --filter @ai-platform/inference-manager build
USER node
CMD ["node","packages/inference-manager/dist/main.js","worker"]
