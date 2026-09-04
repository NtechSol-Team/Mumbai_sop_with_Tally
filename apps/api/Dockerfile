# Mumbai ERP API — Express + Prisma + Socket.IO + pg-boss in one process.
# Built from the monorepo root context: docker build -f apps/api/Dockerfile .
FROM node:20-alpine

# Prisma probes the `openssl` binary to pick its engine. Alpine ships libssl.so.3
# but not that binary, so detection silently falls back to an openssl-1.1.x engine
# that then cannot load at runtime ("Could not parse schema engine response").
RUN apk add --no-cache openssl

WORKDIR /repo

# Install with the lockfile first so dependency layers cache across code changes.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --include=dev --workspace @mumbai-erp/api --include-workspace-root

COPY apps/api apps/api
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma \
    && npm run api:build

# server.js resolves uploads/ and assets/ relative to apps/api (see env.ts).
WORKDIR /repo/apps/api
EXPOSE 4000

# Migrations run at container start — the database is only reachable at runtime.
CMD npx prisma migrate deploy --schema=prisma/schema.prisma && node dist/server.js
