FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package*.json ./
RUN npm ci

# Copy source after deps are installed.
COPY . .

ENV NODE_ENV=production
EXPOSE 3456

# Starts the Express + WS server.
# Requires convex/_generated to be present in the image (committed in git).
CMD ["npm", "run", "start"]
