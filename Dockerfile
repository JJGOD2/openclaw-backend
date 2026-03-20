FROM node:20-slim
WORKDIR /app

# Install OpenSSL - required by Prisma on Debian-based images
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Install dependencies including tsx
COPY package*.json ./
RUN npm install && npm install -g tsx

# Copy source files
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts

# Generate Prisma client
RUN npx prisma generate

EXPOSE 4000

CMD ["tsx", "src/index.ts"]
