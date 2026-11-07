# syntax=docker/dockerfile:1

FROM oven/bun:1.3.9-alpine AS deps
WORKDIR /app
COPY package.json bun.lock turbo.json ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile

FROM deps AS app
COPY . .
ENV NODE_ENV=production

FROM app AS api
EXPOSE 3001
CMD ["bun", "apps/api/src/index.ts"]

FROM app AS worker
CMD ["bun", "apps/worker/src/index.ts"]

FROM app AS web-build
WORKDIR /app/apps/web
RUN bun run build

FROM nginx:alpine AS web
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
