# syntax=docker/dockerfile:1
#
# Finance bot application image (for a VPS / any Docker host). Build and run it through docker-compose.yml
# with the "app" profile: `docker compose --profile app up -d --build`. See docs/operations/vps-deploy.md.
#
# - Debian (glibc) slim image: sharp ships a prebuilt binary for it and Prisma finds OpenSSL 3.
# - Install scripts are skipped at `npm ci` (tesseract.js and scarf must not run theirs); Prisma is
#   generated explicitly, sharp needs no install script.
# - The Prisma CLI is a devDependency, so it is added back after pruning: the same image runs
#   `prisma migrate deploy` (the "migrate" service) and the bot (the "app" service).
# - Runs as the unprivileged "node" user. No secret is baked in: .dockerignore keeps .env* out.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV SCARF_ANALYTICS=false
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --ignore-scripts
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build
# Production dependencies only, then the exact Prisma CLI version from the lockfile (with its engines).
RUN PRISMA_VERSION="$(node -p "require('./node_modules/prisma/package.json').version")" \
    && npm prune --omit=dev --ignore-scripts \
    && npm install --no-save --omit=dev --no-audit --no-fund "prisma@${PRISMA_VERSION}" \
    && npx prisma generate

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --chown=node:node package.json ./
COPY --chown=node:node scripts/fetch-tessdata.mjs ./scripts/fetch-tessdata.mjs
# OCR language data lives on a volume (data/tessdata); the directory must belong to "node" so a new volume inherits it.
RUN mkdir -p /app/data/tessdata && chown -R node:node /app/data
USER node
CMD ["node", "dist/main.js"]
