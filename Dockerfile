# openclaw-backend/Dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY prisma ./prisma
COPY src    ./src
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy production deps + build output
COPY --from=deps    /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/prisma       ./prisma
COPY package.json ./

# Generate prisma client in runner
RUN npm install @prisma/client --no-save 2>/dev/null || true
RUN npx prisma generate

EXPOSE 4000
CMD ["node", "dist/index.js"]
