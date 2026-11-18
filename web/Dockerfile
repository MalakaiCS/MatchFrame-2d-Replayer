# Matchframe2D web service (public). Build from the repository root:  docker build -f web/Dockerfile .
FROM node:22-slim AS deps
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/web/node_modules web/node_modules
COPY web web
COPY db db
WORKDIR /app/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx next build

FROM node:22-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app/web
COPY --from=build /app/web/.next/standalone ./
COPY --from=build /app/web/.next/static ./.next/static
COPY --from=build /app/web/public ./public
COPY --from=build /app/web/scripts ./scripts
COPY --from=build /app/web/node_modules/pg ./node_modules/pg
COPY --from=build /app/db /app/db
USER node
EXPOSE 3000
# Migrations run before the server starts (idempotent, advisory-locked).
CMD ["sh", "-c", "MIGRATIONS_DIR=/app/db/migrations node scripts/migrate.mjs && node server.js"]
