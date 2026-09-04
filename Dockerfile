FROM node:20-bookworm-slim AS deps
WORKDIR /app
ARG PRISMA_GENERATE_DATABASE_URL=postgresql://ftr:ftr@localhost:5432/ftr_fix_bot
COPY package*.json ./
COPY prisma ./prisma
RUN DATABASE_URL=$PRISMA_GENERATE_DATABASE_URL npm ci --omit=dev \
  && DATABASE_URL=$PRISMA_GENERATE_DATABASE_URL npm run db:generate

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/data/images
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "scripts/start.js"]
