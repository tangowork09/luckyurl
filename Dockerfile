# LeadScout — runs directly with tsx (no build step / no emitted JS).
FROM node:22-slim

WORKDIR /app

# Puppeteer (src/maps-live.ts, the live-verify feature) needs a real Chromium
# binary. node:22-slim's Debian base has none of Chromium's shared-library
# runtime deps (libnss3 etc.) — puppeteer's own bundled-Chromium download
# fails to even launch without them. Installing the distro's `chromium`
# package pulls its full, correctly-matched dependency graph automatically,
# so we skip puppeteer's bundled download entirely and point it at this one.
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install deps first for better layer caching. Include devDependencies — the
# app runs via tsx (a devDependency); there is no compiled output.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# App source.
COPY . .

# Persistent data lives here — mount volumes at runtime (see README "Going live"):
#   /app/data   auth + billing JSON stores (users/plans/subscriptions/orders)
#   /app/leads  per-user generated lead files + CRM stores
# Set NODE_ENV after install so npm ci above still installs devDependencies.
ENV NODE_ENV=production
ENV PORT=4600
EXPOSE 4600

CMD ["npm", "start"]
