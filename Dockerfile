FROM node:20-alpine AS base
# tzdata: real IANA timezone database, so the container's system clock is
# genuinely Asia/Riyadh instead of relying on hardcoded date-math offsets.
# libc6-compat/openssl: required by Prisma's query engine on Alpine 3.18+.
RUN apk add --no-cache tzdata libc6-compat openssl
ENV TZ=Asia/Riyadh
RUN cp /usr/share/zoneinfo/$TZ /etc/localtime && echo "$TZ" > /etc/timezone

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate

# Build the NestJS app
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nestjs

COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules

USER nestjs

EXPOSE 3210
ENV PORT=3210

CMD ["node", "dist/main.js"]
