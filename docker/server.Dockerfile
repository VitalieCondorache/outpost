# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build stage
FROM node:24-alpine AS build
WORKDIR /repo

# Manifests first: the dependency layer is cached until they change.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY app/package.json app/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
COPY server ./server
RUN npm run build -w @outpost/server

# -------------------------------------------------------------- runtime stage
FROM node:24-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production \
    PORT=8787 \
    OUTPOST_DB=/data/outpost.db

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/server/package.json ./server/package.json
COPY --from=build /repo/server/dist ./server/dist

# SQLite lives on a volume so `docker compose down` (without -v) keeps the data.
VOLUME ["/data"]
EXPOSE 8787

# No native modules: `node:sqlite` ships with the runtime.
CMD ["node", "server/dist/index.js"]
