# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build stage
FROM node:26-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY app/package.json app/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
COPY app ./app
RUN npm run build -w @outpost/app

# -------------------------------------------------------------- runtime stage
FROM nginx:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/app/dist /usr/share/nginx/html

EXPOSE 8080
