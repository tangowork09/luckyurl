# LeadScout — runs directly with tsx (no build step / no emitted JS).
FROM node:22-slim

WORKDIR /app

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
