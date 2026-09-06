FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma/
RUN npm ci
COPY tools/mcp/package.json tools/mcp/package-lock.json ./tools/mcp/
RUN npm ci --prefix tools/mcp --ignore-scripts --no-audit --no-fund

FROM node:20-alpine AS dev
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/tools/mcp/node_modules ./tools/mcp/node_modules
COPY . .
EXPOSE 3001
CMD ["npm", "run", "dev"]

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/tools/mcp/node_modules ./tools/mcp/node_modules
COPY . .
RUN npm run build

# Runner: production deps only (smaller image, no devDependencies copy).
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev && npx prisma generate
COPY --from=build /app/dist ./dist
COPY --from=deps /app/tools/mcp/node_modules ./tools/mcp/node_modules
COPY tools/mcp/package.json ./tools/mcp/package.json
COPY tools/mcp/src ./tools/mcp/src
EXPOSE 3001
CMD ["node", "dist/main.js"]
