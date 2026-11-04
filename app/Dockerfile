# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src/schema.sql ./dist/schema.sql
COPY seed ./seed
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node dist/seed.js && node dist/server.js"]
