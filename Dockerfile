FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package*.json ./
RUN npm ci

# Copy source after deps are installed.
COPY . .

ENV NODE_ENV=production
ENV BOOP_AUTO_CONVEX_SETUP=true
EXPOSE 3456

# Starts the Express + WS server.
# preflight auto-generates convex/_generated when BOOP_AUTO_CONVEX_SETUP=true.
CMD ["npm", "run", "start"]
