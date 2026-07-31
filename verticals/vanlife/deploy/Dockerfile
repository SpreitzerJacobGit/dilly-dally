# GENERATED FROM assembly.manifest.yaml — DO NOT EDIT
# Build context: repository root.
FROM node:22-slim AS build
RUN npm install -g pnpm@11
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @vanlife/web build
RUN pnpm --filter @vanlife/server build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
# The single native dependency; everything else is bundled.
RUN npm init -y >/dev/null && npm install --omit=dev @libsql/client@0.17.4
COPY --from=build /repo/verticals/vanlife/app/server/dist/ ./
COPY --from=build /repo/verticals/vanlife/app/web/dist/ ./public/
COPY --from=build /repo/verticals/vanlife/db/migrations/ ./migrations/
ENV PORT=18081
ENV DB_FILE=/data/vanlife.db
ENV STATIC_DIR=/app/public
ENV MIGRATIONS_DIR=/app/migrations
EXPOSE 18081
CMD ["node", "main.js"]
