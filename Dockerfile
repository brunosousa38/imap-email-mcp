# Stage build: install only production dependencies to keep the final image lean
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Stage runner: minimal image with no build tooling
FROM node:22-alpine AS runner
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY index.js package.json ./

# Drop privileges: the built-in "node" user (uid 1000) prevents container breakout escalation
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "index.js"]
