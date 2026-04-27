FROM node:20-bookworm-slim

# git: required for cloning user repos (gotcha §10)
# python3/make/g++: required for better-sqlite3 native addon compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
