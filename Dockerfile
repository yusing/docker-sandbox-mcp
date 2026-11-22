FROM node:26-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:26-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV FASTMCP_STATE_DIR=/var/lib/fastmcp

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force \
    && mkdir -p /var/lib/fastmcp \
    && chown -R node:node /var/lib/fastmcp

COPY --from=builder /app/dist ./dist

USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
