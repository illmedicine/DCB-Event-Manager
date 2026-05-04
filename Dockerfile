# Railway build for the DisCryptoBank web frontend.
#
# Railway clones the parent repo (illmedicine/DCB-Event-Manager) but does NOT
# pull git submodules, so the actual web source at
# discord-crypto-task-payroll-bot/web/ is not available on the build context.
# This Dockerfile clones the submodule explicitly during build, runs the Vite
# build, then serves the static dist/ via `serve` on Railway's $PORT.

ARG BOT_REPO=https://github.com/illmedicine/discord-crypto-task-payroll-bot.git
ARG BOT_REF=main

# ---------- Stage 1: build the React/Vite bundle ----------
FROM node:20-alpine AS builder
ARG BOT_REPO
ARG BOT_REF
RUN apk add --no-cache git
WORKDIR /src
RUN git clone --depth 1 --branch ${BOT_REF} ${BOT_REPO} bot
WORKDIR /src/bot/web
RUN npm ci --no-audit --no-fund
RUN npm run build

# ---------- Stage 2: tiny static server ----------
FROM node:20-alpine AS runner
WORKDIR /app
RUN npm install -g serve@14
COPY --from=builder /src/bot/web/dist /app/dist
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "serve -s dist -l ${PORT:-8080}"]
