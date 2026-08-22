FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
LABEL org.opencontainers.image.base.name="node:24.19.0-bookworm-slim" org.opencontainers.image.base.digest="sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03"
ARG LAB_ENTRY=controller
ENV LAB_ENTRY=${LAB_ENTRY}
WORKDIR /app
RUN corepack enable && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm --filter @ai-platform/common build && pnpm --filter @ai-platform/lab build
RUN mkdir /state && chown node:node /state
USER node
CMD ["sh","-c","node packages/lab/dist/${LAB_ENTRY}.js"]
