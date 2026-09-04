# Mumbai ERP Web — Next.js 14 frontend.
# Built from the monorepo root context: docker build -f apps/web/Dockerfile .
FROM node:20-alpine

WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --include=dev --workspace @mumbai-erp/web --include-workspace-root

COPY apps/web apps/web

# Next.js inlines NEXT_PUBLIC_* at build time — the public origin must be known here.
# With the Caddy reverse proxy this is simply the site's own origin
# (e.g. http://<droplet-ip> or https://erp.example.com).
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run web:build

WORKDIR /repo/apps/web
EXPOSE 3000
# The port is pinned here rather than reused from package.json's "start": that
# script carries a local-dev port (3100), and inheriting it silently broke the
# Caddy upstream (web:3000) once dev moved ports. Production owns its own port.
CMD ["npx", "next", "start", "-p", "3000"]
