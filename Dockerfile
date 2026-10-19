# syntax=docker/dockerfile:1
# Multi-stage build for the monorepo. Targets: api, web, test.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# ---- dependencies (cached unless a manifest or the lockfile changes)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ---- source + build
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter @sil/shared build \
 && pnpm --filter @sil/api build \
 && pnpm --filter @sil/web exec vite build

# ---- test runner (docker compose --profile test run --rm test)
FROM build AS test
ENV NODE_ENV=test
CMD ["pnpm", "test"]

# ---- API runtime
FROM base AS api
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

# ---- web runtime (static files + reverse proxy to the API)
FROM nginx:1.27-alpine AS web
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
