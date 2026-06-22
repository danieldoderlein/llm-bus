# Multi-stage build for the hosted (Cloud Run) deploy. The same image runs on the VM topology too;
# bind address and DB connection are selected by env (RUN_PLATFORM / CLOUD_SQL_INSTANCE). No port is
# hardcoded - Cloud Run injects $PORT and config.ts reads it.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY db ./db
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Run as the non-root user that the node image ships with.
USER node
CMD ["node", "dist/src/server.js"]
