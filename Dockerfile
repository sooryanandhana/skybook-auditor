# syntax=docker/dockerfile:1
#
# Skybook AI Website Auditor — production image for a single, always-on Node
# process (Render, Railway, or any Docker host). It bundles the Next.js
# standalone server together with a system Chromium for Puppeteer's PDF step.
#
# The in-memory job store means ONE instance: do not scale this to more than a
# single replica, and do not let the platform sleep it mid-audit.

# ---- deps: install dependencies against the lockfile ----------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Puppeteer must NOT download its own Chromium; the runner installs the distro
# build and points PUPPETEER_EXECUTABLE_PATH at it.
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: compile the standalone server -------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runner: system Chromium + the standalone output ----------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Next's standalone server reads these; Render provides PORT (defaults shown).
ENV HOSTNAME=0.0.0.0
ENV PORT=10000
# Use the distro Chromium rather than a Puppeteer download.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Chromium and the fonts/certs it expects. --no-install-recommends keeps the
# layer small; the apt lists are removed so they do not ship in the image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     chromium \
     ca-certificates \
     fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

# The traced standalone bundle, then the two things it does not include:
# the compiled static assets and the public directory.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# The database migration tooling, so container startup (`npm run migrate`) can
# bring the schema up to date before the server starts. The `pg` driver is
# already present — the app's own database code pulls it into the traced
# standalone bundle above. The real package.json is copied so `npm run migrate`
# finds the script; node resolves modules from node_modules, so its richer
# dependency list changes nothing at runtime.
COPY --from=builder /app/lib/db ./lib/db
COPY --from=builder /app/package.json ./package.json

# Run unprivileged. Chromium starts with --no-sandbox (set in render.ts), which
# is what lets a non-root, container Chromium launch at all.
USER node

EXPOSE 10000
# Migrate, THEN serve. Render's free plan has no pre-deploy hook, so the
# container itself brings the schema up to date on startup. `&&` is the whole
# safety property: if `npm run migrate` exits non-zero the server never starts
# and the container exits non-zero (Render keeps the previous version serving
# rather than running against a database without its `users` table). `exec`
# hands the process over to node so it becomes PID 1 and receives stop signals.
# Migrations are idempotent — already-applied ones are skipped — so restarting
# a free service that has gone to sleep re-runs this safely.
CMD ["sh", "-c", "npm run migrate && exec node server.js"]
