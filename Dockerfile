FROM node:20-alpine
WORKDIR /app

# Install OpenSSL - required by Prisma
RUN apk add --no-cache openssl

# Install all deps (need devDeps for tsx)
COPY package*.json ./
RUN npm install
RUN npm install -g tsx

# Copy source
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts

# Generate Prisma client
RUN npx prisma generate

EXPOSE 4000

# Run TypeScript directly with tsx - no compilation needed
CMD ["npx", "tsx", "src/index.ts"]
