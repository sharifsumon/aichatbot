# One Dockerfile for every service; pick one with --target (api, worker, web, admin, tools).

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# Install every workspace dependency once, then build everything.
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm -r build
# Self-contained folders with only production dependencies for the Node services.
RUN pnpm --filter @agently/api deploy --prod --legacy /out/api \
 && pnpm --filter @agently/worker deploy --prod --legacy /out/worker

# Migrations and seeds: `docker compose run --rm migrate`.
FROM build AS tools
CMD ["pnpm", "db:migrate"]

FROM node:22-alpine AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/api .
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]

FROM node:22-alpine AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/worker .
USER node
CMD ["node", "dist/index.js"]

FROM node:22-alpine AS web
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone .
COPY --from=build /repo/apps/web/.next/static apps/web/.next/static
COPY --from=build /repo/apps/web/public apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM node:22-alpine AS admin
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=build /repo/apps/admin/.next/standalone .
COPY --from=build /repo/apps/admin/.next/static apps/admin/.next/static
COPY --from=build /repo/apps/admin/public apps/admin/public
USER node
EXPOSE 3001
CMD ["node", "apps/admin/server.js"]
